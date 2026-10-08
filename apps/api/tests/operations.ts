import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  retainAudit,
  retainProject,
} from "../../../packages/database/src/retention.js";
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
    reader = await f.login("reader"),
    analyst = await f.login("analyst");
  const get = (path: string, cookie = admin.cookie) =>
    f.app.inject({ method: "GET", url: path, headers: { cookie } });
  const metric = () => get(`${f.base}/metrics`);
  await scenario(
    "Metrics enforce session, role, tenant scope and strict query",
    async () => {
      assert.equal(
        (await f.app.inject({ url: `${f.base}/metrics` })).statusCode,
        401,
      );
      assert.equal(
        (await get(`${f.base}/metrics`, reader.cookie)).statusCode,
        403,
      );
      assert.equal(
        (await get(`${f.base}/metrics`, analyst.cookie)).statusCode,
        200,
      );
      assert.equal(
        (
          await get(
            `/v1/organizations/${f.foreignOrg}/projects/${f.foreignProject}/metrics`,
          )
        ).statusCode,
        404,
      );
      assert.equal(
        (await get(`${f.base}/metrics?projectId=${f.foreignProject}`))
          .statusCode,
        400,
      );
      const result = (await metric()).json();
      assert.deepEqual(result.ingestion, {
        accepted: 22,
        duplicates: 0,
        batches: result.ingestion.batches,
      });
      assert.equal(result.queue.completed24h, 22);
      assert.equal(result.queue.oldestPendingSeconds, null);
      assert.ok(result.queue.completionP95Ms >= 0);
      for (const secret of [f.key, f.project, f.credentials.admin.password])
        assert.ok(!JSON.stringify(result).includes(secret));
    },
  );
  const event = (
    await f.owner.pool.query(
      "SELECT payload FROM events WHERE project_id=$1 ORDER BY ingest_order LIMIT 1",
      [f.project],
    )
  ).rows[0]?.payload;
  const send = (body: unknown) =>
    f.app.inject({
      method: "POST",
      url: "/v1/ingest/events",
      headers: {
        authorization: `Bearer ${f.key}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify(body),
    });
  await scenario(
    "Receipts count duplicates without inflating persisted events",
    async () => {
      assert.equal((await send({ events: [event] })).statusCode, 202);
      assert.equal((await metric()).json().ingestion.duplicates, 1);
      assert.equal((await metric()).json().ingestion.accepted, 22);
    },
  );
  await scenario(
    "HTML, SQL, log control characters and mass assignment reject atomically",
    async () => {
      for (const value of [
        "<script>alert(1)</script>",
        "x'; DROP TABLE events;--",
        "actor\r\nforged=true",
      ]) {
        assert.equal(
          (
            await send({
              events: [{ ...event, event_id: randomUUID(), actor_id: value }],
            })
          ).statusCode,
          400,
        );
      }
      for (const metadata of [
        { password: "forbidden" },
        { token: "forbidden" },
        { email: "secret@example.invalid" },
      ])
        assert.equal(
          (
            await send({
              events: [{ ...event, event_id: randomUUID(), metadata }],
            })
          ).statusCode,
          400,
        );
      assert.equal(
        (await send({ events: [event], organization_id: f.foreignOrg }))
          .statusCode,
        400,
      );
      assert.equal((await metric()).json().ingestion.accepted, 22);
    },
  );
  const alerts = (await get(`${f.base}/alerts`)).json().items as {
    id: string;
  }[];
  const evidence = await get(`${f.base}/alerts/${alerts[0]?.id}/evidence`);
  // Age both active investigation states, not only freshly open alerts.
  await f.owner.pool.query("UPDATE alerts SET status='triaged' WHERE id=$1", [
    alerts[1]?.id,
  ]);
  await scenario(
    "Snapshots captured by database, scoped and immutable to runtime roles",
    async () => {
      const id = randomUUID();
      await assert.rejects(
        f.owner.pool.query(
          "INSERT INTO alert_evidence(organization_id,project_id,environment,alert_id,event_id,role) VALUES($1,$2,'demo',$3,$4,'support')",
          [f.org, f.project, alerts[0]?.id, id],
        ),
        (error: unknown) => (error as { code: string }).code === "23503",
      );
      const grants = await f.owner.pool.query(
        "SELECT has_table_privilege('sentinel_api','alert_evidence','UPDATE') AS api,has_table_privilege('sentinel_detector','alert_evidence','UPDATE') AS detector,has_table_privilege('sentinel_api','events','DELETE') AS purge",
      );
      assert.deepEqual(grants.rows[0], {
        api: false,
        detector: false,
        purge: false,
      });
      assert.equal(evidence.statusCode, 200);
      assert.ok(evidence.json().items.length > 0);
    },
  );
  await f.owner.pool.query(
    "UPDATE events SET received_at=now()-interval '100 days' WHERE project_id=$1",
    [f.project],
  );
  await f.owner.pool.query(
    "UPDATE alerts SET updated_at=now()-interval '100 days' WHERE project_id=$1",
    [f.project],
  );
  await f.owner.pool.query(
    "UPDATE detection_episodes SET last_relevant_at=now()-interval '100 days' WHERE project_id=$1",
    [f.project],
  );
  await scenario(
    "Retention dry run rolls back; batch bound and pending work remain protected",
    async () => {
      assert.equal(
        (await retainProject(f.owner.pool, f.project, false, 5)).removed.events,
        5,
      );
      assert.equal(
        (
          await f.owner.pool.query(
            "SELECT count(*) FROM events WHERE project_id=$1",
            [f.project],
          )
        ).rows[0]?.count,
        "22",
      );
      const row = (
        await f.owner.pool.query(
          "SELECT id FROM detection_jobs WHERE project_id=$1 LIMIT 1",
          [f.project],
        )
      ).rows[0];
      await f.owner.pool.query(
        "UPDATE detection_jobs SET status='pending',completed_at=NULL WHERE id=$1",
        [row?.id],
      );
      assert.equal(
        (await retainProject(f.owner.pool, f.project, true, 1000)).removed
          .events,
        0,
      );
      assert.equal(
        (
          await f.owner.pool.query(
            "SELECT count(*) FROM detection_jobs WHERE project_id=$1 AND status='pending'",
            [f.project],
          )
        ).rows[0]?.count,
        "1",
      );
      await assert.rejects(retainProject(f.owner.pool, f.project, true, 1001));
      await f.owner.pool.query(
        "UPDATE detection_jobs SET status='processing',attempts=1,lease_token=$2,leased_until=now()-interval '1 second' WHERE id=$1",
        [row?.id, randomUUID()],
      );
      assert.equal(
        (await retainProject(f.owner.pool, f.project, true)).removed.events,
        0,
      );
      await f.owner.pool.query(
        "UPDATE detection_jobs SET status='completed',lease_token=NULL,leased_until=NULL WHERE id=$1",
        [row?.id],
      );
      await retainProject(f.owner.pool, f.project, true);
    },
  );
  await scenario(
    "Open and triaged alerts retain paginated evidence after raw-event purge",
    async () => {
      assert.equal((await get(`${f.base}/alerts`)).json().items.length, 3);
      assert.ok(
        (await get(`${f.base}/alerts`))
          .json()
          .items.some((item: { status: string }) => item.status === "triaged"),
      );
      assert.deepEqual(
        (await get(`${f.base}/alerts/${alerts[0]?.id}/evidence`)).json(),
        {
          ...evidence.json(),
          items: evidence.json().items.map((item: Record<string, unknown>) => ({
            ...item,
            rawAvailable: false,
          })),
        },
      );
      const first = (
        await get(`${f.base}/alerts/${alerts[0]?.id}/evidence?limit=1`)
      ).json();
      assert.ok(first.nextCursor);
      const second = (
        await get(
          `${f.base}/alerts/${alerts[0]?.id}/evidence?limit=1&cursor=${first.nextCursor}`,
        )
      ).json();
      assert.notEqual(first.items[0].id, second.items[0].id);
      assert.equal(
        (await get(`${f.base}/events/${first.items[0].id}`)).statusCode,
        404,
      );
    },
  );
  await scenario(
    "Only resolved, quiet alerts age out; active evidence and foreign scope survive",
    async () => {
      await f.owner.pool.query(
        "UPDATE alerts SET status='resolved' WHERE id=$1",
        [alerts[0]?.id],
      );
      const result = await retainProject(f.owner.pool, f.project, true);
      assert.equal(result.removed.alerts, 1);
      assert.ok((result.removed.evidence ?? 0) > 0);
      assert.equal((await get(`${f.base}/alerts`)).json().items.length, 2);
      assert.equal(
        (
          await f.owner.pool.query(
            "SELECT count(*) FROM projects WHERE id=$1",
            [f.foreignProject],
          )
        ).rows[0]?.count,
        "1",
      );
      assert.equal((await metric()).json().ingestion.accepted, 22);
    },
  );
  await scenario(
    "Audit retention is explicit, bounded, reversible and organization-scoped",
    async () => {
      for (const org of [f.org, f.foreignOrg])
        await f.owner.pool.query(
          "INSERT INTO audit_entries(organization_id,action,subject_id,details,created_at) VALUES($1,'project.created',$2,'{}',now()-interval '100 days')",
          [org, randomUUID()],
        );
      assert.equal(
        (await retainAudit(f.owner.pool, f.org, false, 1)).removed.audit,
        1,
      );
      assert.equal(
        (await retainAudit(f.owner.pool, f.org, true, 1)).removed.audit,
        1,
      );
      assert.equal(
        (
          await f.owner.pool.query(
            "SELECT count(*) FROM audit_entries WHERE organization_id=$1",
            [f.foreignOrg],
          )
        ).rows[0]?.count,
        "1",
      );
    },
  );
  console.log(`Operations and abuse integration: ${passed} scenarios passed.`);
} finally {
  await f.close();
}
