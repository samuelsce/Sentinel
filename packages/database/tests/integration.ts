import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createDatabase } from "../src/index.js";
import { applyMigrations } from "../src/migrations.js";

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("/sentinel_test")) {
  throw new Error(
    "TEST_DATABASE_URL must target the dedicated sentinel_test database.",
  );
}
await applyMigrations(url);
await applyMigrations(url);
const { pool } = createDatabase(url);
const client = await pool.connect();
const orgA = randomUUID();
const orgB = randomUUID();
const projectA = randomUUID();
const projectB = randomUUID();
const keyA = randomUUID();
const eventId = randomUUID();
const payload = JSON.parse(
  readFileSync(
    new URL("../../contracts/fixtures/events.v1.json", import.meta.url),
    "utf8",
  ),
).base;
payload.event_id = eventId;

async function mustReject(
  sql: string,
  values: unknown[],
  expectedCode: string,
) {
  await client.query("SAVEPOINT expected_failure");
  let errorCode: string | undefined;
  try {
    await client.query(sql, values);
  } catch (error) {
    errorCode = (error as { code?: string }).code;
  }
  await client.query("ROLLBACK TO SAVEPOINT expected_failure");
  await client.query("RELEASE SAVEPOINT expected_failure");
  assert.equal(
    errorCode,
    expectedCode,
    "Database must reject an invalid relation or duplicate",
  );
}

try {
  await client.query("BEGIN");
  await client.query(
    "INSERT INTO organizations(id,name) VALUES ($1,'Test A'),($2,'Test B')",
    [orgA, orgB],
  );
  await client.query(
    "INSERT INTO projects(id,organization_id,name) VALUES ($1,$2,'App A'),($3,$4,'App B')",
    [projectA, orgA, projectB, orgB],
  );
  const insertKey =
    "INSERT INTO ingestion_keys(id,organization_id,project_id,environment,prefix,key_hash) VALUES ($1,$2,$3,'demo','test',$4)";
  await mustReject(
    insertKey,
    [randomUUID(), orgB, projectA, randomUUID()],
    "23503",
  );
  await client.query(insertKey, [keyA, orgA, projectA, randomUUID()]);
  const insertEvent =
    "INSERT INTO events(organization_id,project_id,event_id,ingestion_key_id,environment,type,occurred_at,payload) VALUES ($1,$2,$3,$4,$5,'auth.login_failed',now(),$6::jsonb)";
  const eventValues = [
    orgA,
    projectA,
    eventId,
    keyA,
    "demo",
    JSON.stringify(payload),
  ];
  await client.query(insertEvent, eventValues);
  await mustReject(insertEvent, eventValues, "23505");
  await mustReject(
    insertEvent,
    [orgA, projectA, randomUUID(), keyA, "production", JSON.stringify(payload)],
    "23503",
  );
  await mustReject(
    insertEvent,
    [orgB, projectB, randomUUID(), keyA, "demo", JSON.stringify(payload)],
    "23503",
  );
  const insertJob =
    "INSERT INTO detection_jobs(organization_id,project_id,event_id) VALUES ($1,$2,$3)";
  await client.query(insertJob, [orgA, projectA, eventId]);
  await mustReject(insertJob, [orgA, projectA, eventId], "23505");
  await mustReject(insertJob, [orgB, projectB, eventId], "23503");
  await mustReject(
    "UPDATE detection_jobs SET attempts=-1 WHERE event_id=$1",
    [eventId],
    "23514",
  );
  await mustReject(
    "UPDATE detection_jobs SET status='processing' WHERE event_id=$1",
    [eventId],
    "23514",
  );
  const privileges = await client.query(
    "SELECT has_table_privilege('sentinel_detector','events','SELECT') AS events, has_table_privilege('sentinel_detector','users','SELECT') AS users, has_table_privilege('sentinel_detector','events','UPDATE') AS mutate_events",
  );
  assert.deepEqual(privileges.rows[0], {
    events: true,
    users: false,
    mutate_events: false,
  });
  const roles = await client.query(
    "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN ('sentinel_api','sentinel_detector')",
  );
  assert.equal(roles.rowCount, 2);
  for (const role of roles.rows) {
    assert.equal(role.rolsuper, false);
    assert.equal(role.rolbypassrls, false);
  }
  console.log(
    "Database integration passed: migrations twice, tenant/key/environment relations, uniqueness, job checks and restricted roles.",
  );
} finally {
  await client.query("ROLLBACK");
  client.release();
  await pool.end();
}
