/**
 * Refund policy engine.
 *
 * A PURE function: facts in, decision out. No database, no network, no clock.
 * All time/DB lookups happen in the caller and are passed in as plain values.
 * This keeps the safety-critical decision logic trivially testable and
 * impossible to accidentally couple to a side effect (like actually paying).
 *
 * Policy (from the client). A refund may auto-execute ONLY when ALL hold;
 * otherwise the request is escalated for manager approval:
 *   1. amount is at most $150
 *   2. amount is at most the amount actually paid
 *   3. order is at most 30 days old
 *   4. customer risk score is below 70
 *   5. a carrier exception is verified
 *   6. no existing refund already covers the same eligible amount/action
 */

import { centsToUsd as formatUsd } from "./money.js";

export const POLICY = {
  /** Condition 1: max amount eligible for automatic refund, in cents ($150). */
  maxAutoRefundCents: 15_000,
  /** Condition 3: max order age in days. */
  maxOrderAgeDays: 30,
  /** Condition 4: customer risk must be strictly below this (0-100 scale). */
  riskScoreCeilingExclusive: 70,
} as const;

export type ConditionCode =
  | "amount_within_limit"
  | "within_captured_ceiling"
  | "order_within_age"
  | "customer_risk_ok"
  | "carrier_exception_verified"
  | "no_duplicate_refund";

/** The facts the engine needs. Gathered by the caller from the database. */
export interface RefundContext {
  orderId: string;
  requestedAmountCents: number;
  /** Authoritative captured amount: SUM of captured payments for the order. */
  capturedAmountCents: number;
  /** SUM of prior succeeded refunds for the order (read under lock). */
  priorRefundedCents: number;
  orderAgeDays: number;
  customerRiskScore: number;
  carrierExceptionVerified: boolean;
  /** True if a prior refund already covers this exact eligible amount/action. */
  hasExistingRefund: boolean;
}

export interface ConditionResult {
  code: ConditionCode;
  passed: boolean;
  detail: string;
}

export type RefundDecision =
  | { outcome: "auto_refund"; conditions: ConditionResult[]; failed: [] }
  | { outcome: "escalate"; conditions: ConditionResult[]; failed: ConditionCode[] };

/**
 * Evaluates the six-condition refund policy.
 *
 * Returns EVERY condition with its pass/fail and a human-readable reason, so
 * the caller (and ultimately the AI) can explain the decision, not just state
 * it. The `failed` array is the subset that blocked an automatic refund.
 */
export function evaluateRefund(ctx: RefundContext): RefundDecision {
  const conditions: ConditionResult[] = [
    {
      code: "amount_within_limit",
      passed: ctx.requestedAmountCents <= POLICY.maxAutoRefundCents,
      detail: `Requested ${formatUsd(ctx.requestedAmountCents)} vs ${formatUsd(
        POLICY.maxAutoRefundCents,
      )} auto-approve limit.`,
    },
    {
      // Condition 2, strengthened to the cumulative ceiling: prior refunds plus
      // this request must not exceed the captured amount. (When prior = 0 this
      // reduces to the original "amount <= paid".)
      code: "within_captured_ceiling",
      passed: ctx.priorRefundedCents + ctx.requestedAmountCents <= ctx.capturedAmountCents,
      detail: `Prior refunds ${formatUsd(ctx.priorRefundedCents)} + requested ${formatUsd(
        ctx.requestedAmountCents,
      )} = ${formatUsd(ctx.priorRefundedCents + ctx.requestedAmountCents)} vs ${formatUsd(
        ctx.capturedAmountCents,
      )} captured.`,
    },
    {
      code: "order_within_age",
      passed: ctx.orderAgeDays <= POLICY.maxOrderAgeDays,
      detail: `Order is ${ctx.orderAgeDays} day(s) old vs ${POLICY.maxOrderAgeDays}-day limit.`,
    },
    {
      code: "customer_risk_ok",
      passed: ctx.customerRiskScore < POLICY.riskScoreCeilingExclusive,
      detail: `Customer risk ${ctx.customerRiskScore} vs ceiling ${POLICY.riskScoreCeilingExclusive} (must be below).`,
    },
    {
      code: "carrier_exception_verified",
      passed: ctx.carrierExceptionVerified,
      detail: ctx.carrierExceptionVerified
        ? "A carrier exception is verified for this order."
        : "No verified carrier exception on this order.",
    },
    {
      code: "no_duplicate_refund",
      passed: !ctx.hasExistingRefund,
      detail: ctx.hasExistingRefund
        ? "A refund already covers this eligible amount/action."
        : "No prior refund covers this amount/action.",
    },
  ];

  const failed = conditions.filter((c) => !c.passed).map((c) => c.code);

  return failed.length === 0
    ? { outcome: "auto_refund", conditions, failed: [] }
    : { outcome: "escalate", conditions, failed };
}
