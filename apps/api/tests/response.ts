import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { SentinelClient } from "@sentinel/sdk";
import { retainProject } from "../../../packages/database/src/retention.js";
import { buildDemo } from "../../demo/src/app.js";
import { DemoResponseAdapter } from "../../demo/src/response-adapter.js";
import { randomToken } from "../src/security.js";
import { fixture } from "./m5-fixture.js";

const f = await fixture();
let passed = 0;
async function scenario(name: string, run: () => Promise<void>) {
  await run();
  passed++;
  console.log(`PASS ${name}`);
}
try {
  await f.seed();
  const admin = await f.login(),
    analyst = await f.login("analyst"),
    reader = await f.login("reader");
  const get = (path: string, session = admin) =>
    f.app.inject({ url: path, headers: { cookie: session.cookie } });
  const mutate = (
    path: string,
    payload: unknown,
    session = admin,
    method: "POST" | "PATCH" | "DELETE" = "POST",
  ) =>
    f.app.inject({
      method,
      url: path,
      headers: {
        cookie: session.cookie,
        origin: "http://localhost:3300",
        "x-csrf-token": session.csrf,
      },
      ...(payload !== undefined
        ? {
            payload: JSON.stringify(payload),
            headers: {
              cookie: session.cookie,
              origin: "http://localhost:3300",
              "x-csrf-token": session.csrf,
              "content-type": "application/json",
            },
          }
        : {}),
    });
  const alerts = (await get(`${f.base}/alerts`)).json().items as {
    id: string;
    ruleCode: string;
    ruleVersion: number;
    initialDecision: { threshold: number };
  }[];
  const alert = alerts.find((item) => item.ruleCode === "AUTH-001");
  assert.ok(alert);
  const endpoint = `${f.base}/alerts/${alert.id}/responses`;
  const input = {
    requestId: randomUUID(),
    sourceIp: "127.0.0.1",
    reason: "Revisao manual de falhas repetidas",
    ttlSeconds: 15,
  };
  let key = "",
    keyId = "",
    stagingKey = "",
    foreignKey = "";
  await scenario(
    "Response requests enforce session, roles, CSRF, scope, evidence and TTL",
    async () => {
      assert.equal(
        (await f.app.inject({ method: "POST", url: endpoint, payload: input }))
          .statusCode,
        401,
      );
      assert.equal((await mutate(endpoint, input, reader)).statusCode, 403);
      assert.equal(
        (
          await f.app.inject({
            method: "POST",
            url: endpoint,
            headers: { cookie: admin.cookie, origin: "http://localhost:3300" },
            payload: input,
          })
        ).statusCode,
        403,
      );
      for (const change of [
        { ttlSeconds: 0 },
        { ttlSeconds: 3601 },
        { reason: "<script>" },
        { sourceIp: "192.0.2.99" },
        { sourceIp: "fe80::1%eth0" },
        { environment: "production" },
      ])
        assert.equal(
          (await mutate(endpoint, { ...input, ...change })).statusCode,
          400,
        );
      assert.equal(
        (
          await mutate(
            `/v1/organizations/${f.foreignOrg}/projects/${f.foreignProject}/alerts/${alert.id}/responses`,
            input,
          )
        ).statusCode,
        404,
      );
      const requested = await mutate(endpoint, input, analyst);
      assert.equal(requested.statusCode, 202);
      assert.equal(requested.json().state, "requested");
      // Retries use the same acting member and intent.
      assert.equal(
        (await mutate(endpoint, input, analyst)).json().id,
        input.requestId,
      );
      assert.equal(
        (await mutate(endpoint, { ...input, ttlSeconds: 60 }, analyst))
          .statusCode,
        409,
      );
      assert.equal((await get(endpoint, reader)).json().length, 1);
    },
  );
  await scenario(
    "Adapter credentials are admin-only, separately scoped and displayed once",
    async () => {
      assert.equal(
        (
          await mutate(
            `${f.base}/response-keys`,
            { environment: "demo" },
            analyst,
          )
        ).statusCode,
        403,
      );
      const response = await mutate(`${f.base}/response-keys`, {
        environment: "demo",
      });
      assert.equal(response.statusCode, 201);
      key = response.json().key;
      keyId = response.json().id;
      assert.equal(
        (await mutate(`${f.base}/response-keys`, { environment: "demo" }))
          .statusCode,
        409,
      );
      stagingKey = (
        await mutate(`${f.base}/response-keys`, { environment: "staging" })
      ).json().key;
      const token = `snt_rsp_${randomUUID()}.${randomToken()}`;
      foreignKey = token;
      const { secretHash } = await import("../src/security.js");
      await f.owner.pool.query(
        "INSERT INTO response_keys(organization_id,project_id,environment,key_hash) VALUES($1,$2,'demo',$3)",
        [f.foreignOrg, f.foreignProject, secretHash("response", token)],
      );
      assert.equal(
        (await get(`${f.base}/response-keys`, reader)).statusCode,
        403,
      );
      const metadata = (await get(`${f.base}/response-keys`)).body;
      assert.ok(!metadata.includes(key));
      assert.ok(!metadata.includes("key_hash"));
    },
  );
  const commands = (credential = key) =>
    f.app.inject({
      url: "/v1/response/commands",
      headers: { authorization: `Bearer ${credential}` },
    });
  const ack = (identifier: string, body: unknown, credential = key) =>
    f.app.inject({
      method: "POST",
      url: `/v1/response/commands/${identifier}/ack`,
      headers: {
        authorization: `Bearer ${credential}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify(body),
    });
  await scenario(
    "Ingestion keys, browser sessions and other scopes cannot execute response protocol",
    async () => {
      assert.equal((await commands(f.key)).statusCode, 401);
      assert.equal((await get("/v1/response/commands")).statusCode, 401);
      assert.deepEqual((await commands(stagingKey)).json().commands, []);
      assert.deepEqual((await commands(foreignKey)).json().commands, []);
      assert.equal(
        (await ack(input.requestId, { state: "applied" }, stagingKey))
          .statusCode,
        404,
      );
      assert.equal(
        (await ack(input.requestId, { state: "applied" }, foreignKey))
          .statusCode,
        404,
      );
      assert.equal(
        (
          await f.app.inject({
            method: "POST",
            url: "/v1/ingest/events",
            headers: { authorization: `Bearer ${key}` },
            payload: { events: [] },
          })
        ).statusCode,
        401,
      );
      assert.ok(!(await commands()).body.includes(input.reason));
    },
  );
  const adapter = new DemoResponseAdapter({
    endpoint: `${f.api}/v1/response`,
    key,
  });
  await scenario(
    "Demo applies the reviewed IP and confirms without affecting Sentinel or forwarded IPs",
    async () => {
      await adapter.sync();
      assert.ok(adapter.isBlocked("127.0.0.1"));
      assert.ok(!adapter.isBlocked("192.0.2.2"));
      const sdk = new SentinelClient({
        endpoint: `${f.api}/v1/ingest/events`,
        ingestionKey: f.key,
        environment: "demo",
        flushIntervalMs: 0,
      });
      const demo = await buildDemo(
        sdk,
        { reader: randomToken(), admin: randomToken() },
        "http://localhost:3002",
        adapter,
      );
      try {
        await demo.listen({ host: "127.0.0.1", port: 0 });
        const address = demo.server.address();
        assert.ok(address && typeof address !== "string");
        assert.equal(
          (await fetch(`http://127.0.0.1:${address.port}/lab/metrics`)).status,
          403,
        );
        assert.equal(
          (
            await demo.inject({
              url: "/lab/metrics",
              remoteAddress: "127.0.0.1",
            })
          ).statusCode,
          403,
        );
        assert.equal(
          (
            await demo.inject({
              url: "/lab/metrics",
              remoteAddress: "192.0.2.2",
              headers: { "x-forwarded-for": "127.0.0.1" },
            })
          ).statusCode,
          200,
        );
        assert.equal((await get(endpoint)).statusCode, 200);
        assert.equal((await get(endpoint)).json()[0].state, "applied");
        assert.equal(
          (await ack(input.requestId, { state: "applied" })).statusCode,
          200,
        );
        assert.equal(
          (
            await ack(input.requestId, {
              state: "failed",
              failureCode: "adapter_error",
            })
          ).statusCode,
          409,
        );
        assert.equal(
          (await ack(input.requestId, { state: "expired" })).statusCode,
          409,
        );
      } finally {
        await demo.close();
      }
    },
  );
  await scenario(
    "Restart restores confirmed blocks and repeated delivery never extends TTL",
    async () => {
      const before = (await get(endpoint)).json()[0].expiresAt;
      const restarted = new DemoResponseAdapter({
        endpoint: `${f.api}/v1/response`,
        key,
      });
      await restarted.sync();
      assert.ok(restarted.isBlocked("127.0.0.1"));
      await restarted.sync();
      assert.equal((await get(endpoint)).json()[0].expiresAt, before);
      const offline = new DemoResponseAdapter({
        endpoint: `${f.api}/v1/response`,
        key,
        now: () => Date.parse(before) + 1,
      });
      // Offline expiry is also tested below with a loaded adapter and advancing clock.
      assert.ok(!offline.isBlocked("127.0.0.1"));
    },
  );
  let overlapId = "";
  await scenario(
    "Overlapping actions retain the later block when one expires",
    async () => {
      overlapId = randomUUID();
      assert.equal(
        (
          await mutate(endpoint, {
            ...input,
            requestId: overlapId,
            ttlSeconds: 60,
          })
        ).statusCode,
        202,
      );
      await adapter.sync();
      await f.owner.pool.query(
        "UPDATE response_actions SET expires_at=now()-interval '1 second' WHERE id=$1",
        [input.requestId],
      );
      const expired = (await get(endpoint))
        .json()
        .find((item: { id: string }) => item.id === input.requestId);
      assert.equal(expired.state, "expired");
      assert.equal(expired.expiredConfirmedAt, null);
      await adapter.sync();
      assert.ok(adapter.isBlocked("127.0.0.1"));
      assert.ok(
        (await get(endpoint))
          .json()
          .find((item: { id: string }) => item.id === input.requestId)
          .expiredConfirmedAt,
      );
      assert.equal(
        (await ack(input.requestId, { state: "applied" })).statusCode,
        409,
      );
    },
  );
  await scenario(
    "Adapter failures are visible, bounded and final",
    async () => {
      const failedId = randomUUID();
      await mutate(endpoint, { ...input, requestId: failedId });
      assert.equal(
        (await ack(failedId, { state: "failed", failureCode: "adapter_error" }))
          .statusCode,
        200,
      );
      assert.equal(
        (await ack(failedId, { state: "failed", failureCode: "adapter_error" }))
          .statusCode,
        200,
      );
      assert.equal((await ack(failedId, { state: "applied" })).statusCode, 409);
      assert.equal(
        (
          await ack(failedId, {
            state: "failed",
            failureCode: "private error or credential",
          })
        ).statusCode,
        400,
      );
      assert.equal(
        (await get(endpoint))
          .json()
          .find((item: { id: string }) => item.id === failedId).state,
        "failed",
      );
    },
  );
  await scenario(
    "Revocation denies polling and acknowledgements; offline expiry remains local",
    async () => {
      let clock = Date.now();
      const offline = new DemoResponseAdapter({
        endpoint: `${f.api}/v1/response`,
        key,
        now: () => clock,
      });
      await offline.sync();
      assert.ok(offline.isBlocked("127.0.0.1"));
      assert.equal(
        (
          await mutate(
            `${f.base}/response-keys/${keyId}`,
            undefined,
            admin,
            "DELETE",
          )
        ).statusCode,
        204,
      );
      assert.equal((await commands()).statusCode, 401);
      assert.equal(
        (await ack(overlapId, { state: "applied" })).statusCode,
        401,
      );
      await assert.rejects(offline.sync());
      clock += 3_600_001;
      assert.ok(!offline.isBlocked("127.0.0.1"));
    },
  );
  const settingsPath = `${f.base}/rule-settings`;
  const change = {
    expectedVersion: 1,
    enabled: true,
    threshold: 8,
    windowSeconds: 300,
  };
  await scenario(
    "Rule configuration enforces admin, tenant, CSRF, bounds and optimistic versions",
    async () => {
      for (const member of [analyst, reader])
        assert.equal(
          (await mutate(`${settingsPath}/AUTH-001`, change, member, "PATCH"))
            .statusCode,
          403,
        );
      assert.equal(
        (
          await f.app.inject({
            method: "PATCH",
            url: `${settingsPath}/AUTH-001`,
            headers: { cookie: admin.cookie },
            payload: change,
          })
        ).statusCode,
        403,
      );
      for (const invalid of [
        { threshold: 1 },
        { threshold: 101 },
        { windowSeconds: 29 },
        { windowSeconds: 3601 },
        { severity: "low" },
      ])
        assert.equal(
          (
            await mutate(
              `${settingsPath}/AUTH-001`,
              { ...change, ...invalid },
              admin,
              "PATCH",
            )
          ).statusCode,
          400,
        );
      assert.equal(
        (
          await get(
            `/v1/organizations/${f.foreignOrg}/projects/${f.foreignProject}/rule-settings`,
          )
        ).statusCode,
        404,
      );
      assert.equal(
        (await mutate(`${settingsPath}/UNSUPPORTED`, change, admin, "PATCH"))
          .statusCode,
        400,
      );
    },
  );
  const emit = async (source: string, count: number) => {
    for (let i = 0; i < count; i++)
      assert.ok(
        f.sdk.track({
          type: "auth.login_failed",
          action: "log_in",
          outcome: "failure",
          source_ip: source,
          actor_id: "private-actor",
          resource: "/private-resource",
          metadata: { reason: "invalid_credentials" },
        }),
      );
    await f.sdk.flush();
  };
  let configuredVersion = 0;
  await scenario(
    "Queued events freeze original configuration and existing decisions remain intact",
    async () => {
      await emit("192.0.2.22", 5);
      const configured = await mutate(
        `${settingsPath}/AUTH-001`,
        change,
        admin,
        "PATCH",
      );
      assert.equal(configured.statusCode, 200);
      configuredVersion = configured.json().version;
      assert.ok(configuredVersion > 1);
      assert.equal(
        (await mutate(`${settingsPath}/AUTH-001`, change, admin, "PATCH"))
          .statusCode,
        409,
      );
      await f.drain();
      const rows = (
        await f.owner.pool.query(
          "SELECT rule_version,initial_decision FROM alerts WHERE project_id=$1 AND rule_code='AUTH-001' AND id<>$2",
          [f.project, alert.id],
        )
      ).rows;
      assert.ok(
        rows.some(
          (row) =>
            row.rule_version === 1 && row.initial_decision.threshold === 5,
        ),
      );
      assert.equal(
        (await get(`${f.base}/alerts/${alert.id}`)).json().ruleVersion,
        1,
      );
      assert.equal(
        (await get(`${f.base}/alerts/${alert.id}`)).json().initialDecision
          .threshold,
        5,
      );
      const stored = (
        await f.owner.pool.query(
          "SELECT rule_snapshot FROM detection_jobs WHERE project_id=$1 ORDER BY event_ingest_order DESC LIMIT 1",
          [f.project],
        )
      ).rows[0];
      assert.equal(
        stored.rule_snapshot.find(
          (item: { code: string }) => item.code === "AUTH-001",
        ).version,
        1,
      );
      await assert.rejects(
        f.owner.pool.query(
          "UPDATE detection_jobs SET rule_snapshot='[]'::jsonb WHERE project_id=$1",
          [f.project],
        ),
      );
    },
  );
  await scenario(
    "Higher limit avoids alerting on benign burst; threshold boundary uses a new episode/version",
    async () => {
      await emit("192.0.2.33", 5);
      await f.drain();
      const count = async () =>
        Number(
          (
            await f.owner.pool.query(
              "SELECT count(*) AS count FROM alerts WHERE project_id=$1 AND rule_code='AUTH-001' AND rule_version=$2",
              [f.project, configuredVersion],
            )
          ).rows[0]?.count,
        );
      assert.equal(await count(), 0);
      await emit("192.0.2.33", 3);
      await f.drain();
      assert.equal(await count(), 1);
      const current = (await get(settingsPath)).json();
      assert.equal(current.history.length, 1);
      assert.equal(
        current.current.find(
          (item: { code: string }) => item.code === "AUTH-001",
        ).threshold,
        8,
      );
      const foreign = (
        await f.owner.pool.query(
          "SELECT count(*) AS count FROM project_rule_revisions WHERE project_id=$1",
          [f.foreignProject],
        )
      ).rows[0];
      assert.equal(Number(foreign.count), 0);
    },
  );
  await scenario(
    "Disabled rule ignores new events, re-enabling records another immutable revision",
    async () => {
      const disabled = await mutate(
        `${settingsPath}/AUTH-001`,
        { ...change, expectedVersion: configuredVersion, enabled: false },
        admin,
        "PATCH",
      );
      assert.equal(disabled.statusCode, 200);
      await emit("192.0.2.44", 10);
      await f.drain();
      assert.equal(
        Number(
          (
            await f.owner.pool.query(
              "SELECT count(*) AS count FROM alerts WHERE project_id=$1 AND rule_version=$2",
              [f.project, disabled.json().version],
            )
          ).rows[0].count,
        ),
        0,
      );
      const enabled = await mutate(
        `${settingsPath}/AUTH-001`,
        { ...change, expectedVersion: disabled.json().version },
        admin,
        "PATCH",
      );
      assert.equal(enabled.statusCode, 200);
      const noOp = await mutate(
        `${settingsPath}/AUTH-001`,
        { ...change, expectedVersion: enabled.json().version },
        admin,
        "PATCH",
      );
      assert.equal(noOp.json().version, enabled.json().version);
      assert.equal((await get(settingsPath)).json().history.length, 3);
      const permissions = (
        await f.owner.pool.query(
          "SELECT has_table_privilege('sentinel_api','rule_definitions','UPDATE') AS definitions,has_table_privilege('sentinel_api','project_rule_revisions','UPDATE') AS revisions",
        )
      ).rows[0];
      assert.deepEqual(permissions, { definitions: false, revisions: false });
    },
  );
  await scenario(
    "Sanitized report preserves decisions and pseudonymous evidence, omits sensitive fields",
    async () => {
      const latest = (
        await f.owner.pool.query(
          "SELECT id FROM alerts WHERE project_id=$1 AND rule_version=$2 LIMIT 1",
          [f.project, configuredVersion],
        )
      ).rows[0];
      const response = await get(
        `${f.base}/alerts/${latest.id}/report`,
        reader,
      );
      assert.equal(response.statusCode, 200);
      assert.ok(
        response.headers["content-disposition"]?.includes("attachment"),
      );
      const report = response.json();
      assert.equal(report.rule.threshold, 8);
      assert.equal(report.evidence.length, 8);
      assert.equal(
        new Set(report.evidence.map((item: { source: string }) => item.source))
          .size,
        1,
      );
      for (const value of [
        f.project,
        f.org,
        latest.id,
        "192.0.2.33",
        "private-actor",
        "private-resource",
        "invalid_credentials",
        f.key,
        key,
        f.credentials.admin.email,
      ])
        assert.ok(
          !response.body.includes(value),
          `Unexpected sensitive projection`,
        );
      for (const forbidden of [
        "metadata",
        "actor_id",
        "source_ip",
        "event_id",
        "reason:",
      ])
        assert.ok(!Object.keys(report.evidence[0]).includes(forbidden));
      assert.equal(
        (await f.app.inject({ url: `${f.base}/alerts/${latest.id}/report` }))
          .statusCode,
        401,
      );
      assert.equal(
        (
          await get(
            `/v1/organizations/${f.foreignOrg}/projects/${f.foreignProject}/alerts/${latest.id}/report`,
          )
        ).statusCode,
        404,
      );
    },
  );
  await scenario(
    "Reports survive raw-event retention and omit response memos/IPs",
    async () => {
      await f.owner.pool.query(
        "DELETE FROM detection_jobs WHERE project_id=$1",
        [f.project],
      );
      await f.owner.pool.query("DELETE FROM events WHERE project_id=$1", [
        f.project,
      ]);
      const response = await get(`${f.base}/alerts/${alert.id}/report`);
      assert.equal(response.statusCode, 200);
      assert.ok(
        response
          .json()
          .evidence.every(
            (item: { rawAvailable: boolean }) => !item.rawAvailable,
          ),
      );
      assert.ok(!response.body.includes(input.reason));
      assert.ok(!response.body.includes(input.sourceIp));
      assert.ok(response.json().responses.length > 0);
    },
  );
  await scenario(
    "Every lifecycle result, configuration and export leaves sanitized audit evidence",
    async () => {
      const grants = (
        await f.owner.pool.query(
          "SELECT has_column_privilege('sentinel_api','response_actions','ttl_seconds','UPDATE') AS ttl,has_column_privilege('sentinel_api','response_actions','source_ip','UPDATE') AS ip,has_table_privilege('sentinel_detector','response_keys','SELECT') AS detector",
        )
      ).rows[0];
      assert.deepEqual(grants, { ttl: false, ip: false, detector: false });
      const rows = (
        await f.owner.pool.query(
          "SELECT action,details FROM audit_entries WHERE organization_id=$1",
          [f.org],
        )
      ).rows;
      for (const action of [
        "response.key_created",
        "response.key_revoked",
        "response.requested",
        "response.applied",
        "response.failed",
        "response.expired",
        "response.expiry_confirmed",
        "rule.configured",
        "report.exported",
      ])
        assert.ok(rows.some((row) => row.action === action));
      assert.ok(!JSON.stringify(rows).includes(key));
      assert.ok(!JSON.stringify(rows).includes(input.reason));
      assert.equal(
        (await get(`/v1/organizations/${f.org}/audit`)).statusCode,
        200,
      );
    },
  );
  await scenario(
    "Another project's detector remains on its original threshold and revision",
    async () => {
      const other = await f.identity.createProject(
        f.memberIds.admin as string,
        f.org,
        "Second application",
      );
      const otherKey = await f.identity.issueKey(
        f.memberIds.admin as string,
        f.org,
        other.id,
        "demo",
      );
      const sdk = new SentinelClient({
        endpoint: `${f.api}/v1/ingest/events`,
        ingestionKey: otherKey.key,
        environment: "demo",
        flushIntervalMs: 0,
      });
      try {
        for (let i = 0; i < 5; i++)
          assert.ok(
            sdk.track({
              type: "auth.login_failed",
              action: "log_in",
              outcome: "failure",
              source_ip: "192.0.2.55",
              metadata: {},
            }),
          );
        await sdk.flush();
        await f.drain(other.id);
        const found = (
          await f.owner.pool.query(
            "SELECT rule_version,initial_decision FROM alerts WHERE project_id=$1",
            [other.id],
          )
        ).rows;
        assert.equal(found.length, 1);
        assert.equal(found[0].rule_version, 1);
        assert.equal(found[0].initial_decision.threshold, 5);
        const otherSettings = (
          await get(
            `/v1/organizations/${f.org}/projects/${other.id}/rule-settings`,
          )
        ).json();
        assert.equal(otherSettings.history.length, 0);
      } finally {
        await sdk.close();
      }
    },
  );
  await scenario(
    "Expiry backlog cannot omit active blocks during restart; capacity is bounded",
    async () => {
      await f.owner.pool.query(
        "UPDATE response_actions SET expires_at=now()-interval '1 second' WHERE project_id=$1",
        [f.project],
      );
      await get(endpoint);
      const credential = (
        await mutate(`${f.base}/response-keys`, { environment: "demo" })
      ).json().key;
      const seeded = (
        await f.owner.pool.query<{ id: string }>(
          "INSERT INTO response_actions(id,organization_id,project_id,environment,alert_id,requested_by,source_ip,reason,ttl_seconds,state,expires_at) SELECT gen_random_uuid(),$1,$2,'demo',$3,$4,'127.0.0.1','Bulk boundary fixture',60,CASE WHEN i<=100 THEN 'requested' ELSE 'expired' END,clock_timestamp()+CASE WHEN i<=100 THEN interval '1 minute' ELSE interval '-1 second' END FROM generate_series(1,301) i RETURNING id",
          [f.org, f.project, alert.id, f.memberIds.admin],
        )
      ).rows.map((row) => row.id);
      try {
        assert.equal(
          (await mutate(endpoint, { ...input, requestId: randomUUID() }))
            .statusCode,
          429,
        );
        const batch = (await commands(credential)).json().commands;
        assert.equal(batch.length, 200);
        assert.equal(
          batch.filter((item: { state: string }) => item.state !== "expired")
            .length,
          100,
        );
        const restored = new DemoResponseAdapter({
          endpoint: `${f.api}/v1/response`,
          key: credential,
        });
        await restored.sync();
        assert.ok(restored.isBlocked("127.0.0.1"));
        assert.equal(
          Number(
            (
              await f.owner.pool.query(
                "SELECT count(*) AS count FROM response_actions WHERE id=ANY($1::uuid[]) AND state='applied'",
                [seeded],
              )
            ).rows[0]?.count,
          ),
          100,
        );
      } finally {
        await f.owner.pool.query(
          "DELETE FROM response_actions WHERE id=ANY($1::uuid[])",
          [seeded],
        );
      }
    },
  );
  await scenario(
    "Retention protects active responses and removes settled response history with its resolved alert",
    async () => {
      await f.owner.pool.query(
        "UPDATE alerts SET status='resolved',updated_at=now()-interval '100 days' WHERE id=$1",
        [alert.id],
      );
      await f.owner.pool.query(
        "UPDATE detection_episodes SET last_relevant_at=now()-interval '100 days' WHERE id=(SELECT episode_id FROM alerts WHERE id=$1)",
        [alert.id],
      );
      await f.owner.pool.query(
        "UPDATE response_actions SET expires_at=now()+interval '1 minute' WHERE id=$1",
        [overlapId],
      );
      assert.equal(
        (await retainProject(f.owner.pool, f.project, true)).removed.alerts,
        0,
      );
      await f.owner.pool.query(
        "UPDATE response_actions SET expires_at=now()-interval '1 second' WHERE alert_id=$1",
        [alert.id],
      );
      const retained = await retainProject(f.owner.pool, f.project, true);
      assert.equal(retained.removed.alerts, 1);
      assert.equal(retained.removed.responses, 3);
    },
  );
  console.log(`M7 integration: ${passed} scenarios passed.`);
} finally {
  await f.close();
}
