import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { type EventInput, SentinelClient } from "../src/index.js";

const key = `snt_ing_${randomUUID()}.${"a".repeat(43)}`;
const input: EventInput = {
  type: "auth.login_failed",
  action: "log_in",
  outcome: "failure",
  metadata: {},
};
function options() {
  return {
    endpoint: "http://127.0.0.1:3001/v1/ingest/events",
    ingestionKey: key,
    environment: "test" as const,
    flushIntervalMs: 0,
  };
}
function receipt(body: unknown, duplicates = false) {
  const events = JSON.parse(String(body)).events as { event_id: string }[];
  return new Response(
    JSON.stringify({
      accepted: duplicates ? [] : events.map((event) => event.event_id),
      duplicates: duplicates ? events.map((event) => event.event_id) : [],
    }),
    { status: 202 },
  );
}
describe("server SDK", () => {
  it("bounds count/bytes including in-flight items and snapshots caller data", async () => {
    let resolve: ((response: Response) => void) | undefined;
    let sent: unknown;
    const client = new SentinelClient(
      { ...options(), maxBufferedEvents: 1 },
      {
        fetch: async (_url, init) => {
          sent = init?.body;
          return new Promise<Response>((done) => {
            resolve = done;
          });
        },
      },
    );
    const event = { ...input, metadata: {} };
    expect(client.track(event)).toBe(true);
    const flush = client.flush();
    expect(client.flush()).toBe(flush);
    expect(client.track(input)).toBe(false);
    expect(client.stats().overflow).toBe(1);
    expect(JSON.stringify(client)).not.toContain(key);
    expect(JSON.stringify(client)).not.toContain("auth.login_failed");
    Object.assign(event.metadata, { password: "must-not-send" });
    expect(String(sent)).not.toContain("password");
    resolve?.(receipt(sent));
    await flush;
    expect(client.stats()).toMatchObject({
      accepted: 1,
      bufferedEvents: 0,
      bufferedBytes: 0,
    });
    await client.close();
    const tiny = new SentinelClient({ ...options(), maxBufferedBytes: 1 });
    expect(tiny.track(input)).toBe(false);
    expect(tiny.stats().overflow).toBe(1);
    await tiny.close();
  });
  it("retries a lost acknowledgement with identical IDs and counts deduplication", async () => {
    const bodies: string[] = [];
    const client = new SentinelClient(options(), {
      random: () => 0,
      fetch: async (_url, init) => {
        bodies.push(String(init?.body));
        if (bodies.length === 1)
          throw new Error("connection lost after server commit");
        expect(init?.redirect).toBe("error");
        return receipt(init?.body, true);
      },
    });
    client.track(input);
    await client.flush();
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
    expect(client.stats()).toMatchObject({
      duplicates: 1,
      retries: 1,
      failures: 1,
    });
    await client.close();
  });
  it("drops terminal failures, invalid payloads and exhausted attempts observably", async () => {
    const terminal = new SentinelClient(options(), {
      fetch: async () => new Response(null, { status: 401 }),
    });
    expect(
      terminal.track({
        ...input,
        metadata: { password: "forbidden" },
      } as EventInput),
    ).toBe(false);
    terminal.track(input);
    await terminal.flush();
    expect(terminal.stats()).toMatchObject({
      terminal: 1,
      invalid: 1,
      retries: 0,
    });
    expect(JSON.stringify(terminal.stats())).not.toContain(key);
    await terminal.close();
    const failed = new SentinelClient(
      { ...options(), maxAttempts: 2 },
      {
        random: () => 0,
        fetch: async () => new Response(null, { status: 503 }),
      },
    );
    failed.track(input);
    await failed.flush();
    expect(failed.stats()).toMatchObject({
      exhausted: 1,
      retries: 1,
      failures: 2,
    });
    await failed.close();
  });
  it("rejects missing/wrong/duplicate acknowledgements and oversized responses", async () => {
    for (const response of [
      () =>
        new Response(JSON.stringify({ accepted: [], duplicates: [] }), {
          status: 202,
        }),
      () =>
        new Response(
          JSON.stringify({ accepted: [randomUUID()], duplicates: [] }),
          { status: 202 },
        ),
      () => new Response("x".repeat(70_000), { status: 202 }),
    ]) {
      const client = new SentinelClient(
        { ...options(), maxAttempts: 1 },
        { fetch: async () => response() },
      );
      client.track(input);
      await client.flush();
      expect(client.stats()).toMatchObject({ accepted: 0, exhausted: 1 });
      await client.close();
    }
  });
  it("splits batches and respects Retry-After while close interrupts the wait", async () => {
    const sizes: number[] = [];
    const client = new SentinelClient(
      { ...options(), batchSize: 2 },
      {
        fetch: async (_url, init) => {
          sizes.push(JSON.parse(String(init?.body)).events.length);
          return receipt(init?.body);
        },
      },
    );
    for (let i = 0; i < 5; i++) client.track(input);
    await client.flush();
    expect(sizes).toEqual([2, 2, 1]);
    await client.close();
    let calls = 0;
    const limited = new SentinelClient(options(), {
      fetch: async () => {
        calls++;
        return new Response(null, {
          status: 429,
          headers: { "retry-after": "30" },
        });
      },
    });
    limited.track(input);
    const flushing = limited.flush();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await limited.close(30);
    await flushing;
    expect(calls).toBe(1);
    expect(limited.stats()).toMatchObject({
      retries: 1,
      closed: 1,
      bufferedEvents: 0,
    });
  });
  it("expires unsent data and rejects unsafe configuration without exposing credentials", async () => {
    let now = Date.now();
    const client = new SentinelClient(
      { ...options(), maxAgeMs: 100 },
      {
        now: () => now,
        fetch: async () => {
          throw new Error("must not send expired events");
        },
      },
    );
    client.track(input);
    now += 101;
    await client.flush();
    expect(client.stats()).toMatchObject({ expired: 1, failures: 0 });
    await client.close();
    expect(client.track(input)).toBe(false);
    expect(client.stats().closed).toBe(1);
    for (const endpoint of [
      "http://example.com/v1/ingest/events",
      "https://user:pass@example.com/v1/ingest/events",
      "https://example.com/v1/ingest/events?key=secret",
    ])
      expect(() => new SentinelClient({ ...options(), endpoint })).toThrow();
    expect(
      () => new SentinelClient({ ...options(), batchSize: 101 }),
    ).toThrow();
  });
  it("honors timeout and a bounded close against a real stalled HTTP server", async () => {
    const server = createServer((_request, _response) => {});
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing listener");
    const client = new SentinelClient({
      ...options(),
      endpoint: `http://127.0.0.1:${address.port}/v1/ingest/events`,
      timeoutMs: 50,
    });
    try {
      client.track(input);
      const flush = client.flush();
      await new Promise((resolve) => setTimeout(resolve, 80));
      await client.close(50);
      await flush;
      expect(client.stats()).toMatchObject({
        timeouts: 1,
        closed: 1,
        bufferedEvents: 0,
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
