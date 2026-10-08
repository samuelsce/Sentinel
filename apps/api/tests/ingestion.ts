import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { createDatabase } from "@sentinel/database";
import { SentinelClient } from "@sentinel/sdk";
import { applyMigrations } from "../../../packages/database/src/migrations.js";
import { buildDemo } from "../../demo/src/app.js";
import { runScenario } from "../../demo/src/scenario.js";
import { buildApp } from "../src/app.js";
import { readConfig } from "../src/config.js";
import { IngestionService } from "../src/ingestion.js";
import { randomToken, secretHash } from "../src/security.js";

const url = process.env.TEST_DATABASE_URL;
if (
  !url ||
  new URL(url).pathname !== "/sentinel_test" ||
  !process.env.SENTINEL_API_DB_PASSWORD
)
  throw new Error(
    "Ingestion tests require isolated sentinel_test and API role",
  );
await applyMigrations(url);
await applyMigrations(url);
const owner = createDatabase(url);
const apiUrl = new URL(url);
apiUrl.username = "sentinel_api";
apiUrl.password = process.env.SENTINEL_API_DB_PASSWORD;
const runtime = createDatabase(apiUrl.href);
let clock = new Date();
let logs = "";
const app = await buildApp(
  readConfig({
    API_DATABASE_URL: apiUrl.href,
    LOG_LEVEL: "info",
    NODE_ENV: "test",
  }),
  {
    isReady: async () => true,
    ingestion: new IngestionService(runtime.pool, () => clock),
    logDestination: new Writable({
      write(chunk, _encoding, done) {
        logs += chunk.toString();
        done();
      },
    }),
  },
);
const orgs = [randomUUID(), randomUUID()];
const projects = [randomUUID(), randomUUID()];
const keys = Array.from({ length: 3 }, (_, index) => {
  const id = randomUUID();
  return {
    id,
    token: `snt_ing_${id}.${randomToken()}`,
    project: index === 2 ? 1 : 0,
  };
});
const [key, rotated, external] = keys;
assert.ok(key && rotated && external);
const event = () => ({
  schema_version: 1,
  event_id: randomUUID(),
  occurred_at: clock.toISOString(),
  environment: "test",
  type: "auth.login_failed",
  action: "log_in",
  outcome: "failure",
  actor_id: "fixture-reader",
  metadata: { reason: "invalid_credentials" },
});
const send = (events: unknown[], token = key.token) =>
  app.inject({
    method: "POST",
    url: "/v1/ingest/events",
    headers: { authorization: `Bearer ${token}` },
    payload: { events },
  });
let scenarios = 0;
async function scenario(name: string, operation: () => Promise<void>) {
  await operation();
  scenarios++;
  console.log(`PASS ${name}`);
}
async function counts(project = projects[0]) {
  return (
    await owner.pool.query(
      "SELECT (SELECT count(*)::int FROM events WHERE project_id=$1) AS events,(SELECT count(*)::int FROM detection_jobs WHERE project_id=$1) AS jobs",
      [project],
    )
  ).rows[0];
}
async function resetQuota() {
  await owner.pool.query(
    "DELETE FROM ingestion_quotas WHERE project_id=ANY($1::uuid[])",
    [projects],
  );
}

try {
  for (let i = 0; i < 2; i++) {
    await owner.pool.query(
      "INSERT INTO organizations(id,name) VALUES($1,'M3 test')",
      [orgs[i]],
    );
    await owner.pool.query(
      "INSERT INTO projects(id,organization_id,name) VALUES($1,$2,'M3 project')",
      [projects[i], orgs[i]],
    );
  }
  for (const fixture of keys)
    await owner.pool.query(
      "INSERT INTO ingestion_keys(id,organization_id,project_id,environment,prefix,key_hash) VALUES($1,$2,$3,'test',$4,$5)",
      [
        fixture.id,
        orgs[fixture.project],
        projects[fixture.project],
        `snt_ing_${fixture.id}`,
        secretHash("ingestion", fixture.token),
      ],
    );
  await scenario(
    "authentication before parsing, with no session fallback",
    async () => {
      for (const authorization of [
        undefined,
        "Bearer invalid",
        `Bearer ${randomToken()}`,
      ]) {
        const response = await app.inject({
          method: "POST",
          url: "/v1/ingest/events",
          headers: {
            ...(authorization ? { authorization } : {}),
            cookie: `sentinel_session=${randomToken()}`,
          },
          payload: { events: [event()] },
        });
        assert.equal(response.statusCode, 401);
      }
    },
  );
  await scenario(
    "events and durable jobs acknowledged once, replay survives rotation",
    async () => {
      const batch = [event(), event()];
      const first = await send(batch);
      assert.equal(first.statusCode, 202);
      assert.equal(first.json().accepted.length, 2);
      assert.equal(
        (await send(batch, rotated.token)).json().duplicates.length,
        2,
      );
      assert.deepEqual(await counts(), { events: 2, jobs: 2 });
    },
  );
  await scenario(
    "same ID changed content rolls back the whole batch",
    async () => {
      const original = { ...event(), event_id: `a${randomUUID().slice(1)}` };
      assert.equal((await send([original])).statusCode, 202);
      const before = await counts();
      assert.equal(
        (await send([event(), { ...original, actor_id: "changed" }]))
          .statusCode,
        409,
      );
      assert.deepEqual(await counts(), before);
      assert.equal(
        (await send([original, { ...original, actor_id: "changed" }]))
          .statusCode,
        409,
      );
      assert.equal(
        (await send([original, original])).json().duplicates.length,
        1,
      );
      assert.equal(
        (
          await send([
            original,
            { ...original, event_id: original.event_id.toUpperCase() },
          ])
        ).statusCode,
        409,
      );
    },
  );
  await scenario(
    "scoping comes only from the key and IDs are isolated by project",
    async () => {
      const shared = event();
      assert.equal(
        (await send([{ ...shared, organization_id: orgs[1] }])).statusCode,
        400,
      );
      assert.equal(
        (await send([{ ...shared, environment: "production" }])).statusCode,
        400,
      );
      assert.equal((await send([shared])).statusCode, 202);
      assert.equal((await send([shared], external.token)).statusCode, 202);
      assert.deepEqual(await counts(projects[1]), { events: 1, jobs: 1 });
    },
  );
  await scenario(
    "strict privacy contract, batch limits and time window",
    async () => {
      for (const batch of [
        [],
        Array.from({ length: 101 }, event),
        [{ ...event(), metadata: { password: randomToken() } }],
        [
          {
            ...event(),
            occurred_at: new Date(clock.getTime() - 86_400_001).toISOString(),
          },
        ],
        [
          {
            ...event(),
            occurred_at: new Date(clock.getTime() + 120_001).toISOString(),
          },
        ],
      ])
        assert.equal((await send(batch)).statusCode, 400);
      const tooLarge = await app.inject({
        method: "POST",
        url: "/v1/ingest/events",
        headers: {
          authorization: `Bearer ${key.token}`,
          "content-type": "application/json",
        },
        payload: JSON.stringify({
          events: [event()],
          padding: "x".repeat(262144),
        }),
      });
      assert.equal(tooLarge.statusCode, 413);
      const original = event();
      await send([original]);
      clock = new Date(clock.getTime() + 86_400_002);
      assert.equal((await send([original])).json().duplicates.length, 1);
    },
  );
  await resetQuota();
  await scenario(
    "concurrent replay creates one event and one job",
    async () => {
      const shared = event();
      const before = await counts();
      const responses = await Promise.all(
        Array.from({ length: 6 }, () => send([shared])),
      );
      assert.ok(responses.every((response) => response.statusCode === 202));
      assert.equal(
        responses.reduce(
          (sum, response) => sum + response.json().accepted.length,
          0,
        ),
        1,
      );
      assert.deepEqual(await counts(), {
        events: before.events + 1,
        jobs: before.jobs + 1,
      });
      const blocker = await owner.pool.connect();
      try {
        await blocker.query("BEGIN");
        await blocker.query(
          "SELECT id FROM projects WHERE id=$1 FOR NO KEY UPDATE",
          [projects[0]],
        );
        const pending = Array.from({ length: 8 }, () =>
          send([shared]).then((response) => response),
        );
        const deadline = Date.now() + 1500;
        let waiting = false;
        while (Date.now() < deadline) {
          const blocked = await owner.pool.query(
            "SELECT 1 FROM pg_stat_activity WHERE datname='sentinel_test' AND usename='sentinel_api' AND wait_event_type='Lock'",
          );
          if (blocked.rowCount) {
            waiting = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.ok(waiting);
        const overloaded = await send([shared]);
        assert.equal(overloaded.statusCode, 503);
        assert.equal(overloaded.headers["retry-after"], "1");
        await blocker.query("COMMIT");
        assert.ok(
          (await Promise.all(pending)).every(
            (response) => response.statusCode === 202,
          ),
        );
        assert.equal(
          (await send([shared])).statusCode,
          202,
          "Capacity must be released after responses",
        );
      } finally {
        await blocker.query("ROLLBACK");
        blocker.release();
      }
    },
  );
  await scenario(
    "job write failure leaves no event or partial batch",
    async () => {
      const before = await counts();
      await owner.pool.query(
        "CREATE FUNCTION m3_fail_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test rollback'; END $$",
      );
      await owner.pool.query(
        "CREATE TRIGGER m3_fail_job BEFORE INSERT ON detection_jobs FOR EACH ROW EXECUTE FUNCTION m3_fail_job()",
      );
      try {
        assert.equal((await send([event(), event()])).statusCode, 500);
        assert.deepEqual(await counts(), before);
      } finally {
        await owner.pool.query(
          "DROP TRIGGER m3_fail_job ON detection_jobs; DROP FUNCTION m3_fail_job()",
        );
      }
    },
  );
  await resetQuota();
  await scenario(
    "request quota is shared across keys, counts invalid batches, resets persistently",
    async () => {
      for (let i = 0; i < 60; i++)
        assert.equal(
          (await send([], i % 2 ? key.token : rotated.token)).statusCode,
          400,
        );
      const limited = await send([event()]);
      assert.equal(limited.statusCode, 429);
      assert.equal(limited.headers["retry-after"], "60");
      clock = new Date(clock.getTime() + 60_000);
      assert.equal((await send([event()])).statusCode, 202);
    },
  );
  await resetQuota();
  await scenario(
    "event quota rejects atomically and bounds queued work",
    async () => {
      const original = event();
      assert.equal((await send([original])).statusCode, 202);
      await owner.pool.query(
        "UPDATE ingestion_quotas SET events=3000 WHERE project_id=$1",
        [projects[0]],
      );
      const before = await counts();
      assert.equal((await send([event()])).statusCode, 429);
      assert.deepEqual(await counts(), before);
      await resetQuota();
      const pending = await owner.pool.query(
        "SELECT event_id FROM events WHERE project_id=$1 LIMIT 1",
        [projects[0]],
      );
      // Lower the test threshold through actual rows; duplicates still work at capacity.
      const extra = await owner.pool.query(
        `INSERT INTO events(organization_id,project_id,event_id,ingestion_key_id,environment,type,occurred_at,payload) SELECT $1,$2,gen_random_uuid(),$3,'test','auth.login_failed',now(),'{}'::jsonb FROM generate_series(1,10000) RETURNING event_id`,
        [orgs[0], projects[0], key.id],
      );
      await owner.pool.query(
        "INSERT INTO detection_jobs(organization_id,project_id,event_id) SELECT organization_id,project_id,event_id FROM events WHERE project_id=$1 ON CONFLICT DO NOTHING",
        [projects[0]],
      );
      assert.ok(pending.rows[0]);
      const full = await send([event()]);
      assert.equal(full.statusCode, 503);
      assert.equal(full.headers["retry-after"], "60");
      assert.equal((await send([original])).statusCode, 202);
      const ids = extra.rows.map((row) => row.event_id);
      await owner.pool.query(
        "DELETE FROM detection_jobs WHERE project_id=$1 AND event_id=ANY($2::uuid[])",
        [projects[0], ids],
      );
      await owner.pool.query(
        "DELETE FROM events WHERE project_id=$1 AND event_id=ANY($2::uuid[])",
        [projects[0], ids],
      );
    },
  );
  await resetQuota();
  await scenario(
    "revoked credential rejects, including after preflight authorization",
    async () => {
      const ingestion = new IngestionService(runtime.pool, () => clock);
      await ingestion.authorize(rotated.token);
      await owner.pool.query(
        "UPDATE ingestion_keys SET revoked_at=now() WHERE id=$1",
        [rotated.id],
      );
      await assert.rejects(
        () => ingestion.ingest(rotated.token, { events: [event()] }),
        (error) =>
          error instanceof Error &&
          "statusCode" in error &&
          error.statusCode === 401,
      );
      assert.equal((await send([event()], rotated.token)).statusCode, 401);
    },
  );
  await resetQuota();
  await scenario(
    "revocation and ingestion serialize at the key lock",
    async () => {
      async function waitForLock(fragment: string) {
        const deadline = Date.now() + 1500;
        while (Date.now() < deadline) {
          const result = await owner.pool.query(
            "SELECT 1 FROM pg_stat_activity WHERE datname='sentinel_test' AND wait_event_type='Lock' AND query LIKE $1",
            [`%${fragment}%`],
          );
          if (result.rowCount) return;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error("Expected database lock was not observed");
      }
      const raceId = randomUUID();
      const raceToken = `snt_ing_${raceId}.${randomToken()}`;
      await owner.pool.query(
        "INSERT INTO ingestion_keys(id,organization_id,project_id,environment,prefix,key_hash) VALUES($1,$2,$3,'test',$4,$5)",
        [
          raceId,
          orgs[0],
          projects[0],
          `snt_ing_${raceId}`,
          secretHash("ingestion", raceToken),
        ],
      );
      const blocker = await owner.pool.connect();
      try {
        await blocker.query("BEGIN");
        await blocker.query(
          "SELECT id FROM projects WHERE id=$1 FOR NO KEY UPDATE",
          [projects[0]],
        );
        const accepting = send([event()], raceToken).then(
          (response) => response,
        );
        await waitForLock("SELECT id FROM projects");
        const revoking = owner.pool.query(
          "UPDATE ingestion_keys SET revoked_at=now() WHERE id=$1",
          [raceId],
        );
        await waitForLock("UPDATE ingestion_keys");
        await blocker.query("COMMIT");
        assert.equal((await accepting).statusCode, 202);
        await revoking;
        assert.equal((await send([event()], raceToken)).statusCode, 401);

        const secondId = randomUUID();
        const secondToken = `snt_ing_${secondId}.${randomToken()}`;
        await owner.pool.query(
          "INSERT INTO ingestion_keys(id,organization_id,project_id,environment,prefix,key_hash) VALUES($1,$2,$3,'test',$4,$5)",
          [
            secondId,
            orgs[0],
            projects[0],
            `snt_ing_${secondId}`,
            secretHash("ingestion", secondToken),
          ],
        );
        const before = await counts();
        await blocker.query("BEGIN");
        await blocker.query(
          "UPDATE ingestion_keys SET revoked_at=now() WHERE id=$1",
          [secondId],
        );
        const rejected = send([event()], secondToken).then(
          (response) => response,
        );
        await waitForLock("FOR SHARE");
        await blocker.query("COMMIT");
        assert.equal((await rejected).statusCode, 401);
        assert.deepEqual(await counts(), before);
      } finally {
        await blocker.query("ROLLBACK");
        blocker.release();
      }
    },
  );
  await resetQuota();
  await scenario(
    "concurrent quotas and older windows cannot reset newer counters",
    async () => {
      const service = new IngestionService(runtime.pool, () => clock);
      await service.authorize(key.token);
      await owner.pool.query(
        "UPDATE ingestion_quotas SET events=2999 WHERE project_id=$1",
        [projects[0]],
      );
      const responses = await Promise.all(
        Array.from({ length: 6 }, () => send([event()])),
      );
      assert.equal(
        responses.filter((response) => response.statusCode === 202).length,
        1,
      );
      assert.equal(
        responses.filter((response) => response.statusCode === 429).length,
        5,
      );
      await owner.pool.query(
        "UPDATE ingestion_quotas SET requests=60 WHERE project_id=$1",
        [projects[0]],
      );
      const older = new IngestionService(
        runtime.pool,
        () => new Date(clock.getTime() - 60_000),
      );
      await assert.rejects(
        () => older.authorize(key.token),
        (error) =>
          error instanceof Error &&
          "statusCode" in error &&
          error.statusCode === 429,
      );
      assert.equal(
        (
          await owner.pool.query(
            "SELECT events FROM ingestion_quotas WHERE project_id=$1",
            [projects[0]],
          )
        ).rows[0]?.events,
        3000,
      );
    },
  );
  await resetQuota();
  await scenario(
    "real demo -> server SDK -> HTTP API -> PostgreSQL/jobs",
    async () => {
      const demoId = randomUUID();
      const demoToken = `snt_ing_${demoId}.${randomToken()}`;
      await owner.pool.query(
        "INSERT INTO ingestion_keys(id,organization_id,project_id,environment,prefix,key_hash) VALUES($1,$2,$3,'demo',$4,$5)",
        [
          demoId,
          orgs[1],
          projects[1],
          `snt_ing_${demoId}`,
          secretHash("ingestion", demoToken),
        ],
      );
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      assert.ok(address && typeof address !== "string");
      let lost = false;
      const sdk = new SentinelClient(
        {
          endpoint: `http://127.0.0.1:${address.port}/v1/ingest/events`,
          ingestionKey: demoToken,
          environment: "demo",
          flushIntervalMs: 0,
        },
        {
          now: () => clock.getTime(),
          random: () => 0,
          fetch: async (endpoint, init) => {
            const response = await fetch(endpoint, init);
            if (!lost && response.status === 202) {
              lost = true;
              await response.body?.cancel();
              throw new Error("lost acknowledgement");
            }
            return response;
          },
        },
      );
      const passwords = { reader: randomToken(), admin: randomToken() };
      const demo = await buildDemo(sdk, passwords);
      const before = await counts(projects[1]);
      try {
        await demo.listen({ host: "127.0.0.1", port: 0 });
        const demoAddress = demo.server.address();
        assert.ok(demoAddress && typeof demoAddress !== "string");
        assert.equal(
          (await runScenario(`http://127.0.0.1:${demoAddress.port}`, passwords))
            .totalEvents,
          15,
        );
        await sdk.flush();
        assert.equal(sdk.stats().duplicates, 15);
        assert.equal(sdk.stats().retries, 1);
        assert.equal(sdk.stats().bufferedEvents, 0);
        assert.deepEqual(await counts(projects[1]), {
          events: before.events + 15,
          jobs: before.jobs + 15,
        });
        const types = await owner.pool.query(
          "SELECT type,count(*)::int AS count FROM events WHERE ingestion_key_id=$1 GROUP BY type ORDER BY type::text",
          [demoId],
        );
        assert.deepEqual(types.rows, [
          { type: "admin.action", count: 1 },
          { type: "auth.login_failed", count: 6 },
          { type: "auth.login_succeeded", count: 2 },
          { type: "authz.access_denied", count: 6 },
        ]);
        for (const secret of [
          demoToken,
          passwords.reader,
          passwords.admin,
          ...keys.map((item) => item.token),
        ])
          assert.ok(
            !logs.includes(secret),
            "Secrets must not appear in API logs",
          );
      } finally {
        await demo.close();
      }
    },
  );
  console.log(`Ingestion integration: ${scenarios} scenarios passed.`);
} finally {
  await app.close();
  await owner.pool.query(
    "DELETE FROM detection_jobs WHERE project_id=ANY($1::uuid[])",
    [projects],
  );
  await owner.pool.query(
    "DELETE FROM events WHERE project_id=ANY($1::uuid[])",
    [projects],
  );
  await owner.pool.query(
    "DELETE FROM ingestion_quotas WHERE project_id=ANY($1::uuid[])",
    [projects],
  );
  await owner.pool.query(
    "DELETE FROM ingestion_keys WHERE project_id=ANY($1::uuid[])",
    [projects],
  );
  await owner.pool.query("DELETE FROM projects WHERE id=ANY($1::uuid[])", [
    projects,
  ]);
  await owner.pool.query("DELETE FROM organizations WHERE id=ANY($1::uuid[])", [
    orgs,
  ]);
  await runtime.pool.end();
  await owner.pool.end();
}
