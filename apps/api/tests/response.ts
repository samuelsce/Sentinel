import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { SentinelClient } from "@sentinel/sdk";
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
  console.log(`M7 integration: ${passed} scenarios passed.`);
} finally {
  await f.close();
}
