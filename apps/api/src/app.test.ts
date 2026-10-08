import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { readConfig } from "./config.js";

const config = readConfig({
  API_DATABASE_URL: "postgresql://test:test@localhost:5432/test",
  LOG_LEVEL: "silent",
  NODE_ENV: "test",
});

describe("bootstrap API", () => {
  it("keeps liveness available while readiness fails without exposing errors", async () => {
    const app = await buildApp(config, {
      isReady: async () => {
        throw new Error("password=must-not-leak");
      },
    });
    try {
      expect((await app.inject("/health/live")).json()).toEqual({
        status: "ok",
      });
      const response = await app.inject("/health/ready");
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ status: "unavailable" });
      expect(response.body).not.toContain("must-not-leak");
    } finally {
      await app.close();
    }
  });
  it("advertises readiness and generates OpenAPI from the actual routes", async () => {
    const app = await buildApp(config, { isReady: async () => true });
    try {
      expect((await app.inject("/health/ready")).json()).toEqual({
        status: "ready",
      });
      expect(app.swagger().paths).toHaveProperty("/health/live");
      expect(app.swagger().paths).toHaveProperty("/health/ready");
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/v1/ingest/events",
            payload: {},
          })
        ).statusCode,
      ).toBe(404);
    } finally {
      await app.close();
    }
  });
  it("does not include input values in configuration errors", () => {
    expect(() =>
      readConfig({ API_DATABASE_URL: "secret-db-password" }),
    ).toThrow("Invalid configuration: API_DATABASE_URL");
  });
  it("keeps headers, query secrets and bodies out of request logs", async () => {
    let output = "";
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const app = await buildApp(
      { ...config, LOG_LEVEL: "info" },
      { isReady: async () => true, logDestination: stream },
    );
    try {
      await app.inject({
        method: "POST",
        url: "/unknown?token=query-secret",
        headers: {
          authorization: "Bearer header-secret",
          cookie: "session=cookie-secret",
        },
        payload: { password: "body-secret" },
      });
      for (const secret of [
        "query-secret",
        "header-secret",
        "cookie-secret",
        "body-secret",
      ])
        expect(output).not.toContain(secret);
      expect(output).toContain("incoming request");
    } finally {
      await app.close();
    }
  });
});
