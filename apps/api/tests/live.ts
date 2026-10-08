import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { fixture } from "./m5-fixture.js";

const f = await fixture();
let scenarios = 0;
const controllers: AbortController[] = [];
async function scenario(name: string, run: () => Promise<void>) {
  await run();
  scenarios++;
  console.log(`PASS ${name}`);
}
async function stream(cookie: string) {
  const controller = new AbortController();
  controllers.push(controller);
  const response = await fetch(`${f.api}${f.base}/stream`, {
    headers: { cookie },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  const reader = response.body?.getReader();
  assert.ok(reader);
  let buffered = "";
  return {
    controller,
    async event(name: string) {
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        for (;;) {
          if (buffered.includes(`event: ${name}\ndata: {}\n\n`)) {
            buffered = "";
            return;
          }
          const next = await reader.read();
          assert.ok(!next.done, "Stream ended before expected event");
          const text = new TextDecoder().decode(next.value);
          assert.ok(
            !text.includes("payload") &&
              !text.includes(f.project) &&
              !text.includes("snt_ing_"),
          );
          buffered += text;
        }
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
try {
  await f.seed();
  const admin = await f.login(),
    reader = await f.login("reader");
  const get = (path: string, cookie = admin.cookie) =>
    fetch(`${f.api}${path}`, { headers: { cookie } });
  await scenario(
    "overview has one scoped snapshot and 24 real histogram buckets",
    async () => {
      const response = await get(`${f.base}/overview`);
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(data.events24h, 22);
      assert.equal(data.openAlerts, 3);
      assert.equal(data.pendingJobs, 0);
      assert.equal(data.activity.length, 24);
      assert.equal(data.activity[0].hour, data.since);
      assert.equal(
        data.activity.reduce(
          (sum: number, b: { count: number }) => sum + b.count,
          0,
        ),
        22,
      );
      const empty = await (
        await get(`${f.base}/overview?environment=production`)
      ).json();
      assert.equal(empty.events24h, 0);
      assert.equal(empty.openAlerts, 0);
      assert.equal(empty.lastReceivedAt, null);
    },
  );
  await scenario(
    "readers can observe; anonymous and foreign scopes cannot",
    async () => {
      assert.equal(
        (await get(`${f.base}/overview`, reader.cookie)).status,
        200,
      );
      assert.equal((await fetch(`${f.api}${f.base}/stream`)).status, 401);
      assert.equal(
        (
          await get(
            `/v1/organizations/${f.foreignOrg}/projects/${f.foreignProject}/overview`,
          )
        ).status,
        404,
      );
      assert.equal(
        (
          await get(
            `/v1/organizations/${f.org}/projects/${f.foreignProject}/stream`,
          )
        ).status,
        404,
      );
      assert.equal(
        (
          await fetch(`${f.api}${f.base}/stream`, {
            headers: {
              cookie: admin.cookie,
              origin: "https://foreign.invalid",
            },
          })
        ).status,
        403,
      );
    },
  );
  await scenario(
    "live notifications detect commits and reconnect queries recover durable state",
    async () => {
      await f.owner.pool.query(
        "UPDATE sessions SET last_seen_at=now()-interval '1 minute' WHERE user_id=$1",
        [f.memberIds.reader],
      );
      const handshakeBefore = await f.owner.pool.query(
        "SELECT last_seen_at FROM sessions WHERE user_id=$1",
        [f.memberIds.reader],
      );
      const live = await stream(reader.cookie);
      await live.event("refresh");
      const before = await f.owner.pool.query(
        "SELECT last_seen_at FROM sessions WHERE user_id=$1",
        [f.memberIds.reader],
      );
      assert.equal(
        handshakeBefore.rows[0].last_seen_at.getTime(),
        before.rows[0].last_seen_at.getTime(),
      );
      await live.event("heartbeat");
      const after = await f.owner.pool.query(
        "SELECT last_seen_at FROM sessions WHERE user_id=$1",
        [f.memberIds.reader],
      );
      assert.equal(
        before.rows[0].last_seen_at.getTime(),
        after.rows[0].last_seen_at.getTime(),
      );
      f.sdk.track({
        type: "auth.login_failed",
        action: "log_in",
        outcome: "failure",
        actor_id: "live-user",
        metadata: { reason: "invalid_credentials" },
      });
      await f.sdk.flush();
      await live.event("refresh");
      live.controller.abort();
      const resumed = await stream(reader.cookie);
      await resumed.event("refresh");
      assert.equal(
        (await (await get(`${f.base}/overview`, reader.cookie)).json())
          .events24h,
        23,
      );
      resumed.controller.abort();
    },
  );
  await scenario(
    "per-user stream bounds and browser cancellation release slots",
    async () => {
      await delay(100);
      const streams = await Promise.all([
        stream(admin.cookie),
        stream(admin.cookie),
        stream(admin.cookie),
      ]);
      assert.equal((await get(`${f.base}/stream`)).status, 429);
      streams[0]?.controller.abort();
      await delay(100);
      const replacement = await stream(admin.cookie);
      await replacement.event("refresh");
      replacement.controller.abort();
      for (const live of streams) live.controller.abort();
    },
  );
  await scenario(
    "role demotion refreshes UI permissions and revoked membership closes access",
    async () => {
      const live = await stream(reader.cookie);
      await live.event("refresh");
      await f.owner.pool.query(
        "UPDATE memberships SET role='analyst' WHERE organization_id=$1 AND user_id=$2",
        [f.org, f.memberIds.reader],
      );
      await live.event("refresh");
      await f.owner.pool.query(
        "UPDATE memberships SET active=false WHERE organization_id=$1 AND user_id=$2",
        [f.org, f.memberIds.reader],
      );
      await live.event("access-lost");
      assert.equal(
        (await get(`${f.base}/overview`, reader.cookie)).status,
        404,
      );
    },
  );
  await scenario(
    "passive streams do not extend idle sessions and expiration closes the socket",
    async () => {
      const analyst = await f.login("analyst"),
        live = await stream(analyst.cookie);
      await live.event("refresh");
      await f.owner.pool.query(
        "UPDATE sessions SET last_seen_at=now()-interval '31 minutes' WHERE user_id=$1",
        [f.memberIds.analyst],
      );
      await live.event("access-lost");
      assert.equal(
        (await get(`${f.base}/overview`, analyst.cookie)).status,
        401,
      );
    },
  );
  console.log(`M5 live integration: ${scenarios} scenarios passed.`);
} finally {
  for (const controller of controllers) controller.abort();
  await f.close();
}
