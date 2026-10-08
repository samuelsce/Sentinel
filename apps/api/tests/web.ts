import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fixture } from "./m5-fixture.js";

const f = await fixture();
const web = spawn(
  process.execPath,
  [
    resolve("apps/web/node_modules/next/dist/bin/next"),
    "start",
    "-H",
    "127.0.0.1",
    "-p",
    "3300",
  ],
  {
    cwd: resolve("apps/web"),
    env: {
      ...process.env,
      API_INTERNAL_URL: f.api,
      NEXT_TELEMETRY_DISABLED: "1",
    },
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
  },
);
web.stderr.on("data", () => {}); // App errors are asserted via HTTP; never emit runtime environment values.
try {
  await f.seed();
  const deadline = Date.now() + 30_000;
  for (;;) {
    assert.equal(web.exitCode, null, "Web exited before readiness");
    try {
      if (
        (
          await fetch("http://localhost:3300/login", {
            signal: AbortSignal.timeout(1000),
          })
        ).ok
      )
        break;
    } catch {}
    assert.ok(Date.now() < deadline, "Web readiness timed out");
    await delay(200);
  }
  const child = spawn(
    process.execPath,
    [
      resolve("node_modules/@playwright/test/cli.js"),
      "test",
      "--max-failures=1",
    ],
    {
      env: {
        ...process.env,
        M5_FIXTURE: JSON.stringify({
          credentials: f.credentials,
          api: f.api,
          base: f.base,
          key: f.key,
          org: f.org,
          project: f.project,
          foreignOrg: f.foreignOrg,
          foreignProject: f.foreignProject,
        }),
      },
      windowsHide: true,
      stdio: "inherit",
    },
  );
  const code = await new Promise<number | null>((res, rej) => {
    child.on("error", rej);
    child.on("exit", res);
  });
  assert.equal(code, 0, "Browser validation failed");
} finally {
  web.kill();
  if (web.exitCode === null)
    await new Promise<void>((res) => web.once("exit", () => res()));
  await f.close();
}
