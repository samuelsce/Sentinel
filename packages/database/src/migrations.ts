import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDatabase } from "./index.js";

export async function applyMigrations(connectionString: string) {
  const { pool, db } = createDatabase(connectionString);
  try {
    await migrate(db, {
      migrationsFolder: fileURLToPath(
        new URL("../migrations", import.meta.url),
      ),
    });
    // Roles are provisioned by the local Postgres initializer. Generic databases
    // without these roles can still run migrations (for example CI service DBs).
    const roles = await pool.query<{ rolname: string }>(
      "select rolname from pg_roles where rolname in ('sentinel_api', 'sentinel_detector')",
    );
    if (roles.rows.some((row) => row.rolname === "sentinel_api")) {
      await pool.query(
        "GRANT USAGE ON SCHEMA public TO sentinel_api; GRANT SELECT, INSERT, UPDATE ON users, organizations, memberships, projects, ingestion_keys, events, detection_jobs, sessions, login_buckets TO sentinel_api; GRANT DELETE ON login_buckets TO sentinel_api; GRANT SELECT, INSERT ON audit_entries TO sentinel_api",
      );
    }
    if (roles.rows.some((row) => row.rolname === "sentinel_detector")) {
      await pool.query(
        "GRANT USAGE ON SCHEMA public TO sentinel_detector; GRANT SELECT ON events, detection_jobs TO sentinel_detector; GRANT UPDATE ON detection_jobs TO sentinel_detector",
      );
    }
  } finally {
    await pool.end();
  }
}
