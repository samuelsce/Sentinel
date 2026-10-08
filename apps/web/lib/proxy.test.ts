import { describe, expect, it, vi } from "vitest";
import { proxy } from "./proxy";

const id = "11111111-1111-4111-8111-111111111111";
const path = ["v1", "organizations", id, "projects", id, "overview"];
describe("same-origin API boundary", () => {
  it("rejects arbitrary destinations, traversal and machine ingestion", async () => {
    const transport = vi.fn<typeof fetch>();
    for (const route of [
      ["https://evil.invalid"],
      ["..", "v1", "auth", "session"],
      ["v1", "ingest", "events"],
    ]) {
      expect(
        (
          await proxy(
            new Request("http://localhost/api"),
            route,
            "http://api",
            transport,
          )
        ).status,
      ).toBe(404);
    }
    expect(transport).not.toHaveBeenCalled();
  });
  it("preserves browser security headers without forging trust or origin", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({}));
    await proxy(
      new Request("http://localhost/api?environment=demo", {
        headers: {
          cookie: "sentinel_session=fake",
          origin: "https://foreign.invalid",
          "sec-fetch-site": "cross-site",
          "x-csrf-token": "fake",
          "x-forwarded-for": "1.2.3.4",
          authorization: "ignored",
        },
      }),
      path,
      "http://api",
      transport,
    );
    const [url, init] = transport.mock.calls[0] ?? [];
    expect(url).toBe(`http://api/${path.join("/")}?environment=demo`);
    const headers = new Headers(init?.headers);
    expect(headers.get("origin")).toBe("https://foreign.invalid");
    expect(headers.get("sec-fetch-site")).toBe("cross-site");
    expect(headers.get("x-forwarded-for")).toBeNull();
    expect(headers.get("authorization")).toBeNull();
    expect(init?.redirect).toBe("manual");
  });
  it("forwards HttpOnly cookies and retry metadata without caching", async () => {
    const cookie = "sentinel_session=fake; Path=/; HttpOnly; SameSite=Lax";
    const response = await proxy(
      new Request("http://localhost/api"),
      path,
      "http://api",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(null, {
          status: 429,
          headers: { "set-cookie": cookie, "retry-after": "5" },
        }),
      ),
    );
    expect(response.headers.getSetCookie()).toEqual([cookie]);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("retry-after")).toBe("5");
  });
  it("bounds mutation bodies and suppresses redirects and upstream errors", async () => {
    const transport = vi.fn<typeof fetch>();
    const big = new Request("http://localhost/api", {
      method: "POST",
      body: "x".repeat(8193),
    });
    expect(
      (await proxy(big, ["v1", "auth", "login"], "http://api", transport))
        .status,
    ).toBe(413);
    expect(transport).not.toHaveBeenCalled();
    transport.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "https://foreign.invalid" },
      }),
    );
    expect(
      (
        await proxy(
          new Request("http://localhost/api"),
          path,
          "http://api",
          transport,
        )
      ).status,
    ).toBe(502);
    transport.mockRejectedValueOnce(new Error("secret database URL"));
    const unavailable = await proxy(
      new Request("http://localhost/api"),
      path,
      "http://api",
      transport,
    );
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).not.toContain("secret");
  });
  it("cancels upstream streams when the browser disconnects", async () => {
    let signal: AbortSignal | null | undefined;
    let canceled = false;
    const response = await proxy(
      new Request("http://localhost/api"),
      path,
      "http://api",
      async (_url, init) => {
        signal = init?.signal;
        return new Response(
          new ReadableStream({
            cancel() {
              canceled = true;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    );
    await response.body?.cancel();
    expect(signal?.aborted).toBe(true);
    expect(canceled).toBe(true);
  });
});
