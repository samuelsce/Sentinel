import { createDatabase } from "./index.js";

if (!process.env.DATABASE_URL)
  throw new Error("Private operator DATABASE_URL required");
const { pool } = createDatabase(process.env.DATABASE_URL);
try {
  const rows =
    await pool.query(`SELECT name AS relation,pg_total_relation_size(name::regclass)::text AS bytes
    FROM unnest(ARRAY['events','detection_jobs','alert_evidence','alerts','detection_episodes','audit_entries']) AS name`);
  console.log(
    JSON.stringify({
      measuredAt: new Date().toISOString(),
      relations: rows.rows,
    }),
  );
} catch {
  console.error("Storage measurement unavailable; connection details withheld");
  process.exitCode = 1;
} finally {
  await pool.end();
}
