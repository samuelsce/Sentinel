import { readFile } from "node:fs/promises";
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
    const definitions = JSON.parse(
      await readFile(
        new URL(
          "../../contracts/rules/security-rules.v1.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { code: string; version: number }[];
    for (const definition of definitions) {
      await pool.query(
        "INSERT INTO rule_definitions(code,version,definition) VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING",
        [definition.code, definition.version, JSON.stringify(definition)],
      );
      const stored = await pool.query<{ matches: boolean }>(
        "SELECT definition=$3::jsonb AS matches FROM rule_definitions WHERE code=$1 AND version=$2",
        [definition.code, definition.version, JSON.stringify(definition)],
      );
      if (!stored.rows[0]?.matches)
        throw new Error(
          "Immutable rule definition changed without a version migration",
        );
    }
    // Roles are provisioned by the local Postgres initializer. Generic databases
    // without these roles can still run migrations (for example CI service DBs).
    const roles = await pool.query<{ rolname: string }>(
      "select rolname from pg_roles where rolname in ('sentinel_api', 'sentinel_detector')",
    );
    if (roles.rows.some((row) => row.rolname === "sentinel_api")) {
      await pool.query(
        "GRANT USAGE ON SCHEMA public TO sentinel_api; GRANT SELECT, INSERT, UPDATE ON users, organizations, memberships, projects, ingestion_keys, events, detection_jobs, sessions, login_buckets, ingestion_quotas, ingestion_totals TO sentinel_api; GRANT DELETE ON login_buckets TO sentinel_api; GRANT SELECT, INSERT ON audit_entries TO sentinel_api",
      );
      await pool.query(
        "GRANT SELECT ON rule_definitions, detection_episodes, alerts, alert_evidence TO sentinel_api; GRANT UPDATE(status,status_version,updated_at) ON alerts TO sentinel_api",
      );
      await pool.query(
        "GRANT USAGE,SELECT ON SEQUENCE events_ingest_order_seq TO sentinel_api",
      );
      await pool.query(
        "REVOKE UPDATE ON events,detection_jobs FROM sentinel_api",
      );
    }
    if (roles.rows.some((row) => row.rolname === "sentinel_detector")) {
      await pool.query(
        "GRANT USAGE ON SCHEMA public TO sentinel_detector; GRANT SELECT ON events, detection_jobs TO sentinel_detector; GRANT UPDATE ON detection_jobs TO sentinel_detector",
      );
      await pool.query(
        "GRANT SELECT ON rule_definitions TO sentinel_detector; GRANT SELECT,INSERT,UPDATE ON detection_episodes TO sentinel_detector; GRANT SELECT,INSERT ON alerts,alert_evidence TO sentinel_detector; GRANT UPDATE(last_decision,peak_count,evidence_truncated,updated_at) ON alerts TO sentinel_detector",
      );
    }
  } finally {
    await pool.end();
  }
}
