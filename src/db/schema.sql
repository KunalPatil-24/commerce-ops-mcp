-- Commerce-Ops MCP schema (PostgreSQL). All money is integer cents.
--
-- Demo rebuild strategy: this file drops and recreates everything so it can be
-- re-applied deterministically during development. A production system would
-- use incremental, non-destructive migrations instead; that is out of scope
-- for this synthetic assignment.

DROP TABLE IF EXISTS refund_operations CASCADE;
DROP TABLE IF EXISTS refunds           CASCADE;
DROP TABLE IF EXISTS escalations        CASCADE;
DROP TABLE IF EXISTS carrier_exceptions CASCADE;
DROP TABLE IF EXISTS payments           CASCADE;
DROP TABLE IF EXISTS orders             CASCADE;
DROP TABLE IF EXISTS customers          CASCADE;

DROP TYPE IF EXISTS order_status           CASCADE;
DROP TYPE IF EXISTS payment_status         CASCADE;
DROP TYPE IF EXISTS carrier_exception_type CASCADE;
DROP TYPE IF EXISTS refund_action          CASCADE;
DROP TYPE IF EXISTS refund_status          CASCADE;
DROP TYPE IF EXISTS escalation_status      CASCADE;

-- Enums: constrain a column to a fixed set of values (a typed CHECK).
CREATE TYPE order_status           AS ENUM ('paid', 'partially_refunded', 'refunded', 'cancelled');
CREATE TYPE payment_status         AS ENUM ('captured', 'refunded');
CREATE TYPE carrier_exception_type AS ENUM ('lost', 'damaged', 'delayed');
CREATE TYPE refund_action          AS ENUM ('carrier_exception_refund');
CREATE TYPE refund_status          AS ENUM ('succeeded', 'failed');
CREATE TYPE escalation_status      AS ENUM ('open', 'approved', 'rejected');

-- customers -----------------------------------------------------------------
CREATE TABLE customers (
  id         text PRIMARY KEY,                       -- Lesson 1: primary key
  name       text NOT NULL,                          -- Lesson 1: NOT NULL
  email      text NOT NULL,
  risk_score int  NOT NULL CHECK (risk_score BETWEEN 0 AND 100)  -- Lesson 1: CHECK
);

-- orders --------------------------------------------------------------------
CREATE TABLE orders (
  id          text PRIMARY KEY,
  customer_id text NOT NULL REFERENCES customers(id),  -- Lesson 1: foreign key
  status      order_status NOT NULL DEFAULT 'paid',
  currency    text NOT NULL DEFAULT 'USD',
  placed_at   timestamptz NOT NULL
);

-- payments (an order may have several) --------------------------------------
CREATE TABLE payments (
  id                    text PRIMARY KEY,
  order_id              text NOT NULL REFERENCES orders(id),
  amount_captured_cents bigint NOT NULL CHECK (amount_captured_cents >= 0),
  status                payment_status NOT NULL DEFAULT 'captured',
  provider              text NOT NULL DEFAULT 'mock',
  provider_charge_id    text NOT NULL,
  captured_at           timestamptz NOT NULL
);

-- carrier_exceptions --------------------------------------------------------
CREATE TABLE carrier_exceptions (
  id          text PRIMARY KEY,
  order_id    text NOT NULL REFERENCES orders(id),
  type        carrier_exception_type NOT NULL,
  verified    boolean NOT NULL,
  reported_at timestamptz NOT NULL
);

-- refunds: executed money movements -----------------------------------------
CREATE TABLE refunds (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           text NOT NULL REFERENCES orders(id),
  action             refund_action NOT NULL DEFAULT 'carrier_exception_refund',
  amount_cents       bigint NOT NULL CHECK (amount_cents > 0),
  reason             text NOT NULL,
  provider_refund_id text NOT NULL,
  status             refund_status NOT NULL DEFAULT 'succeeded',
  created_at         timestamptz NOT NULL DEFAULT now(),

  -- Lesson 2: the primary duplicate guard. A second refund of the same
  -- (order, action, amount) is impossible, independent of any caller key.
  CONSTRAINT uniq_refund_identity UNIQUE (order_id, action, amount_cents)
);

-- escalations: manager-approval queue ---------------------------------------
CREATE TABLE escalations (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id               text NOT NULL REFERENCES orders(id),
  action                 refund_action NOT NULL DEFAULT 'carrier_exception_refund',
  requested_amount_cents bigint NOT NULL CHECK (requested_amount_cents > 0),
  reason_codes           jsonb NOT NULL,
  status                 escalation_status NOT NULL DEFAULT 'open',
  created_at             timestamptz NOT NULL DEFAULT now()
);

-- Lesson 2 (partial index): at most one OPEN escalation per identity. Once an
-- episode is approved/rejected it leaves the index, so a later one may open.
CREATE UNIQUE INDEX uniq_open_escalation
  ON escalations (order_id, action, requested_amount_cents)
  WHERE status = 'open';

-- refund_operations: decision ledger, exactly one outcome each --------------
CREATE TABLE refund_operations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        text NOT NULL REFERENCES orders(id),
  action          refund_action NOT NULL DEFAULT 'carrier_exception_refund',
  amount_cents    bigint NOT NULL CHECK (amount_cents > 0),
  idempotency_key text NOT NULL UNIQUE,               -- Lesson 2: caller-key idempotency

  -- One-way FKs (operation -> outcome). The outcome tables do NOT reference
  -- back, so the graph is acyclic and inserts outcome-first with no deferral.
  -- UNIQUE so a given outcome attaches to at most one operation.
  refund_id       uuid UNIQUE REFERENCES refunds(id),
  escalation_id   uuid UNIQUE REFERENCES escalations(id),

  reasons         jsonb NOT NULL,                     -- full six-condition decision
  created_at      timestamptz NOT NULL DEFAULT now(),

  -- Exactly one outcome: not both, not neither.
  CONSTRAINT exactly_one_outcome
    CHECK ((refund_id IS NOT NULL) <> (escalation_id IS NOT NULL))
);
