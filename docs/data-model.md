# PostgreSQL Data Model — Carrier-Exception Refund Resolution (rev. 2)

Scope: the single approved workflow — resolving a verified-carrier-exception
refund for an order, either by auto-executing a bounded refund or by creating a
manager-approval escalation. All data is synthetic. Money is stored as integer
cents (`BIGINT`), never floating point.

Revision 2 incorporates five review points: escalation-episode dedup, an
authoritative captured amount, exactly-one-outcome enforcement, cumulative
refund state behind `partially_refunded`, and an enforced cumulative refund
ceiling.

---

## 1. Entities

### `customers`
| column | type | notes |
|---|---|---|
| id | text PK | e.g. `CUST-1` |
| name | text NOT NULL | |
| email | text NOT NULL | |
| risk_score | int NOT NULL | 0–100, `CHECK (risk_score BETWEEN 0 AND 100)` |

### `orders`
| column | type | notes |
|---|---|---|
| id | text PK | e.g. `ORD-1001` |
| customer_id | text NOT NULL → customers(id) | |
| status | order_status NOT NULL | see Statuses |
| currency | text NOT NULL DEFAULT 'USD' | |
| placed_at | timestamptz NOT NULL | drives order-age condition |

### `payments`
| column | type | notes |
|---|---|---|
| id | text PK | |
| order_id | text NOT NULL → orders(id) | an order may have several rows |
| amount_captured_cents | bigint NOT NULL CHECK >= 0 | |
| status | payment_status NOT NULL | `captured` \| `refunded` |
| provider | text NOT NULL DEFAULT 'mock' | |
| provider_charge_id | text NOT NULL | used to issue provider refunds |
| captured_at | timestamptz NOT NULL | |

**Authoritative captured amount** (rev. 2): for an order it is
`SUM(amount_captured_cents) WHERE status = 'captured'`. This single definition is
used by condition 2 and by the cumulative ceiling. It is read inside the refund
transaction with row locking (see §4).

### `carrier_exceptions`
| column | type | notes |
|---|---|---|
| id | text PK | |
| order_id | text NOT NULL → orders(id) | |
| type | carrier_exception_type NOT NULL | `lost` \| `damaged` \| `delayed` |
| verified | boolean NOT NULL | condition 5 requires TRUE |
| reported_at | timestamptz NOT NULL | |

### `refunds` — executed money movements
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| order_id | text NOT NULL → orders(id) | |
| action | refund_action NOT NULL | `carrier_exception_refund` |
| amount_cents | bigint NOT NULL CHECK > 0 | |
| reason | text NOT NULL | |
| provider_refund_id | text NOT NULL | from the payment provider |
| status | refund_status NOT NULL | `succeeded` \| `failed` |
| created_at | timestamptz NOT NULL DEFAULT now() | |

Constraint: **`UNIQUE (order_id, action, amount_cents)`** — the same-identity
duplicate guard, independent of any caller key. (Does not replace the cumulative
ceiling; see §5.)

Note: `refunds` has **no `operation_id` back-reference**. The operation-to-outcome
foreign key points in one direction only (operation → outcome), so there is no
cyclic foreign key. See §2 and §4.

### `escalations` — manager-approval queue
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| order_id | text NOT NULL → orders(id) | |
| action | refund_action NOT NULL | |
| requested_amount_cents | bigint NOT NULL | |
| reason_codes | jsonb NOT NULL | failed condition codes |
| status | escalation_status NOT NULL DEFAULT 'open' | `open` \| `approved` \| `rejected` |
| created_at | timestamptz NOT NULL DEFAULT now() | |

**Escalation-episode identity** (rev. 2): a pending episode is identified by
`(order_id, action, requested_amount_cents)` while unresolved. Enforced by a
partial unique index so different caller keys cannot open duplicate pending
escalations for the same ineligible action:

```sql
CREATE UNIQUE INDEX uniq_open_escalation
  ON escalations (order_id, action, requested_amount_cents)
  WHERE status = 'open';
```

Once an episode is `approved`/`rejected`, a later episode for the same identity
may open again. Like `refunds`, `escalations` has **no `operation_id`
back-reference** (single FK direction; see §2).

### `refund_operations` — decision ledger, one outcome each
Records the decision and its reasons, and binds to exactly one outcome.

| column | type | notes |
|---|---|---|
| id | uuid PK | |
| order_id | text NOT NULL → orders(id) | |
| action | refund_action NOT NULL | |
| amount_cents | bigint NOT NULL | requested amount |
| idempotency_key | text NOT NULL | caller-supplied |
| refund_id | uuid NULL UNIQUE → refunds(id) | set when refunded |
| escalation_id | uuid NULL UNIQUE → escalations(id) | set when escalated |
| reasons | jsonb NOT NULL | all six conditions with pass/fail + detail |
| created_at | timestamptz NOT NULL DEFAULT now() | |

Constraints (rev. 2):
- `UNIQUE (idempotency_key)` — caller-key idempotency (secondary layer).
- **`CHECK ((refund_id IS NOT NULL) <> (escalation_id IS NOT NULL))`** — exactly
  one outcome. A refund and an escalation cannot both attach, and an operation
  cannot commit without an outcome.

**Foreign-key direction (rev. 3):** the only operation-to-outcome foreign keys
are `refund_id` and `escalation_id` here on `refund_operations`. The outcome
tables do not reference back, so the graph is acyclic and needs no deferred
constraints. Insert order within the transaction is always outcome first, then
operation (see §4).

---

## 2. Relationships

```
customers 1---* orders 1---* payments
                     1---* carrier_exceptions
                     1---* refund_operations --1 refunds       (refund_id)
                                            \--1 escalations   (escalation_id)
```

Each operation points to exactly one outcome via `refund_id` XOR `escalation_id`
(enforced by the CHECK above). Each outcome is referenced by at most one
operation (UNIQUE on those FKs). The foreign keys point one way only
(operation → outcome); the outcome rows hold no `operation_id`, so the graph is
acyclic and rows insert cleanly as outcome-then-operation with no deferred
constraints.

---

## 3. Idempotency & duplicate protection

- **Refund identity (primary).** `UNIQUE (order_id, action, amount_cents)` on
  `refunds`. A second refund of the same eligible action and amount is
  impossible, regardless of caller key.
- **Escalation episode.** Partial unique index (above): at most one *open*
  escalation per `(order, action, amount)`. A repeat request for an already-open
  episode returns that episode and creates no new records.
- **Caller key (secondary).** `UNIQUE (idempotency_key)` on `refund_operations`
  lets an identical retry return the original recorded outcome.

---

## 4. Atomicity & concurrency

A resolve runs as one transaction. The captured amount and prior refunds are
read under a row lock so two concurrent partial refunds cannot both pass the
ceiling check:

```
BEGIN;
  SELECT ... FROM orders WHERE id = $1 FOR UPDATE;      -- serialize per order
  captured   := SUM(captured payments for order);
  refunded   := SUM(succeeded refunds for order);
  -- policy engine evaluates the six conditions, including
  -- (refunded + requested) <= captured
  IF auto_refund:
     INSERT INTO refunds (...);                          -- UNIQUE(order,action,amount)
     INSERT INTO refund_operations (..., refund_id);     -- CHECK exactly-one-outcome
     UPDATE orders SET status = (refunded+requested = captured ? 'refunded' : 'partially_refunded');
  ELSE:
     INSERT INTO escalations (...);                       -- partial-unique open episode
     INSERT INTO refund_operations (..., escalation_id);
COMMIT;
```

Any constraint violation rolls the whole transaction back (no partial record);
the service then reads and returns the existing outcome or open episode.

---

## 5. Invariants

1. Money is integer cents; `refunds.amount_cents > 0`, `payments.amount_captured_cents >= 0`.
2. `customers.risk_score ∈ [0, 100]`.
3. At most one refund per `(order_id, action, amount_cents)` — key-independent.
4. At most one *open* escalation per `(order_id, action, amount)` episode.
5. At most one operation per `idempotency_key`.
6. Exactly one outcome (refund XOR escalation) per operation; no operation
   commits without an outcome.
7. **Cumulative ceiling (rev. 2):** within the transaction,
   `sum(prior succeeded refunds) + requested <= captured amount`. The
   `(order, action, amount)` uniqueness rule does not replace this; both apply.
8. `orders.status = partially_refunded` only when persisted cumulative refunds
   are `> 0` and `< captured`; `refunded` when they equal captured.
9. A refund is created only when all six conditions pass; otherwise an
   escalation is created and no money moves.
10. The decision, outcome, and reasons are always recorded.

---

## 6. Out of scope

- Escalation approval workflow (approve/reject) — out of scope.
- Provider-failure reconciliation — out of scope.

The cumulative refund ceiling (invariant 7) is **in scope** and implemented.
