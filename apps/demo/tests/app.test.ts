import { randomUUID } from "node:crypto";
import { SentinelClient } from "@sentinel/sdk";
import { expect, it } from "vitest";
import { buildDemo } from "../src/app.js";
import { runScenario } from "../src/scenario.js";

it("keeps real login and role decisions available when Sentinel is unavailable", async () => {
  const passwords = { reader: randomUUID(), admin: randomUUID() };
  const sdk = new SentinelClient(
    {
      endpoint: "http://127.0.0.1:3001/v1/ingest/events",
      ingestionKey: `snt_ing_${randomUUID()}.${"a".repeat(43)}`,
      environment: "demo",
      flushIntervalMs: 0,
      maxAttempts: 1,
    },
    {
      fetch: async () => {
        throw new Error("unavailable");
      },
    },
  );
  const app = await buildDemo(sdk, passwords);
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing listener");
    expect(
      await runScenario(`http://127.0.0.1:${address.port}`, passwords),
    ).toMatchObject({ totalEvents: 22 });
    expect(sdk.stats().enqueued).toBe(22);
    await sdk.flush();
    expect(sdk.stats()).toMatchObject({ exhausted: 22, bufferedEvents: 0 });
    const forbidden = await app.inject({
      method: "POST",
      url: "/login",
      payload: { username: "reader", password: passwords.reader },
    });
    expect(forbidden.statusCode).toBe(403);
    expect((await app.inject("/lab/metrics")).body).not.toContain(
      passwords.reader,
    );
  } finally {
    await app.close();
  }
});
