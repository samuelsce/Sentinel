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

export async function fixture(origin = "http://localhost:3300") {
  const url = process.env.TEST_DATABASE_URL;
  assert.ok(
    url &&
      new URL(url).pathname === "/sentinel_test" &&
      process.env.SENTINEL_API_DB_PASSWORD &&
      process.env.SENTINEL_DETECTOR_DB_PASSWORD,
    "M5 requires isolated sentinel_test and runtime roles",
  );
  await applyMigrations(url);
  const owner = createDatabase(url),
    apiUrl = new URL(url),
    detectorUrl = new URL(url);
  apiUrl.username = "sentinel_api";
  apiUrl.password = process.env.SENTINEL_API_DB_PASSWORD;
  detectorUrl.username = "sentinel_detector";
  detectorUrl.password = process.env.SENTINEL_DETECTOR_DB_PASSWORD;
  const runtime = createDatabase(apiUrl.href);
  // Bulk corpus preparation/cleanup belongs to the isolated test operator, never the API.
  owner.pool.options.statement_timeout = 120_000;
  // Serial suites share loopback in the dedicated test database. Reset only their transport buckets.
  const transportBuckets = [
    secretHash("login-ip", "127.0.0.1"),
    secretHash("login-global", "single-api"),
  ];
  await owner.pool.query(
    "DELETE FROM login_buckets WHERE bucket=ANY($1::text[])",
    [transportBuckets],
  );
  const identity = new IdentityService(runtime.pool);
  const app = await buildApp(
    readConfig({
      API_DATABASE_URL: apiUrl.href,
      APP_ORIGIN: origin,
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
    }),
    { identity, isReady: async () => true },
  );
  const users: string[] = [],
    orgs: string[] = [];
  const credentials = {
    admin: {
      email: `m5-admin-${randomUUID()}@example.invalid`,
      password: randomToken(),
    },
    analyst: {
      email: `m5-analyst-${randomUUID()}@example.invalid`,
      password: randomToken(),
    },
    reader: {
      email: `m5-reader-${randomUUID()}@example.invalid`,
      password: randomToken(),
    },
    operator: {
      email: `m5-operator-${randomUUID()}@example.invalid`,
      password: randomToken(),
    },
  };
  const admin = await provisionMember(owner.pool, {
    ...credentials.admin,
    organizationName: "Sentinel laboratory",
    role: "admin",
  });
  const org = admin.organizationId;
  users.push(admin.userId);
  orgs.push(org);
  const memberIds: Record<string, string> = { admin: admin.userId };
  for (const account of ["analyst", "reader", "operator"] as const) {
    const member = await provisionMember(owner.pool, {
      ...credentials[account],
      organizationId: org,
      role: account === "operator" ? "admin" : account,
    });
    users.push(member.userId);
    memberIds[account] = member.userId;
  }
  const foreignOrg = randomUUID(),
    foreignProject = randomUUID(),
    project = randomUUID(),
    keyId = randomUUID();
  orgs.push(foreignOrg);
  await owner.pool.query(
    "INSERT INTO organizations(id,name) VALUES($1,'External fixture')",
    [foreignOrg],
  );
  await owner.pool.query(
    "INSERT INTO projects(id,organization_id,name) VALUES($1,$2,'Commerce demo'),($3,$4,'External project')",
    [project, org, foreignProject, foreignOrg],
  );
  const key = `snt_ing_${keyId}.${randomToken()}`;
  await owner.pool.query(
    "INSERT INTO ingestion_keys(id,organization_id,project_id,environment,prefix,key_hash) VALUES($1,$2,$3,'demo',$4,$5)",
    [keyId, org, project, `snt_ing_${keyId}`, secretHash("ingestion", key)],
  );
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address !== "string");
  const api = `http://127.0.0.1:${address.port}`,
    base = `/v1/organizations/${org}/projects/${project}`;
  const sdk = new SentinelClient({
    endpoint: `${api}/v1/ingest/events`,
    ingestionKey: key,
    environment: "demo",
    flushIntervalMs: 0,
  });
  const python = resolve(
    "services/detector/.venv",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
  return {
    owner,
    identity,
    app,
    api,
    base,
    org,
    project,
    foreignOrg,
    foreignProject,
    credentials,
    memberIds,
    key,
    sdk,
    async drain(targetProject: string = project) {
      await promisify(execFile)(
        python,
        [
          "-m",
          "sentinel_detector.worker",
          "--drain",
          "--project",
          targetProject,
        ],
        {
          cwd: resolve("services/detector"),
          env: { ...process.env, DETECTOR_DATABASE_URL: detectorUrl.href },
          timeout: 120_000,
        },
      );
    },
    async login(role: keyof typeof credentials = "admin") {
      const response = await fetch(`${api}/v1/auth/login`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify(credentials[role]),
      });
      assert.equal(response.status, 200);
      const cookie = response.headers.get("set-cookie")?.split(";")[0];
      assert.ok(cookie);
      return {
        cookie,
        csrf: ((await response.json()) as { csrfToken: string }).csrfToken,
      };
    },
    async seed() {
      const scenarioSdk = new SentinelClient({
        endpoint: `${api}/v1/ingest/events`,
        ingestionKey: key,
        environment: "demo",
        flushIntervalMs: 0,
      });
      const passwords = { reader: randomToken(), admin: randomToken() },
        demo = await buildDemo(scenarioSdk, passwords);
      try {
        await demo.listen({ host: "127.0.0.1", port: 0 });
        const addr = demo.server.address();
        assert.ok(addr && typeof addr !== "string");
        assert.equal(
          (await runScenario(`http://127.0.0.1:${addr.port}`, passwords))
            .totalEvents,
          22,
        );
        await scenarioSdk.flush();
        assert.equal(scenarioSdk.stats().accepted, 22);
      } finally {
        await demo.close();
      }
      await promisify(execFile)(
        python,
        ["-m", "sentinel_detector.worker", "--drain", "--project", project],
        {
          cwd: resolve("services/detector"),
          env: { ...process.env, DETECTOR_DATABASE_URL: detectorUrl.href },
          timeout: 120_000,
        },
      );
    },
    async close() {
      await sdk.close();
      await app.close();
      const projects = (
        await owner.pool.query<{ id: string }>(
          "SELECT id FROM projects WHERE organization_id=ANY($1::uuid[])",
          [orgs],
        )
      ).rows.map((row) => row.id);
      for (const table of [
        "response_actions",
        "response_keys",
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
      const revisions = (
        await owner.pool.query<{ rule_version: number }>(
          "DELETE FROM project_rule_revisions WHERE project_id=ANY($1::uuid[]) RETURNING rule_version",
          [projects],
        )
      ).rows.map((row) => row.rule_version);
      await owner.pool.query(
        "DELETE FROM rule_definitions WHERE version=ANY($1::integer[])",
        [revisions],
      );
      await owner.pool.query("DELETE FROM projects WHERE id=ANY($1::uuid[])", [
        projects,
      ]);
      await owner.pool.query(
        "DELETE FROM audit_entries WHERE organization_id=ANY($1::uuid[])",
        [orgs],
      );
      await owner.pool.query(
        "DELETE FROM sessions WHERE user_id=ANY($1::uuid[])",
        [users],
      );
      await owner.pool.query(
        "DELETE FROM memberships WHERE organization_id=ANY($1::uuid[])",
        [orgs],
      );
      await owner.pool.query(
        "DELETE FROM organizations WHERE id=ANY($1::uuid[])",
        [orgs],
      );
      await owner.pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [
        users,
      ]);
      await owner.pool.query(
        "DELETE FROM login_buckets WHERE bucket=ANY($1::text[])",
        [
          [
            ...transportBuckets,
            ...Object.values(credentials).map((account) =>
              secretHash("login-account", account.email),
            ),
          ],
        ],
      );
      await runtime.pool.end();
      await owner.pool.end();
    },
  };
}
