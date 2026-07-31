import { describe, it, expect } from "vitest";
import { evaluateRefund, POLICY, type RefundContext } from "../src/domain/refund.js";

/** A context where every condition passes. Tests override one field at a time. */
function passingContext(overrides: Partial<RefundContext> = {}): RefundContext {
  return {
    orderId: "ORD-TEST",
    requestedAmountCents: 8000,
    capturedAmountCents: 8000,
    priorRefundedCents: 0,
    orderAgeDays: 5,
    customerRiskScore: 15,
    carrierExceptionVerified: true,
    hasExistingRefund: false,
    ...overrides,
  };
}

describe("evaluateRefund", () => {
  it("auto-refunds when all six conditions pass", () => {
    const d = evaluateRefund(passingContext());
    expect(d.outcome).toBe("auto_refund");
    expect(d.failed).toEqual([]);
    expect(d.conditions).toHaveLength(6);
  });

  it("escalates when amount exceeds the $150 auto-approve limit", () => {
    const d = evaluateRefund(passingContext({ requestedAmountCents: 30000, capturedAmountCents: 30000 }));
    expect(d.outcome).toBe("escalate");
    expect(d.failed).toContain("amount_within_limit");
  });

  it("escalates when a single refund exceeds the captured amount", () => {
    const d = evaluateRefund(passingContext({ requestedAmountCents: 10000, capturedAmountCents: 4000 }));
    expect(d.outcome).toBe("escalate");
    expect(d.failed).toContain("within_captured_ceiling");
  });

  it("escalates when the order is older than 30 days", () => {
    const d = evaluateRefund(passingContext({ orderAgeDays: 45 }));
    expect(d.failed).toContain("order_within_age");
  });

  it("escalates when customer risk is 70 or above", () => {
    const d = evaluateRefund(passingContext({ customerRiskScore: 82 }));
    expect(d.failed).toContain("customer_risk_ok");
  });

  it("escalates when there is no verified carrier exception", () => {
    const d = evaluateRefund(passingContext({ carrierExceptionVerified: false }));
    expect(d.failed).toContain("carrier_exception_verified");
  });

  it("escalates when a refund already exists for the amount/action", () => {
    const d = evaluateRefund(passingContext({ hasExistingRefund: true }));
    expect(d.failed).toContain("no_duplicate_refund");
  });

  // --- Cumulative ceiling (condition 2, the new behavior) ------------------

  it("escalates when prior refunds plus the request exceed the captured amount", () => {
    // $50 already refunded on an $80 order; a new $40 pushes cumulative to $90.
    const d = evaluateRefund(passingContext({ capturedAmountCents: 8000, priorRefundedCents: 5000, requestedAmountCents: 4000 }));
    expect(d.outcome).toBe("escalate");
    expect(d.failed).toContain("within_captured_ceiling");
  });

  it("allows a partial refund that stays within the remaining balance", () => {
    // $50 refunded on $80; a new $30 lands exactly at the $80 ceiling.
    const d = evaluateRefund(passingContext({ capturedAmountCents: 8000, priorRefundedCents: 5000, requestedAmountCents: 3000 }));
    expect(d.outcome).toBe("auto_refund");
  });

  it("treats cumulative exactly at the captured amount as allowed (<=)", () => {
    const d = evaluateRefund(passingContext({ capturedAmountCents: 8000, priorRefundedCents: 3000, requestedAmountCents: 5000 }));
    expect(d.outcome).toBe("auto_refund");
  });

  // --- Boundary tests ------------------------------------------------------

  it("treats exactly $150 as within the limit (<=)", () => {
    const d = evaluateRefund(passingContext({ requestedAmountCents: POLICY.maxAutoRefundCents, capturedAmountCents: POLICY.maxAutoRefundCents }));
    expect(d.outcome).toBe("auto_refund");
  });

  it("treats $150.01 as over the limit", () => {
    const d = evaluateRefund(passingContext({ requestedAmountCents: POLICY.maxAutoRefundCents + 1, capturedAmountCents: 20000 }));
    expect(d.failed).toContain("amount_within_limit");
  });

  it("treats an order exactly 30 days old as within age (<=)", () => {
    const d = evaluateRefund(passingContext({ orderAgeDays: POLICY.maxOrderAgeDays }));
    expect(d.outcome).toBe("auto_refund");
  });

  it("treats risk of exactly 69 as ok and 70 as not ok (strictly below)", () => {
    expect(evaluateRefund(passingContext({ customerRiskScore: 69 })).outcome).toBe("auto_refund");
    expect(evaluateRefund(passingContext({ customerRiskScore: 70 })).failed).toContain("customer_risk_ok");
  });

  it("reports every failed condition when multiple fail at once", () => {
    const d = evaluateRefund(
      passingContext({ requestedAmountCents: 30000, capturedAmountCents: 30000, customerRiskScore: 90 }),
    );
    expect(d.failed).toEqual(expect.arrayContaining(["amount_within_limit", "customer_risk_ok"]));
  });
});
