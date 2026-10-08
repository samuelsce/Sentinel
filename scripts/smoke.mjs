import assert from "node:assert/strict";

const api = process.env.SMOKE_API_URL ?? "http://127.0.0.1:3001";
const web = process.env.SMOKE_WEB_URL ?? "http://127.0.0.1:3000";
const unavailable = process.argv.includes("--expect-unavailable");
for (const [route, expected] of [
  ["/health/live", "ok"],
  ["/health/ready", "ready"],
]) {
  const response = await fetch(`${api}${route}`, {
    signal: AbortSignal.timeout(5_000),
  });
  const failingReadiness = unavailable && route === "/health/ready";
  assert.equal(response.status, failingReadiness ? 503 : 200);
  assert.deepEqual(await response.json(), {
    status: failingReadiness ? "unavailable" : expected,
  });
}
const response = await fetch(web, { signal: AbortSignal.timeout(10_000) });
assert.equal(response.status, 200);
const html = await response.text();
assert.ok(
  html.includes(unavailable ? "Conexão indisponível" : "Ambiente conectado"),
  "Web should show the real API readiness state",
);
assert.ok(
  html.includes("Dashboard e investigação ao vivo disponíveis"),
  "Home must describe the implemented dashboard",
);
console.log(
  unavailable
    ? "Smoke passed: liveness stays available, readiness returns 503 and web reports the outage."
    : "Smoke passed: API liveness/readiness and web connected state.",
);
