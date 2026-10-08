import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { createDatabase } from "@sentinel/database";
import { SentinelClient } from "@sentinel/sdk";
import { applyMigrations } from "../../../packages/database/src/migrations.js";
import { buildDemo } from "../../demo/src/app.js";
import { runScenario } from "../../demo/src/scenario.js";
import { buildApp } from "../src/app.js";
import { readConfig } from "../src/config.js";
import { IdentityService, provisionMember } from "../src/identity.js";
import { randomToken, secretHash } from "../src/security.js";

const url = process.env.TEST_DATABASE_URL;
if (
  !url ||
  new URL(url).pathname !== "/sentinel_test" ||
  !process.env.SENTINEL_API_DB_PASSWORD ||
  !process.env.SENTINEL_DETECTOR_DB_PASSWORD
)
  throw new Error(
    "Detection integration requires isolated sentinel_test and runtime roles",
  );
await applyMigrations(url);
await applyMigrations(url);
const owner = createDatabase(url);
const apiUrl = new URL(url);
apiUrl.username = "sentinel_api";
apiUrl.password = process.env.SENTINEL_API_DB_PASSWORD;
const detectorUrl = new URL(url);
detectorUrl.username = "sentinel_detector";
detectorUrl.password = process.env.SENTINEL_DETECTOR_DB_PASSWORD;
const runtime = createDatabase(apiUrl.href);
const identity = new IdentityService(runtime.pool);
const config = readConfig({
  API_DATABASE_URL: apiUrl.href,
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
});
const app = await buildApp(config, { isReady: async () => true, identity });
const python = resolve(
  "services/detector/.venv",
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
);
const runPython = async (args: string[]) => {
  const result = await promisify(execFile)(python, args, {
    cwd: resolve("services/detector"),
    env: {
      ...process.env,
      TEST_DATABASE_URL: url,
      DETECTOR_DATABASE_URL: detectorUrl.href,
    },
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
  process.stdout.write(result.stdout);
};
const orgs: string[] = [],
  users: string[] = [],
  projects: string[] = [];
let scenarios = 0;
async function scenario(name: string, run: () => Promise<void>) {
  await run();
  scenarios++;
  console.log(`PASS ${name}`);
}
type Session = { cookie: string; csrf: string };
async function login(email: string, password: string): Promise<Session> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    headers: { origin: config.APP_ORIGIN },
    payload: { email, password },
  });
  assert.equal(response.statusCode, 200);
  const cookie = response.headers["set-cookie"];
  assert.ok(typeof cookie === "string");
  return {
    cookie: cookie.split(";")[0] ?? "",
    csrf: response.json().csrfToken,
  };
}
const headers = (session: Session) => ({
  cookie: session.cookie,
  origin: config.APP_ORIGIN,
  "x-csrf-token": session.csrf,
});
try {
  await runPython(["tests/integration.py"]);
  const adminCredentials = {
    email: `m4-${randomUUID()}@example.invalid`,
    password: randomToken(),
  };
  const provisioned = await provisionMember(owner.pool, {
    ...adminCredentials,
    organizationName: "M4 E2E",
    role: "admin",
  });
  users.push(provisioned.userId);
  orgs.push(provisioned.organizationId);
  const org = provisioned.organizationId;
  const admin = await login(adminCredentials.email, adminCredentials.password);
  const memberships: Record<string, { session: Session; userId: string }> = {};
  for (const role of ["analyst", "reader"] as const) {
    const credentials = {
      email: `m4-${randomUUID()}@example.invalid`,
      password: randomToken(),
    };
    const member = await provisionMember(owner.pool, {
      ...credentials,
      organizationId: org,
      role,
    });
    users.push(member.userId);
    memberships[role] = {
      session: await login(credentials.email, credentials.password),
      userId: member.userId,
    };
  }
  const analyst = memberships.analyst,
    reader = memberships.reader;
  assert.ok(analyst && reader);
  const project = randomUUID(),
    externalProject = randomUUID(),
    externalOrg = randomUUID(),
    keyId = randomUUID();
  projects.push(project, externalProject);
  orgs.push(externalOrg);
  await owner.pool.query(
    "INSERT INTO organizations(id,name) VALUES($1,'M4 external')",
    [externalOrg],
  );
  await owner.pool.query(
    "INSERT INTO projects(id,organization_id,name) VALUES($1,$2,'M4 demo'),($3,$4,'M4 external')",
    [project, org, externalProject, externalOrg],
  );
  const key = `snt_ing_${keyId}.${randomToken()}`;
  await owner.pool.query(
    "INSERT INTO ingestion_keys(id,organization_id,project_id,environment,prefix,key_hash) VALUES($1,$2,$3,'demo',$4,$5)",
    [keyId, org, project, `snt_ing_${keyId}`, secretHash("ingestion", key)],
  );
  const base = `/v1/organizations/${org}/projects/${project}`;
  const get = (path: string, session = admin) =>
    app.inject({
      method: "GET",
      url: `${base}${path}`,
      headers: headers(session),
    });
  const patch = (
    alertId: string,
    status: string,
    version: number,
    session = analyst.session,
  ) =>
    app.inject({
      method: "PATCH",
      url: `${base}/alerts/${alertId}`,
      headers: headers(session),
      payload: { status, expectedVersion: version },
    });
  await scenario(
    "real demo -> SDK -> HTTP -> worker -> three explainable alerts",
    async () => {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      assert.ok(address && typeof address !== "string");
      const sdk = new SentinelClient({
        endpoint: `http://127.0.0.1:${address.port}/v1/ingest/events`,
        ingestionKey: key,
        environment: "demo",
        flushIntervalMs: 0,
      });
      const passwords = { reader: randomToken(), admin: randomToken() };
      const demo = await buildDemo(sdk, passwords);
      try {
        await demo.listen({ host: "127.0.0.1", port: 0 });
        const demoAddress = demo.server.address();
        assert.ok(demoAddress && typeof demoAddress !== "string");
        assert.equal(
          (await runScenario(`http://127.0.0.1:${demoAddress.port}`, passwords))
            .totalEvents,
          22,
        );
        await sdk.flush();
        assert.equal(sdk.stats().accepted, 22);
      } finally {
        await demo.close();
      }
      await runPython([
        "-m",
        "sentinel_detector.worker",
        "--drain",
        "--project",
        project,
      ]);
      const response = await get("/alerts");
      assert.equal(response.statusCode, 200);
      assert.deepEqual(
        response
          .json()
          .items.map((a: { ruleCode: string }) => a.ruleCode)
          .sort(),
        ["ADMIN-001", "AUTH-001", "AUTHZ-001"],
      );
      assert.equal(
        (await get("/jobs?status=completed")).json().items.length,
        22,
      );
    },
  );
  const allAlerts = (await get("/alerts")).json().items as {
    id: string;
    ruleCode: string;
    initialDecision: { count: number; triggerEventId: string };
    peakCount: number;
  }[];
  const auth = allAlerts.find((a) => a.ruleCode === "AUTH-001"),
    administrative = allAlerts.find((a) => a.ruleCode === "ADMIN-001");
  assert.ok(auth && administrative);
  await scenario(
    "evidence includes support, causal trigger and successful login context",
    async () => {
      assert.equal(auth.initialDecision.count, 5);
      assert.equal(auth.peakCount, 9);
      assert.equal(administrative.initialDecision.count, 3);
      const evidence = await get(`/alerts/${administrative.id}/evidence`);
      assert.equal(evidence.statusCode, 200);
      const items = evidence.json().items;
      assert.ok(items.some((e: { role: string }) => e.role === "context"));
      assert.ok(
        items.some(
          (e: { id: string; role: string }) =>
            e.id === administrative.initialDecision.triggerEventId &&
            e.role === "trigger",
        ),
      );
      assert.equal(
        (await get(`/events/${administrative.initialDecision.triggerEventId}`))
          .statusCode,
        200,
      );
      assert.equal((await get("/rules")).json().length, 3);
    },
  );
  await scenario(
    "events and evidence pagination preserve receipt ties without omissions",
    async () => {
      for (const path of ["/events", `/alerts/${auth.id}/evidence`]) {
        const expected = (await get(`${path}?limit=100`))
          .json()
          .items.map((e: { id: string }) => e.id);
        const ids: string[] = [];
        let cursor: string | null = null;
        do {
          const response = await get(
            `${path}?limit=2${cursor ? `&cursor=${cursor}` : ""}`,
          );
          assert.equal(response.statusCode, 200);
          const page = response.json();
          ids.push(...page.items.map((e: { id: string }) => e.id));
          cursor = page.nextCursor;
        } while (cursor);
        assert.deepEqual(ids, expected);
        assert.equal(new Set(ids).size, ids.length);
      }
    },
  );
  await scenario(
    "filters, bounded limits and scoped cursor validation",
    async () => {
      assert.equal(
        (await get("/events?type=authz.access_denied")).json().items.length,
        10,
      );
      assert.equal(
        (
          await get("/alerts?ruleCode=AUTHZ-001&status=open&environment=demo")
        ).json().items.length,
        1,
      );
      for (const query of [
        "limit=0",
        "limit=101",
        "cursor=invalid",
        "unknown=true",
        "from=2026-10-08T00:00:00Z&to=2026-10-07T00:00:00Z",
      ])
        assert.equal((await get(`/events?${query}`)).statusCode, 400);
      const cursor = (await get("/events?limit=1")).json().nextCursor;
      const forged = JSON.parse(
        Buffer.from(cursor, "base64url").toString("utf8"),
      );
      forged.position.sequence = "9999999999999999999";
      const oversized = Buffer.from(JSON.stringify(forged)).toString(
        "base64url",
      );
      assert.equal((await get(`/events?cursor=${oversized}`)).statusCode, 400);
      assert.equal(
        (await get(`/events?type=auth.login_failed&cursor=${cursor}`))
          .statusCode,
        400,
      );
      assert.equal(
        (await get(`/alerts/${auth.id}/evidence?cursor=${cursor}`)).statusCode,
        400,
      );
    },
  );
  await scenario(
    "session authentication and cross-organization/project isolation",
    async () => {
      assert.equal(
        (await app.inject({ method: "GET", url: `${base}/alerts` })).statusCode,
        401,
      );
      assert.equal(
        (
          await app.inject({
            method: "GET",
            url: `${base}/alerts`,
            headers: { authorization: `Bearer ${key}` },
          })
        ).statusCode,
        401,
      );
      for (const path of [
        "events",
        "alerts",
        `alerts/${auth.id}`,
        `alerts/${auth.id}/evidence`,
        "rules",
        "jobs",
      ])
        assert.equal(
          (
            await app.inject({
              method: "GET",
              url: `/v1/organizations/${externalOrg}/projects/${externalProject}/${path}`,
              headers: headers(admin),
            })
          ).statusCode,
          404,
        );
      assert.equal(
        (
          await app.inject({
            method: "GET",
            url: `/v1/organizations/${org}/projects/${externalProject}/alerts`,
            headers: headers(admin),
          })
        ).statusCode,
        404,
      );
      assert.equal((await get(`/events/${randomUUID()}`)).statusCode, 404);
      assert.equal(
        (await get(`/alerts/${randomUUID()}/evidence`)).statusCode,
        404,
      );
    },
  );
  await scenario(
    "reader can investigate with audit but cannot triage or inspect jobs",
    async () => {
      assert.equal(
        (await get(`/alerts/${auth.id}`, reader.session)).statusCode,
        200,
      );
      assert.equal(
        (await get(`/alerts/${auth.id}/evidence`, reader.session)).statusCode,
        200,
      );
      assert.equal((await get("/jobs", reader.session)).statusCode, 403);
      assert.equal(
        (await patch(auth.id, "triaged", 1, reader.session)).statusCode,
        403,
      );
      assert.equal(
        (
          await owner.pool.query(
            "SELECT count(*)::int AS count FROM audit_entries WHERE organization_id=$1 AND actor_user_id=$2 AND action='alert.viewed'",
            [org, reader.userId],
          )
        ).rows[0].count,
        1,
      );
    },
  );
  await scenario(
    "CSRF, optimistic status version and transactionally audited changes",
    async () => {
      assert.equal(
        (
          await app.inject({
            method: "PATCH",
            url: `${base}/alerts/${auth.id}`,
            headers: { cookie: analyst.session.cookie },
            payload: { status: "triaged", expectedVersion: 1 },
          })
        ).statusCode,
        403,
      );
      const triage = await patch(auth.id, "triaged", 1);
      assert.equal(triage.statusCode, 200);
      assert.equal(triage.json().statusVersion, 2);
      assert.equal((await patch(auth.id, "resolved", 1)).statusCode, 409);
      assert.equal(
        (await patch(auth.id, "triaged", 2)).json().statusVersion,
        2,
      );
      assert.equal(
        (await patch(auth.id, "resolved", 2, admin)).json().statusVersion,
        3,
      );
      const audit = await owner.pool.query(
        "SELECT details FROM audit_entries WHERE organization_id=$1 AND action='alert.status_changed' ORDER BY created_at,id",
        [org],
      );
      assert.equal(audit.rowCount, 2);
      assert.deepEqual(
        audit.rows.map((r) => [r.details.fromStatus, r.details.toStatus]),
        [
          ["open", "triaged"],
          ["triaged", "resolved"],
        ],
      );
    },
  );
  await scenario("audit insert failure rolls back alert status", async () => {
    await owner.pool.query(
      "CREATE FUNCTION m4_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='alert.status_changed' THEN RAISE EXCEPTION 'fixture'; END IF; RETURN NEW; END $$",
    );
    await owner.pool.query(
      "CREATE TRIGGER m4_fail_audit BEFORE INSERT ON audit_entries FOR EACH ROW EXECUTE FUNCTION m4_fail_audit()",
    );
    try {
      assert.equal((await patch(auth.id, "open", 3)).statusCode, 500);
    } finally {
      await owner.pool.query(
        "DROP TRIGGER m4_fail_audit ON audit_entries; DROP FUNCTION m4_fail_audit()",
      );
    }
    const row = (
      await owner.pool.query(
        "SELECT status,status_version FROM alerts WHERE id=$1",
        [auth.id],
      )
    ).rows[0];
    assert.deepEqual(row, { status: "resolved", status_version: 3 });
  });
  await scenario(
    "duplicate delivery and new activity retain one resolved episode",
    async () => {
      const existing = (
        await get("/events?type=auth.login_failed&limit=1")
      ).json().items[0].payload;
      const send = (event: unknown) =>
        app.inject({
          method: "POST",
          url: "/v1/ingest/events",
          headers: { authorization: `Bearer ${key}` },
          payload: { events: [event] },
        });
      assert.equal((await send(existing)).json().duplicates.length, 1);
      assert.equal(
        (
          await send({
            ...existing,
            event_id: randomUUID(),
            occurred_at: new Date().toISOString(),
          })
        ).statusCode,
        202,
      );
      await runPython([
        "-m",
        "sentinel_detector.worker",
        "--drain",
        "--project",
        project,
      ]);
      const response = await get(`/alerts/${auth.id}`);
      assert.equal(response.json().status, "resolved");
      assert.equal(response.json().statusVersion, 3);
      assert.equal(
        (await get("/alerts?ruleCode=AUTH-001")).json().items.length,
        1,
      );
      assert.equal(response.json().peakCount, 10);
    },
  );
  await scenario(
    "revoked membership rejects investigation and status changes immediately",
    async () => {
      await owner.pool.query(
        "UPDATE memberships SET active=false WHERE organization_id=$1 AND user_id=$2",
        [org, analyst.userId],
      );
      assert.equal((await get("/events", analyst.session)).statusCode, 404);
      assert.equal((await patch(auth.id, "open", 3)).statusCode, 404);
    },
  );
  await scenario(
    "failed jobs expose bounded diagnostics without payload or lease token",
    async () => {
      const eventId = (await get("/events?limit=1")).json().items[0].id;
      await owner.pool.query(
        "UPDATE detection_jobs SET status='failed',last_error_code='invalid_event' WHERE project_id=$1 AND event_id=$2",
        [project, eventId],
      );
      const response = await get("/jobs");
      assert.equal(response.statusCode, 200);
      const item = response.json().items[0];
      assert.equal(item.eventId, eventId);
      assert.equal(item.lastErrorCode, "invalid_event");
      assert.ok(!("payload" in item) && !("leaseToken" in item));
      assert.equal((await get("/jobs", reader.session)).statusCode, 403);
    },
  );
  console.log(`Investigation integration: ${scenarios} scenarios passed.`);
} finally {
  await app.close();
  for (const table of [
    "alert_evidence",
    "alerts",
    "detection_episodes",
    "detection_jobs",
    "events",
    "ingestion_quotas",
    "ingestion_keys",
  ])
    await owner.pool.query(
      `DELETE FROM ${table} WHERE project_id=ANY($1::uuid[])`,
      [projects],
    );
  await owner.pool.query("DELETE FROM projects WHERE id=ANY($1::uuid[])", [
    projects,
  ]);
  await owner.pool.query(
    "DELETE FROM audit_entries WHERE organization_id=ANY($1::uuid[])",
    [orgs],
  );
  await owner.pool.query("DELETE FROM sessions WHERE user_id=ANY($1::uuid[])", [
    users,
  ]);
  await owner.pool.query(
    "DELETE FROM memberships WHERE organization_id=ANY($1::uuid[])",
    [orgs],
  );
  await owner.pool.query("DELETE FROM organizations WHERE id=ANY($1::uuid[])", [
    orgs,
  ]);
  await owner.pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [users]);
  await runtime.pool.end();
  await owner.pool.end();
}
