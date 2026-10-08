import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { ApiConfig } from "./config.js";
import type { IdentityService } from "./identity.js";
import { AccessError } from "./security.js";

const params = z.strictObject({ orgId: z.uuid(), projectId: z.uuid() });
const query = z.strictObject({
  environment: z
    .enum(["demo", "development", "test", "staging", "production"])
    .optional(),
});
const integer = z.number().int().nonnegative();
const overviewSchema = z.strictObject({
  asOf: z.iso.datetime(),
  since: z.iso.datetime(),
  events24h: integer,
  openAlerts: integer,
  triagedAlerts: integer,
  resolvedAlerts: integer,
  pendingJobs: integer,
  failedJobs: integer,
  lastReceivedAt: z.iso.datetime().nullable(),
  activity: z
    .array(z.strictObject({ hour: z.iso.datetime(), count: integer }))
    .length(24),
});

export async function registerLiveRoutes(
  app: FastifyInstance,
  config: ApiConfig,
  identity: IdentityService,
  read: preHandlerHookHandler[],
) {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const base = "/v1/organizations/:orgId/projects/:projectId";
  const streams = new Map<string, Set<() => void>>();
  const cookieName =
    new URL(config.APP_ORIGIN).protocol === "https:"
      ? "__Host-sentinel_session"
      : "sentinel_session";
  let total = 0;
  api.get(
    `${base}/overview`,
    {
      preHandler: read,
      schema: { params, querystring: query, response: { 200: overviewSchema } },
    },
    async (request) => {
      if (!request.principal) throw new AccessError(401);
      const { orgId, projectId } = request.params;
      await identity.getProject(request.principal.userId, orgId, projectId);
      const asOf = new Date(),
        end = new Date(asOf.getTime() - 3600_000);
      const since = new Date(asOf.getTime() - 24 * 3600_000);
      // One statement gives counts and histogram the same database snapshot.
      const result = await identity.pool.query<{
        events: number;
        open: number;
        triaged: number;
        resolved: number;
        pending: number;
        failed: number;
        last: Date | null;
        activity: { hour: string; count: number }[];
      }>(
        `WITH scoped_events AS (
      SELECT received_at,event_id FROM events WHERE organization_id=$1 AND project_id=$2 AND (environment=$3 OR $3::text IS NULL)
    ), scoped_alerts AS (
      SELECT status FROM alerts WHERE organization_id=$1 AND project_id=$2 AND (environment=$3 OR $3::text IS NULL)
    ), hours AS (SELECT generate_series($4::timestamptz,$5::timestamptz,interval '1 hour') AS hour),
    buckets AS (SELECT date_bin(interval '1 hour',received_at,$4) AS hour,count(*)::int AS count FROM scoped_events WHERE received_at>=$4 AND received_at<$6 GROUP BY 1),
    jobs AS (SELECT j.status FROM detection_jobs j JOIN events e ON (e.organization_id,e.project_id,e.event_id)=(j.organization_id,j.project_id,j.event_id) WHERE j.organization_id=$1 AND j.project_id=$2 AND (e.environment=$3 OR $3::text IS NULL))
    SELECT (SELECT count(*)::int FROM scoped_events WHERE received_at>=$4 AND received_at<$6) AS events,
      (SELECT count(*)::int FROM scoped_alerts WHERE status='open') AS open,
      (SELECT count(*)::int FROM scoped_alerts WHERE status='triaged') AS triaged,
      (SELECT count(*)::int FROM scoped_alerts WHERE status='resolved') AS resolved,
      (SELECT count(*)::int FROM jobs WHERE status IN ('pending','processing')) AS pending,
      (SELECT count(*)::int FROM jobs WHERE status='failed') AS failed,
      (SELECT max(received_at) FROM scoped_events) AS last,
      (SELECT jsonb_agg(jsonb_build_object('hour',to_char(hours.hour AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'count',coalesce(buckets.count,0)) ORDER BY hours.hour) FROM hours LEFT JOIN buckets USING(hour)) AS activity`,
        [orgId, projectId, request.query.environment ?? null, since, end, asOf],
      );
      const row = result.rows[0];
      if (!row) throw new AccessError(503);
      return {
        asOf: asOf.toISOString(),
        since: since.toISOString(),
        events24h: row.events,
        openAlerts: row.open,
        triagedAlerts: row.triaged,
        resolvedAlerts: row.resolved,
        pendingJobs: row.pending,
        failedJobs: row.failed,
        lastReceivedAt: row.last?.toISOString() ?? null,
        activity: row.activity,
      };
    },
  );

  api.get(
    `${base}/stream`,
    {
      preHandler: async (request) => {
        if (request.headers["sec-fetch-site"] === "cross-site")
          throw new AccessError(403);
        // Even automatic reconnections must not extend an idle session.
        request.principal = await identity.authenticate(
          request.cookies[cookieName],
          false,
        );
      },
      schema: { params, querystring: z.strictObject({}) },
    },
    async (request, reply) => {
      if (!request.principal) throw new AccessError(401);
      if (
        request.headers.origin &&
        request.headers.origin !== config.APP_ORIGIN
      )
        throw new AccessError(403);
      const { userId } = request.principal,
        { orgId, projectId } = request.params;
      await identity.getProject(userId, orgId, projectId);
      const current = streams.get(userId) ?? new Set<() => void>();
      if (current.size >= 3 || total >= 64) throw new AccessError(429, 5);
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Accel-Buffering": "no",
      });
      let closed = false,
        busy = false,
        previous = "",
        ticks = 0;
      const stop = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        current.delete(stop);
        total--;
        if (!current.size) streams.delete(userId);
        reply.raw.end();
      };
      const send = (event: string) => {
        if (!closed && !reply.raw.write(`event: ${event}\ndata: {}\n\n`))
          stop();
      };
      const tick = async () => {
        if (busy || closed) return;
        busy = true;
        try {
          const token = request.cookies[cookieName];
          await identity.authenticate(token, false);
          await identity.getProject(userId, orgId, projectId);
          const result = await identity.pool.query(
            `SELECT
          (SELECT jsonb_build_array(count(*),coalesce(max(ingest_order),0)) FROM events WHERE organization_id=$1 AND project_id=$2) AS events,
          (SELECT jsonb_build_array(count(*),coalesce(sum(status_version),0),coalesce(sum(peak_count),0),max(updated_at)) FROM alerts WHERE organization_id=$1 AND project_id=$2) AS alerts,
          (SELECT jsonb_build_array(count(*) FILTER(WHERE status IN ('pending','processing')),count(*) FILTER(WHERE status='failed'),count(*) FILTER(WHERE status='completed')) FROM detection_jobs WHERE organization_id=$1 AND project_id=$2) AS jobs,
          (SELECT role FROM memberships WHERE organization_id=$1 AND user_id=$3 AND active=true) AS role`,
            [orgId, projectId, userId],
          );
          const next = JSON.stringify(result.rows[0]);
          if (next !== previous) {
            previous = next;
            send("refresh");
          } else send("heartbeat");
          if (++ticks >= 150) stop(); // Bounded lifetime; reconnect always re-queries durable state.
        } catch (error) {
          send(
            error instanceof AccessError &&
              [401, 403, 404].includes(error.statusCode)
              ? "access-lost"
              : "unavailable",
          );
          stop();
        } finally {
          busy = false;
        }
      };
      const timer = setInterval(() => {
        void tick();
      }, 2000);
      timer.unref();
      current.add(stop);
      streams.set(userId, current);
      total++;
      reply.raw.on("close", stop);
      reply.raw.on("error", stop);
      reply.raw.write("retry: 3000\n\n");
      void tick();
      return reply;
    },
  );
  app.addHook("preClose", async () => {
    for (const active of [...streams.values()])
      for (const stop of [...active]) stop();
  });
}
