import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Pool } from "pg";
import { makePool } from "./pool.js";

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(here, "schema.sql");

/**
 * Applies schema.sql. The file drops and recreates all objects, so this is
 * safe to run repeatedly in development. pg runs the whole multi-statement
 * file in a single call.
 */
export async function migrate(pool: Pool): Promise<void> {
  const sql = readFileSync(SCHEMA_PATH, "utf8");
  await pool.query(sql);
}

async function main(): Promise<void> {
  const pool = makePool();
  await migrate(pool);
  console.log("Schema applied.");
  await pool.end();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
