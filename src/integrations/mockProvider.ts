import { randomUUID } from "node:crypto";

/**
 * A synthetic payment provider that mimics the part of a real provider (e.g.
 * Stripe) that matters most for correctness: idempotent refunds.
 *
 * Real refund APIs accept an idempotency key and guarantee that repeating a
 * request with the same key returns the ORIGINAL result instead of charging
 * again. We model exactly that. This is what makes it safe for our service to
 * retry a refund without moving money twice.
 *
 * In production this state lives in the provider's systems; here it is an
 * in-memory map, which is sufficient for a single-process demo. The README
 * notes how a real provider swaps in without changing the calling code.
 */
export interface ProviderRefundRequest {
  chargeId: string;
  amountCents: number;
  idempotencyKey: string;
}

export interface ProviderRefundResult {
  providerRefundId: string;
  status: "succeeded";
  amountCents: number;
  /** True when this response replayed a prior request with the same key. */
  idempotentReplay: boolean;
}

export class MockPaymentProvider {
  private readonly byKey = new Map<string, ProviderRefundResult>();

  refund(req: ProviderRefundRequest): ProviderRefundResult {
    const prior = this.byKey.get(req.idempotencyKey);
    if (prior) {
      return { ...prior, idempotentReplay: true };
    }
    const result: ProviderRefundResult = {
      providerRefundId: `re_mock_${randomUUID().slice(0, 12)}`,
      status: "succeeded",
      amountCents: req.amountCents,
      idempotentReplay: false,
    };
    this.byKey.set(req.idempotencyKey, result);
    return result;
  }
}

/** Shared singleton used by the running server. Tests create their own. */
export const paymentProvider = new MockPaymentProvider();
