import type { PoolClient } from "pg";
import type { Queryable } from "./pool.js";
import type { ConditionCode, ConditionResult } from "../domain/refund.js";

const ACTION = "carrier_exception_refund";

export interface OrderFacts {
  status: string;
  placedAt: string;
  capturedAmountCents: number;
  priorRefundedCents: number;
  providerChargeId: string;
  customerRiskScore: number;
  carrierExceptionVerified: boolean;
}

/**
 * Locks the order row for the duration of the transaction. Any other
 * transaction that tries to lock the same order waits until this one finishes,
 * which serializes refunds per order and makes the cumulative-ceiling check
 * race-free. Returns false if the order does not exist.
 */
export async function lockOrderRow(client: PoolClient, orderId: string): Promise<boolean> {
  const res = await client.query("SELECT 1 FROM orders WHERE id = $1 FOR UPDATE", [orderId]);
  return res.rowCount === 1;
}

/** Loads the facts the policy engine needs. Returns null if the order is unknown. */
export async function getOrderFacts(q: Queryable, orderId: string): Promise<OrderFacts | null> {
  const res = await q.query(
    `SELECT
       o.status                                                   AS status,
       o.placed_at                                                AS placed_at,
       c.risk_score                                               AS risk_score,
       (SELECT COALESCE(SUM(amount_captured_cents), 0)
          FROM payments WHERE order_id = o.id AND status = 'captured') AS captured_cents,
       (SELECT COALESCE(SUM(amount_cents), 0)
          FROM refunds WHERE order_id = o.id AND status = 'succeeded')  AS refunded_cents,
       (SELECT provider_charge_id
          FROM payments WHERE order_id = o.id LIMIT 1)                  AS provider_charge_id,
       EXISTS(SELECT 1 FROM carrier_exceptions
               WHERE order_id = o.id AND verified = true)               AS exc_verified
     FROM orders o
     JOIN customers c ON c.id = o.customer_id
     WHERE o.id = $1`,
    [orderId],
  );
  const row = res.rows[0];
  if (!row || row.provider_charge_id === null) return null;
  return {
    status: row.status,
    placedAt: row.placed_at.toISOString(),
    capturedAmountCents: Number(row.captured_cents),
    priorRefundedCents: Number(row.refunded_cents),
    providerChargeId: row.provider_charge_id,
    customerRiskScore: row.risk_score,
    carrierExceptionVerified: row.exc_verified,
  };
}

/** Condition 6: a succeeded refund already exists for this exact identity. */
export async function exactRefundExists(q: Queryable, orderId: string, amountCents: number): Promise<boolean> {
  const res = await q.query(
    `SELECT EXISTS(
       SELECT 1 FROM refunds
       WHERE order_id = $1 AND action = $2 AND amount_cents = $3 AND status = 'succeeded'
     ) AS ex`,
    [orderId, ACTION, amountCents],
  );
  return res.rows[0].ex === true;
}

export interface OperationRow {
  id: string;
  order_id: string;
  amount_cents: string;
  refund_id: string | null;
  escalation_id: string | null;
  reasons: ConditionResult[];
}

export async function getOperationByKey(q: Queryable, idempotencyKey: string): Promise<OperationRow | null> {
  const res = await q.query("SELECT * FROM refund_operations WHERE idempotency_key = $1", [idempotencyKey]);
  return (res.rows[0] as OperationRow) ?? null;
}

/** The open escalation for an episode identity, if any (used to dedupe). */
export async function getOpenEscalation(q: Queryable, orderId: string, amountCents: number) {
  const res = await q.query(
    `SELECT * FROM escalations
     WHERE order_id = $1 AND action = $2 AND requested_amount_cents = $3 AND status = 'open'`,
    [orderId, ACTION, amountCents],
  );
  return res.rows[0] ?? null;
}

export async function getRefundById(q: Queryable, id: string) {
  const res = await q.query("SELECT * FROM refunds WHERE id = $1", [id]);
  return res.rows[0] ?? null;
}

export async function getEscalationById(q: Queryable, id: string) {
  const res = await q.query("SELECT * FROM escalations WHERE id = $1", [id]);
  return res.rows[0] ?? null;
}

export async function insertRefund(
  client: PoolClient,
  r: { orderId: string; amountCents: number; reason: string; providerRefundId: string },
): Promise<string> {
  const res = await client.query(
    `INSERT INTO refunds (order_id, action, amount_cents, reason, provider_refund_id, status)
     VALUES ($1, $2, $3, $4, $5, 'succeeded') RETURNING id`,
    [r.orderId, ACTION, r.amountCents, r.reason, r.providerRefundId],
  );
  return res.rows[0].id;
}

export async function insertEscalation(
  client: PoolClient,
  e: { orderId: string; requestedAmountCents: number; reasonCodes: ConditionCode[] },
): Promise<string> {
  const res = await client.query(
    `INSERT INTO escalations (order_id, action, requested_amount_cents, reason_codes)
     VALUES ($1, $2, $3, $4::jsonb) RETURNING id`,
    [e.orderId, ACTION, e.requestedAmountCents, JSON.stringify(e.reasonCodes)],
  );
  return res.rows[0].id;
}

export async function insertOperation(
  client: PoolClient,
  o: {
    orderId: string;
    amountCents: number;
    idempotencyKey: string;
    refundId: string | null;
    escalationId: string | null;
    reasons: ConditionResult[];
  },
): Promise<string> {
  const res = await client.query(
    `INSERT INTO refund_operations
       (order_id, action, amount_cents, idempotency_key, refund_id, escalation_id, reasons)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) RETURNING id`,
    [o.orderId, ACTION, o.amountCents, o.idempotencyKey, o.refundId, o.escalationId, JSON.stringify(o.reasons)],
  );
  return res.rows[0].id;
}

export async function updateOrderStatus(client: PoolClient, orderId: string, status: string): Promise<void> {
  await client.query("UPDATE orders SET status = $2 WHERE id = $1", [orderId, status]);
}

export async function listOpenEscalations(q: Queryable, limit = 50) {
  const res = await q.query(
    "SELECT * FROM escalations WHERE status = 'open' ORDER BY created_at DESC LIMIT $1",
    [limit],
  );
  return res.rows;
}

/** PostgreSQL unique-violation error code. */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code: unknown }).code === "23505";
}
