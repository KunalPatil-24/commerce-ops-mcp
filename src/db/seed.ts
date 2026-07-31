import type { Pool } from "pg";
import { makePool } from "./pool.js";

/** ISO timestamp for N days before now. */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

interface Scenario {
  order: string;
  customer: string;
  name: string;
  risk: number;
  placedDaysAgo: number;
  paidCents: number;
  exception: { type: string; verified: boolean } | null;
  status: string;
  /** A prior succeeded refund already on this order, in cents. */
  seededRefundCents?: number;
}

/**
 * One order per policy condition, plus a cumulative-ceiling case:
 *
 *   ORD-1001  happy path            -> all pass                    -> AUTO-REFUND
 *   ORD-1002  amount > $150         -> condition 1                 -> ESCALATE
 *   ORD-1003  risk 82               -> condition 4                 -> ESCALATE
 *   ORD-1004  45 days old           -> condition 3                 -> ESCALATE
 *   ORD-1005  exception unverified  -> condition 5                 -> ESCALATE
 *   ORD-1006  request > paid        -> condition 2 (cumulative)    -> ESCALATE
 *   ORD-1007  already fully refunded-> condition 6 (duplicate)     -> ESCALATE
 *   ORD-1008  $50 of $80 refunded   -> condition 2 (cumulative)    -> ESCALATE
 *             a new $40 request: $50 + $40 = $90 > $80 captured
 */
const scenarios: Scenario[] = [
  { order: "ORD-1001", customer: "CUST-1", name: "Aria Shah",    risk: 15, placedDaysAgo: 5,  paidCents: 8000,  exception: { type: "lost",    verified: true  }, status: "paid" },
  { order: "ORD-1002", customer: "CUST-2", name: "Ben Ortiz",    risk: 20, placedDaysAgo: 3,  paidCents: 30000, exception: { type: "damaged", verified: true  }, status: "paid" },
  { order: "ORD-1003", customer: "CUST-3", name: "Cara Lin",     risk: 82, placedDaysAgo: 4,  paidCents: 6000,  exception: { type: "lost",    verified: true  }, status: "paid" },
  { order: "ORD-1004", customer: "CUST-4", name: "Dev Nair",     risk: 10, placedDaysAgo: 45, paidCents: 5000,  exception: { type: "delayed", verified: true  }, status: "paid" },
  { order: "ORD-1005", customer: "CUST-5", name: "Elena Petrov", risk: 12, placedDaysAgo: 2,  paidCents: 9000,  exception: { type: "lost",    verified: false }, status: "paid" },
  { order: "ORD-1006", customer: "CUST-6", name: "Farid Khan",   risk: 25, placedDaysAgo: 6,  paidCents: 4000,  exception: { type: "damaged", verified: true  }, status: "paid" },
  { order: "ORD-1007", customer: "CUST-7", name: "Grace Obi",    risk: 18, placedDaysAgo: 7,  paidCents: 7000,  exception: { type: "lost",    verified: true  }, status: "refunded",          seededRefundCents: 7000 },
  { order: "ORD-1008", customer: "CUST-8", name: "Hana Ito",     risk: 15, placedDaysAgo: 8,  paidCents: 8000,  exception: { type: "lost",    verified: true  }, status: "partially_refunded", seededRefundCents: 5000 },
];

/**
 * Wipes and reseeds all synthetic data. TRUNCATE ... CASCADE clears every table
 * in one shot (and resets dependents), so seeding is deterministic.
 */
export async function seed(pool: Pool): Promise<void> {
  await pool.query(
    "TRUNCATE refund_operations, refunds, escalations, carrier_exceptions, payments, orders, customers CASCADE",
  );

  for (const s of scenarios) {
    await pool.query(
      "INSERT INTO customers (id, name, email, risk_score) VALUES ($1, $2, $3, $4)",
      [s.customer, s.name, `${s.customer.toLowerCase()}@example.com`, s.risk],
    );
    await pool.query(
      "INSERT INTO orders (id, customer_id, status, placed_at) VALUES ($1, $2, $3, $4)",
      [s.order, s.customer, s.status, daysAgo(s.placedDaysAgo)],
    );
    await pool.query(
      `INSERT INTO payments (id, order_id, amount_captured_cents, provider_charge_id, captured_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [`PAY-${s.order.slice(4)}`, s.order, s.paidCents, `ch_mock_${s.order.slice(4)}`, daysAgo(s.placedDaysAgo)],
    );
    if (s.exception) {
      await pool.query(
        "INSERT INTO carrier_exceptions (id, order_id, type, verified, reported_at) VALUES ($1, $2, $3, $4, $5)",
        [`EXC-${s.order.slice(4)}`, s.order, s.exception.type, s.exception.verified, daysAgo(Math.max(0, s.placedDaysAgo - 1))],
      );
    }
    if (s.seededRefundCents) {
      await pool.query(
        `INSERT INTO refunds (order_id, amount_cents, reason, provider_refund_id, status)
         VALUES ($1, $2, $3, $4, 'succeeded')`,
        [s.order, s.seededRefundCents, "Prior carrier-exception refund (seeded)", `re_seed_${s.order.slice(4)}`],
      );
    }
  }
}

async function main(): Promise<void> {
  const pool = makePool();
  await seed(pool);
  const counts = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM customers) AS customers,
       (SELECT COUNT(*) FROM orders)    AS orders,
       (SELECT COUNT(*) FROM refunds)   AS refunds`,
  );
  console.log("Seeded:", counts.rows[0]);
  await pool.end();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
