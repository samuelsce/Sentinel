import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fixture } from "./m5-fixture.js";

// Dedicated disposable project in sentinel_test; no production data or quotas are changed.
const f = await fixture();
const python = resolve(
  "services/detector/.venv",
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
);
const detectorUrl = new URL(process.env.TEST_DATABASE_URL ?? "");
detectorUrl.username = "sentinel_detector";
detectorUrl.password = process.env.SENTINEL_DETECTOR_DB_PASSWORD ?? "";
let worker = spawn(
  python,
  ["-m", "sentinel_detector.worker", "--project", f.project],
  {
    cwd: resolve("services/detector"),
    env: { ...process.env, DETECTOR_DATABASE_URL: detectorUrl.href },
    stdio: "ignore",
  },
);
const spawnWorker = () =>
  spawn(python, ["-m", "sentinel_detector.worker", "--project", f.project], {
    cwd: resolve("services/detector"),
    env: { ...process.env, DETECTOR_DATABASE_URL: detectorUrl.href },
    stdio: "ignore",
  });
const stopWorker = async () => {
  const done = new Promise<void>((resolveDone) =>
    worker.once("exit", () => resolveDone()),
  );
  worker.kill();
  await done;
};
const quantiles = (samples: number[]) => {
  const ordered = [...samples].sort((a, b) => a - b);
  return {
    samples: samples.length,
    p50Ms: ordered[Math.floor((ordered.length - 1) * 0.5)],
    p95Ms: ordered[Math.ceil((ordered.length - 1) * 0.95)],
  };
};
const event = () => ({
  schema_version: 1,
  event_id: randomUUID(),
  occurred_at: new Date().toISOString(),
  environment: "demo",
  type: "auth.login_succeeded",
  action: "log_in",
  outcome: "success",
  actor_id: "lab-benign",
  metadata: {},
});
const ids = new Set<string>();
const ingestion: number[] = [],
  detection: number[] = [],
  queries: number[] = [];
let rejected = 0,
  maxBacklog = 0;
const send = async (events: ReturnType<typeof event>[]) => {
  const start = performance.now();
  const response = await fetch(`${f.api}/v1/ingest/events`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${f.key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ events }),
    signal: AbortSignal.timeout(10000),
  });
  ingestion.push(performance.now() - start);
  if (response.status !== 202) {
    rejected += events.length;
    await response.body?.cancel();
    return;
  }
  const receipt = (await response.json()) as {
    accepted: string[];
    duplicates: string[];
  };
  for (const id of receipt.accepted) ids.add(id);
};
try {
  const { cookie } = await f.login();
  const get = async (path: string) => {
    const r = await fetch(`${f.api}${f.base}${path}`, {
      headers: { cookie },
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(r.status, 200);
    return r.json();
  };
  for (let n = 1; n <= 10; n++) {
    const events = Array.from({ length: 5 }, () => ({
      ...event(),
      type: "auth.login_failed",
      outcome: "failure",
      source_ip: `192.0.2.${n}`,
    }));
    await send(events);
    const start = performance.now();
    let visible = false;
    for (let poll = 0; poll < 600; poll++) {
      const page = (await get("/alerts?limit=100")) as {
        items: { correlation: { value: string } }[];
      };
      if (page.items.some((a) => a.correlation.value === `192.0.2.${n}`)) {
        visible = true;
        break;
      }
      await delay(100);
    }
    assert.ok(
      visible,
      "Threshold event did not become an API-visible alert in 60s",
    );
    detection.push(performance.now() - start);
  }
  // Isolate measurement phases: test operator resets only this fixture's quota bucket.
  await f.owner.pool.query("DELETE FROM ingestion_quotas WHERE project_id=$1", [
    f.project,
  ]);
  const loadStart = performance.now();
  let restartDrainMs: number | null = null;
  for (let batch = 0; batch < 300; batch++) {
    await delay(Math.max(0, loadStart + batch * 2000 - performance.now()));
    if (batch === 150) await stopWorker();
    if (batch === 153) {
      const at = performance.now();
      worker = spawnWorker();
      for (let p = 0; p < 600; p++) {
        const row = await f.owner.pool.query<{ count: string }>(
          "SELECT count(*) FROM detection_jobs WHERE project_id=$1 AND status IN ('pending','processing')",
          [f.project],
        );
        if (Number(row.rows[0]?.count) === 0) {
          restartDrainMs = performance.now() - at;
          break;
        }
        await delay(100);
      }
    }
    await send(Array.from({ length: 100 }, event));
    const q = await f.owner.pool.query<{ count: string }>(
      "SELECT count(*) FROM detection_jobs WHERE project_id=$1 AND status IN ('pending','processing')",
      [f.project],
    );
    maxBacklog = Math.max(maxBacklog, Number(q.rows[0]?.count));
    if (batch % 30 === 0)
      console.log(
        `Load ${batch * 2}/600s; confirmed ${ids.size}; rejected ${rejected}; backlog ${q.rows[0]?.count}`,
      );
  }
  await delay(Math.max(0, loadStart + 600000 - performance.now()));
  const durationSeconds = (performance.now() - loadStart) / 1000;
  const drainAt = performance.now();
  let drained = false;
  for (let p = 0; p < 1200; p++) {
    const row = await f.owner.pool.query<{ count: string }>(
      "SELECT count(*) FROM detection_jobs WHERE project_id=$1 AND status IN ('pending','processing')",
      [f.project],
    );
    if (Number(row.rows[0]?.count) === 0) {
      drained = true;
      break;
    }
    await delay(100);
  }
  const drainMs = performance.now() - drainAt;
  const stored = await f.owner.pool.query<{ event_id: string }>(
    "SELECT event_id FROM events WHERE project_id=$1",
    [f.project],
  );
  assert.equal(stored.rowCount, ids.size);
  assert.ok(
    stored.rows.every((row) => ids.has(row.event_id)),
    "Confirmed identifiers differ from persisted identifiers",
  );
  const metrics = await get("/metrics");
  await stopWorker();
  // Query target uses a 100k-row corpus. Additional benign rows are synthetic SQL fixtures,
  // explicitly separate from measured real HTTP ingestion (which is never bulk inserted).
  const keyId = f.key.slice(8, 44);
  const corpus = await f.owner.pool.connect();
  try {
    await corpus.query("BEGIN");
    await corpus.query("SET LOCAL statement_timeout='120s'");
    await corpus.query(
      `INSERT INTO events(organization_id,project_id,event_id,ingestion_key_id,environment,type,actor_id,occurred_at,payload)
    SELECT $1,$2,id,$3,'demo','auth.login_succeeded','lab-benign',now(),
      jsonb_build_object('schema_version',1,'event_id',id,'occurred_at',to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'environment','demo','type','auth.login_succeeded','action','log_in','outcome','success','actor_id','lab-benign','metadata','{}'::jsonb)
    FROM (SELECT gen_random_uuid() id FROM generate_series(1,$4::integer)) s`,
      [f.org, f.project, keyId, 100000 - ids.size],
    );
    await corpus.query("COMMIT");
  } catch (error) {
    await corpus.query("ROLLBACK");
    throw error;
  } finally {
    corpus.release();
  }
  await f.owner.pool.query("ANALYZE events");
  for (let i = 0; i < 100; i++) {
    const start = performance.now();
    const page = (await get("/events?limit=50")) as { items: unknown[] };
    assert.equal(page.items.length, 50);
    queries.push(performance.now() - start);
  }
  const report = {
    measuredAt: new Date().toISOString(),
    environment: {
      os: process.platform,
      node: process.version,
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      memoryGiB: Math.round(totalmem() / 1024 ** 3),
    },
    configuration: {
      seconds: 600,
      eventsPerSecond: 50,
      batchSize: 100,
      singleWorker: true,
      restartAfterSeconds: 300,
      interruptionSeconds: 6,
      queryCorpus: 100000,
    },
    load: {
      durationSeconds,
      confirmed: ids.size,
      rejected,
      persisted: stored.rowCount,
      maxBacklog,
      drained,
      drainMs,
      restartDrainMs,
    },
    ingestion: quantiles(ingestion),
    alertApiVisibility: quantiles(detection),
    eventQueries: quantiles(queries),
    metrics,
  };
  await mkdir("docs/validation", { recursive: true });
  await writeFile(
    "docs/validation/m6-lab.json",
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(JSON.stringify(report));
} finally {
  if (worker.exitCode === null && worker.signalCode === null)
    await stopWorker();
  await f.close();
}
