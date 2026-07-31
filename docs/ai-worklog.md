# AI Worklog

> Draft for Kunal to review and put in his own voice. Verify every claim below
> matches your actual experience before submitting, especially the model-usage
> and division-of-labor sections.

## Tools and models

- **Claude Code** was my
  primary AI tool for planning, implementation, debugging, testing, and drafting
  written communication.
- I chose Opus 4.8 as the single model because the work was reasoning-heavy
  rather than boilerplate: designing a safe money-handling data model, reasoning
  about concurrency and idempotency, and translating an evolving client spec
  into bounded changes. A more capable model reduced back-and-forth on exactly
  the parts where a subtle mistake would matter (refunds, locking, constraints).
- I did not split work across multiple models; the task did not have a
  high-volume, low-stakes portion where a cheaper model would have helped.

## How I used AI to plan and break the work down

- I started by having the AI decode what the assignment was really testing, then
  we produced 2–3 concrete workflow options with their MCP tools and safety
  stories, and I chose the one I could scope tightly: verified-carrier-exception
  refunds.
- We planned the build as ordered "bricks" (schema → seed → policy engine →
  repository → transactional service → MCP tools → tests → deploy), and I had
  the AI implement and explain them one at a time so I could follow and verify
  each before moving on.

## Division of responsibilities

- **I owned:** all client communication (every email to Deepak), the product and
  scope decisions, the choice of workflow, the hosting decisions, and the final
  say on each design tradeoff. I also decided to slow down and learn the database
  fundamentals so I could explain the work rather than just ship it.
- **The AI did:** most of the code generation, and acted as a pair-programmer
  and tutor, explaining each concept (foreign keys, UNIQUE constraints,
  transactions, row locking) as it appeared in the code.

## Important context and instructions I supplied

- The bounded scope and the exact refund policy (six conditions and thresholds)
  as negotiated with the client.
- The client's design-review feedback across several rounds: anchor idempotency
  on the refund's business identity rather than the caller key; make the decision
  and outcome durable and atomic in PostgreSQL; dedupe pending escalations by a
  stable episode identity; enforce a cumulative refund ceiling; and enforce
  exactly one outcome per operation.
- A standing instruction on written style for client emails (concise, decisive,
  and not obviously AI-authored).

## AI suggestions I corrected, rejected, or changed

- **Idempotency design.** The AI's first design anchored duplicate protection on
  the caller-supplied idempotency key. After the client review I had it
  re-anchored on the refund's business identity `(order, action, amount)` with a
  database `UNIQUE` constraint, so a different key cannot produce a second
  refund. The caller key became a secondary layer.
- **Foreign-key direction.** An intermediate schema had foreign keys pointing
  both ways between the operation and its outcome, which would create a cyclic
  foreign key that cannot be inserted. I had this changed to a single direction
  (operation → outcome), with outcome-first insertion inside the transaction.

- **Hosting.** I initially leaned toward a more complex host to put on my resume;
  after weighing it against the time box I chose the simpler, reliable option so
  I spent my time on the MCP and safety design, which is what the assignment
  grades.

## How I verified AI-generated work

- **Automated tests:** 30 tests (unit tests for the pure policy engine including
  boundary values, and PostgreSQL integration tests) covering the behavior that
  matters — idempotency, the duplicate-identity guard, the cumulative ceiling,
  the concurrent different-key ceiling race, and escalation-episode dedup.
- **Manual end-to-end checks:** I drove the real MCP tools over HTTP (locally and
  against the deployed server) and confirmed each scenario, and I inspected the
  database directly with `psql` to confirm constraints and state.
- **Reading and understanding:** I had each concept explained as it was written
  and can explain the schema, the transaction, and the idempotency layers myself.

## Remaining risks and unfinished work

- Refund `status = 'failed'` and provider-timeout reconciliation are modeled in
  the schema but not exercised, because the payment provider is a mock; wiring a
  real provider would use the same tool contracts.
- The escalation approval workflow (approve/reject) is intentionally out of
  scope.
- The free hosting tier sleeps when idle, so the first request after a pause is
  slow; this is a demo constraint, not a design limit.
