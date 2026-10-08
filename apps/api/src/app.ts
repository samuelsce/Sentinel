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
import { IdentityService } from "./identity.js";
import { IngestionService, registerIngestionRoutes } from "./ingestion.js";
import { registerIdentityRoutes } from "./routes.js";
import { AccessError } from "./security.js";

const statusSchema = z.strictObject({
  status: z.enum(["ok", "ready", "unavailable"]),
});

export async function buildApp(
  config: ApiConfig,
  dependencies?: {
    isReady: () => Promise<boolean>;
    logDestination?: Writable;
    identity?: IdentityService;
    ingestion?: IngestionService;
  },
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
                  route: request.routeOptions?.url ?? "/unmatched",
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
        "select to_regclass('public.events') is not null and to_regclass('public.sessions') is not null and to_regclass('public.login_buckets') is not null and to_regclass('public.audit_entries') is not null and to_regclass('public.ingestion_quotas') is not null and to_regclass('public.ingestion_totals') is not null and to_regclass('public.alerts') is not null and to_regclass('public.rule_definitions') is not null and exists(select 1 from information_schema.columns where table_schema='public' and table_name='alert_evidence' and column_name='payload') and exists(select 1 from information_schema.columns where table_schema='public' and table_name='detection_jobs' and column_name='event_ingest_order') as ready",
      );
      return result?.rows[0]?.ready === true;
    });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(swagger, {
    openapi: {
      info: {
        title: "Sentinel API",
        version: "0.1.0",
        description:
          "Identity, scoped ingestion, snapshot investigation, pipeline metrics and authenticated live notifications.",
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
  const identity =
    dependencies?.identity ??
    (database ? new IdentityService(database.pool) : undefined);
  if (identity) await registerIdentityRoutes(app, config, identity);
  const ingestion =
    dependencies?.ingestion ??
    (identity ? new IngestionService(identity.pool) : undefined);
  if (ingestion) await registerIngestionRoutes(app, ingestion);
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
    const status =
      errorStatus >= 400 &&
      (errorStatus < 500 ||
        (error instanceof AccessError && errorStatus === 503))
        ? errorStatus
        : 500;
    if (error instanceof AccessError && error.retryAfter)
      reply.header("Retry-After", error.retryAfter);
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
