import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export function createDatabase(connectionString: string) {
  const pool = new pg.Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 2_000,
    statement_timeout: 3_000,
  });
  // Background pool errors must not become uncaught exceptions or leak credentials.
  pool.on("error", () => {
    /* Individual operations report failures to their caller. */
  });
  return { pool, db: drizzle(pool, { schema }) };
}
export * from "./schema.js";
