import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { Pool } from "pg";
import { makePool } from "../src/db/pool.js";
import { migrate } from "../src/db/migrate.js";
import { seed } from "../src/db/seed.js";
import { MockPaymentProvider } from "../src/integrations/mockProvider.js";
import { resolveRefund, getRefundContext } from "../src/services/refundService.js";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgresql://localhost:5432/commerce_ops_test";

let pool: Pool;
let provider: MockPaymentProvider;

beforeAll(async () => {
  pool = makePool(TEST_URL);
  await migrate(pool);
});

beforeEach(async () => {
  await seed(pool);
  provider = new MockPaymentProvider();
});

afterAll(async () => {
  await pool.end();
});

async function refundCount(orderId: string): Promise<number> {
  const r = await pool.query("SELECT COUNT(*) AS c FROM refunds WHERE order_id = $1 AND status = 'succeeded'", [orderId]);
  return Number(r.rows[0].c);
}
async function refundedTotal(orderId: string): Promise<number> {
  const r = await pool.query("SELECT COALESCE(SUM(amount_cents),0) AS s FROM refunds WHERE order_id = $1 AND status='succeeded'", [orderId]);
  return Number(r.rows[0].s);
}

describe("resolveRefund - happy path", () => {
  it("executes a refund when all conditions pass and marks the order refunded", async () => {
    const r = await resolveRefund(pool, provider, { orderId: "ORD-1001", amountCents: 8000, reason: "Lost", idempotencyKey: "k1" });
    expect(r.status).toBe("refunded");
    if (r.status === "refunded") expect(r.orderStatus).toBe("refunded");
    expect(await refundCount("ORD-1001")).toBe(1);
  });
});

describe("resolveRefund - idempotency", () => {
  it("refunds only ONCE when retried with the same key", async () => {
    const input = { orderId: "ORD-1001", amountCents: 8000, reason: "Lost", idempotencyKey: "same" };
    const first = await resolveRefund(pool, provider, input);
    const second = await resolveRefund(pool, provider, input);
    expect(first.status).toBe("refunded");
    expect(second.status).toBe("refunded");
    if (first.status === "refunded" && second.status === "refunded") {
      expect(second.replayed).toBe(true);
      expect(second.refundId).toBe(first.refundId);
    }
    expect(await refundCount("ORD-1001")).toBe(1);
  });

  it("blocks a duplicate refund of the same identity under a DIFFERENT key", async () => {
    await resolveRefund(pool, provider, { orderId: "ORD-1001", amountCents: 8000, reason: "Lost", idempotencyKey: "ka" });
    const second = await resolveRefund(pool, provider, { orderId: "ORD-1001", amountCents: 8000, reason: "Lost again", idempotencyKey: "kb" });
    expect(second.status).toBe("escalated");
    if (second.status === "escalated") expect(second.failed).toContain("no_duplicate_refund");
    expect(await refundCount("ORD-1001")).toBe(1);
  });
});

describe("resolveRefund - cumulative ceiling", () => {
  it("escalates when prior + requested exceeds captured (ORD-1008: $50 + $40 > $80)", async () => {
    const r = await resolveRefund(pool, provider, { orderId: "ORD-1008", amountCents: 4000, reason: "second partial", idempotencyKey: "c1" });
    expect(r.status).toBe("escalated");
    if (r.status === "escalated") expect(r.failed).toContain("within_captured_ceiling");
    expect(await refundedTotal("ORD-1008")).toBe(5000); // unchanged
  });

  it("allows a partial refund that stays within the balance (ORD-1008: $50 + $30 = $80)", async () => {
    const r = await resolveRefund(pool, provider, { orderId: "ORD-1008", amountCents: 3000, reason: "final partial", idempotencyKey: "c2" });
    expect(r.status).toBe("refunded");
    if (r.status === "refunded") expect(r.orderStatus).toBe("refunded");
    expect(await refundedTotal("ORD-1008")).toBe(8000);
  });
});

describe("resolveRefund - escalation episode dedup", () => {
  it("does not create duplicate open escalations under different keys", async () => {
    const a = await resolveRefund(pool, provider, { orderId: "ORD-1003", amountCents: 6000, reason: "risky", idempotencyKey: "e-a" });
    const b = await resolveRefund(pool, provider, { orderId: "ORD-1003", amountCents: 6000, reason: "risky", idempotencyKey: "e-b-DIFFERENT" });
    expect(a.status).toBe("escalated");
    expect(b.status).toBe("escalated");
    if (a.status === "escalated" && b.status === "escalated") {
      expect(b.escalationId).toBe(a.escalationId);
      expect(b.replayed).toBe(true);
    }
    const c = await pool.query("SELECT COUNT(*) AS c FROM escalations WHERE order_id='ORD-1003'");
    expect(Number(c.rows[0].c)).toBe(1);
  });
});

describe("resolveRefund - concurrent requests with different keys (the ceiling race)", () => {
  it("never over-refunds when two partial refunds race (ORD-1001: $50 + $40, cap $80)", async () => {
    const [a, b] = await Promise.all([
      resolveRefund(pool, provider, { orderId: "ORD-1001", amountCents: 5000, reason: "A", idempotencyKey: "race-a" }),
      resolveRefund(pool, provider, { orderId: "ORD-1001", amountCents: 4000, reason: "B", idempotencyKey: "race-b" }),
    ]);
    const outcomes = [a.status, b.status].sort();
    // Exactly one refunds, the other escalates on the ceiling.
    expect(outcomes).toEqual(["escalated", "refunded"]);
    expect(await refundCount("ORD-1001")).toBe(1);
    expect(await refundedTotal("ORD-1001")).toBeLessThanOrEqual(8000);
  });
});

describe("resolveRefund - escalation reasons (one per condition)", () => {
  const cases = [
    { order: "ORD-1002", amountCents: 30000, failed: "amount_within_limit" },
    { order: "ORD-1006", amountCents: 10000, failed: "within_captured_ceiling" },
    { order: "ORD-1004", amountCents: 5000, failed: "order_within_age" },
    { order: "ORD-1003", amountCents: 6000, failed: "customer_risk_ok" },
    { order: "ORD-1005", amountCents: 9000, failed: "carrier_exception_verified" },
    { order: "ORD-1007", amountCents: 7000, failed: "no_duplicate_refund" },
  ];
  for (const c of cases) {
    it(`escalates ${c.order} on ${c.failed}`, async () => {
      const r = await resolveRefund(pool, provider, { orderId: c.order, amountCents: c.amountCents, reason: "x", idempotencyKey: `r-${c.order}` });
      expect(r.status).toBe("escalated");
      if (r.status === "escalated") expect(r.failed).toContain(c.failed);
    });
  }
});

describe("getRefundContext / not found", () => {
  it("previews without creating any refund", async () => {
    const ctx = await getRefundContext(pool, "ORD-1001");
    expect(ctx.found).toBe(true);
    if (ctx.found) expect(ctx.preview.outcome).toBe("auto_refund");
    expect(await refundCount("ORD-1001")).toBe(0);
  });

  it("returns order_not_found for an unknown order", async () => {
    const r = await resolveRefund(pool, provider, { orderId: "NOPE", amountCents: 100, reason: "x", idempotencyKey: "z" });
    expect(r.status).toBe("order_not_found");
  });
});
