import { Pool, type PoolClient } from "pg";

/**
 * A queryable is anything with `.query()` — either the pool (each call grabs a
 * connection automatically) or a single checked-out client (used inside a
 * transaction so every statement runs on the same connection). Repo functions
 * accept this so they work both standalone and inside a transaction.
 */
export type Queryable = Pool | PoolClient;

const DEFAULT_URL = "postgresql://localhost:5432/commerce_ops";

/**
 * Creates a connection pool. Reads DATABASE_URL when present (that is what the
 * hosted deployment and the test setup provide); otherwise falls back to the
 * local dev database. With no user in the URL, pg uses the OS user.
 *
 * Cloud Postgres (Neon, Render, etc.) requires SSL; local Postgres does not.
 * We enable SSL when the URL asks for it (`sslmode=require`) or when
 * DATABASE_SSL=true is set. rejectUnauthorized is relaxed because managed
 * providers often present certs not in the local trust store.
 */
export function makePool(connectionString: string = process.env.DATABASE_URL ?? DEFAULT_URL): Pool {
  const useSsl = process.env.DATABASE_SSL === "true" || /[?&]sslmode=require/.test(connectionString);
  return new Pool({
    connectionString,
    ssl: useSsl ? { rejectUnauthorized: false } : undefined,
  });
}
