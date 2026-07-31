import type { Pool } from "pg";
import * as repo from "../db/repo.js";
import { evaluateRefund, type RefundContext, type RefundDecision, type ConditionCode } from "../domain/refund.js";
import type { MockPaymentProvider } from "../integrations/mockProvider.js";

/** Whole days between an ISO timestamp and now. */
function ageDays(placedAtIso: string): number {
  return Math.floor((Date.now() - Date.parse(placedAtIso)) / (24 * 60 * 60 * 1000));
}

// ---------------------------------------------------------------------------
// Read: gather context and PREVIEW the decision. No lock, no writes.
// ---------------------------------------------------------------------------

export type ContextResult =
  | { found: false; orderId: string }
  | {
      found: true;
      orderId: string;
      requestedAmountCents: number;
      capturedAmountCents: number;
      priorRefundedCents: number;
      orderAgeDays: number;
      customerRiskScore: number;
      carrierExceptionVerified: boolean;
      hasExistingRefund: boolean;
      preview: RefundDecision;
    };

export async function getRefundContext(pool: Pool, orderId: string, requestedAmountCents?: number): Promise<ContextResult> {
  const facts = await repo.getOrderFacts(pool, orderId);
  if (!facts) return { found: false, orderId };

  const amount = requestedAmountCents ?? Math.max(facts.capturedAmountCents - facts.priorRefundedCents, 0);
  const hasExistingRefund = await repo.exactRefundExists(pool, orderId, amount);
  const ctx: RefundContext = {
    orderId,
    requestedAmountCents: amount,
    capturedAmountCents: facts.capturedAmountCents,
    priorRefundedCents: facts.priorRefundedCents,
    orderAgeDays: ageDays(facts.placedAt),
    customerRiskScore: facts.customerRiskScore,
    carrierExceptionVerified: facts.carrierExceptionVerified,
    hasExistingRefund,
  };
  return {
    found: true,
    orderId,
    requestedAmountCents: amount,
    capturedAmountCents: facts.capturedAmountCents,
    priorRefundedCents: facts.priorRefundedCents,
    orderAgeDays: ctx.orderAgeDays,
    customerRiskScore: facts.customerRiskScore,
    carrierExceptionVerified: facts.carrierExceptionVerified,
    hasExistingRefund,
    preview: evaluateRefund(ctx),
  };
}

// ---------------------------------------------------------------------------
// Write: resolve a refund inside one transaction.
// ---------------------------------------------------------------------------

export interface ResolveInput {
  orderId: string;
  amountCents: number;
  reason: string;
  idempotencyKey: string;
}

export type ResolveResult =
  | { status: "order_not_found"; orderId: string }
  | {
      status: "refunded";
      orderId: string;
      refundId: string;
      providerRefundId: string;
      amountCents: number;
      orderStatus: string;
      replayed: boolean;
      conditions: RefundDecision["conditions"];
    }
  | {
      status: "escalated";
      orderId: string;
      escalationId: string;
      requestedAmountCents: number;
      failed: ConditionCode[];
      conditions: RefundDecision["conditions"];
      replayed: boolean;
    };

export async function resolveRefund(pool: Pool, provider: MockPaymentProvider, input: ResolveInput): Promise<ResolveResult> {
  const { orderId, amountCents, reason, idempotencyKey } = input;

  // Layer 1: idempotent replay by caller key (outside the transaction).
  const priorOp = await repo.getOperationByKey(pool, idempotencyKey);
  if (priorOp) return replayFromOperation(pool, priorOp);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Lock the order row FIRST. This serializes all refunds on this order, so
    // the captured/refunded totals we read cannot change under us.
    const exists = await repo.lockOrderRow(client, orderId);
    if (!exists) {
      await client.query("ROLLBACK");
      return { status: "order_not_found", orderId };
    }

    const facts = (await repo.getOrderFacts(client, orderId))!; // exists, just checked
    const hasExistingRefund = await repo.exactRefundExists(client, orderId, amountCents);

    const decision = evaluateRefund({
      orderId,
      requestedAmountCents: amountCents,
      capturedAmountCents: facts.capturedAmountCents,
      priorRefundedCents: facts.priorRefundedCents,
      orderAgeDays: ageDays(facts.placedAt),
      customerRiskScore: facts.customerRiskScore,
      carrierExceptionVerified: facts.carrierExceptionVerified,
      hasExistingRefund,
    });

    if (decision.outcome === "auto_refund") {
      // Provider is idempotent by key; the refunds UNIQUE constraint is the
      // backstop (unreachable for the same order while we hold the lock).
      const providerRes = provider.refund({ chargeId: facts.providerChargeId, amountCents, idempotencyKey });
      const refundId = await repo.insertRefund(client, { orderId, amountCents, reason, providerRefundId: providerRes.providerRefundId });
      await repo.insertOperation(client, { orderId, amountCents, idempotencyKey, refundId, escalationId: null, reasons: decision.conditions });

      const newTotal = facts.priorRefundedCents + amountCents;
      const orderStatus = newTotal >= facts.capturedAmountCents ? "refunded" : "partially_refunded";
      await repo.updateOrderStatus(client, orderId, orderStatus);

      await client.query("COMMIT");
      return { status: "refunded", orderId, refundId, providerRefundId: providerRes.providerRefundId, amountCents, orderStatus, replayed: false, conditions: decision.conditions };
    }

    // Escalate. Dedupe by open-episode identity: if one is already open for
    // this (order, action, amount), return it and create no new records.
    const open = await repo.getOpenEscalation(client, orderId, amountCents);
    if (open) {
      await client.query("ROLLBACK");
      return { status: "escalated", orderId, escalationId: open.id, requestedAmountCents: amountCents, failed: decision.failed, conditions: decision.conditions, replayed: true };
    }

    const escalationId = await repo.insertEscalation(client, { orderId, requestedAmountCents: amountCents, reasonCodes: decision.failed });
    await repo.insertOperation(client, { orderId, amountCents, idempotencyKey, refundId: null, escalationId, reasons: decision.conditions });
    await client.query("COMMIT");
    return { status: "escalated", orderId, escalationId, requestedAmountCents: amountCents, failed: decision.failed, conditions: decision.conditions, replayed: false };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function replayFromOperation(pool: Pool, op: repo.OperationRow): Promise<ResolveResult> {
  if (op.refund_id) {
    const refund = await repo.getRefundById(pool, op.refund_id);
    return {
      status: "refunded",
      orderId: op.order_id,
      refundId: op.refund_id,
      providerRefundId: refund?.provider_refund_id ?? "",
      amountCents: Number(op.amount_cents),
      orderStatus: "",
      replayed: true,
      conditions: op.reasons,
    };
  }
  const esc = await repo.getEscalationById(pool, op.escalation_id!);
  return {
    status: "escalated",
    orderId: op.order_id,
    escalationId: op.escalation_id!,
    requestedAmountCents: Number(op.amount_cents),
    failed: (esc?.reason_codes ?? []) as ConditionCode[],
    conditions: op.reasons,
    replayed: true,
  };
}
