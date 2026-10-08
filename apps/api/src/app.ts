import type { Writable } from "node:stream";
import swagger from "@fastify/swagger";
import { createDatabase } from "@sentinel/database";
import Fastify from "fastify";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { z } from "zod";
import type { ApiConfig } from "./config.js";

const statusSchema = z.strictObject({
  status: z.enum(["ok", "ready", "unavailable"]),
});

export async function buildApp(
  config: ApiConfig,
  dependencies?: { isReady: () => Promise<boolean>; logDestination?: Writable },
) {
  const app = Fastify({
    bodyLimit: 256 * 1024,
    requestTimeout: 10_000,
    trustProxy: false,
    logger:
      config.LOG_LEVEL === "silent"
        ? false
        : {
            level: config.LOG_LEVEL,
            ...(dependencies?.logDestination
              ? { stream: dependencies.logDestination }
              : {}),
            redact: {
              paths: [
                "req.headers.authorization",
                "req.headers.cookie",
                "res.headers['set-cookie']",
              ],
              censor: "[REDACTED]",
            },
            serializers: {
              // Avoid logging query strings, bodies or headers provided by a caller.
              req(request) {
                return {
                  method: request.method,
                  url: request.url.split("?")[0] ?? "/",
                };
              },
              err() {
                return {
                  type: "Error",
                  message: "Internal operation failed",
                  stack: "",
                };
              },
            },
          },
  });
  const database = dependencies
    ? undefined
    : createDatabase(config.API_DATABASE_URL);
  const isReady =
    dependencies?.isReady ??
    (async () => {
      const result = await database?.pool.query(
        "select to_regclass('public.events') is not null as ready",
      );
      return result?.rows[0]?.ready === true;
    });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(swagger, {
    openapi: {
      info: {
        title: "Sentinel API",
        version: "0.0.0",
        description:
          "M1 bootstrap: health endpoints only. Ingestion starts in M3.",
      },
    },
    transform: jsonSchemaTransform,
  });
  app.get(
    "/health/live",
    { schema: { response: { 200: statusSchema } } },
    async () => ({ status: "ok" as const }),
  );
  app.get(
    "/health/ready",
    { schema: { response: { 200: statusSchema, 503: statusSchema } } },
    async (_request, reply) => {
      try {
        if (await isReady()) return { status: "ready" as const };
      } catch {
        /* Readiness failure is deliberately generic. */
      }
      return reply.code(503).send({ status: "unavailable" as const });
    },
  );
  // No unauthenticated ingest or contract validation endpoint is exposed in M1.
  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ message: "Not found" });
  });
  app.setErrorHandler((error, request, reply) => {
    const errorStatus =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : 500;
    const status = errorStatus >= 400 && errorStatus < 500 ? errorStatus : 500;
    if (status === 500)
      request.log.error({ requestId: request.id }, "Request failed");
    const payload = {
      message: status === 500 ? "Internal server error" : "Invalid request",
    };
    reply.code(status).send(payload);
  });
  app.addHook("onClose", async () => {
    await database?.pool.end();
  });
  return app;
}
