import type { Pool } from "pg";
import { migrate } from "./migrate.js";
import { seed } from "./seed.js";

/**
 * Ensures the database is ready: if the schema is missing or the orders table
 * is empty, apply the schema and seed demo data. On a database that already
 * has data this is a no-op, so restarts do not wipe an in-progress demo.
 */
export async function bootstrap(pool: Pool): Promise<void> {
  let needsSetup = false;
  try {
    const res = await pool.query("SELECT COUNT(*) AS c FROM orders");
    if (Number(res.rows[0].c) === 0) needsSetup = true;
  } catch {
    needsSetup = true; // table does not exist yet
  }
  if (needsSetup) {
    await migrate(pool);
    await seed(pool);
  }
}
