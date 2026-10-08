import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { IdentityService } from "./identity.js";
import { AccessError } from "./security.js";

export async function registerOperationsRoutes(
  app: FastifyInstance,
  identity: IdentityService,
  read: preHandlerHookHandler[],
) {
  const count = z.number().nonnegative();
  app.withTypeProvider<ZodTypeProvider>().get(
    "/v1/organizations/:orgId/projects/:projectId/metrics",
    {
      preHandler: read,
      schema: {
        params: z.strictObject({ orgId: z.uuid(), projectId: z.uuid() }),
        querystring: z.strictObject({}),
        response: {
          200: z.strictObject({
            asOf: z.iso.datetime(),
            ingestion: z.strictObject({
              accepted: count,
              duplicates: count,
              batches: count,
            }),
            queue: z.strictObject({
              pending: count,
              processing: count,
              failed: count,
              completed24h: count,
              retried: count,
              oldestPendingSeconds: count.nullable(),
              completionP95Ms: count.nullable(),
            }),
          }),
        },
      },
    },
    async (request) => {
      if (!request.principal) throw new AccessError(401);
      const { orgId, projectId } = request.params;
      await identity.getProject(request.principal.userId, orgId, projectId);
      const role = (
        await identity.pool.query<{ role: string }>(
          "SELECT role FROM memberships WHERE user_id=$1 AND organization_id=$2 AND active=true",
          [request.principal.userId, orgId],
        )
      ).rows[0]?.role;
      if (!role || !["admin", "analyst"].includes(role))
        throw new AccessError(403);
      const row = (
        await identity.pool.query<Record<string, string | number | null>>(
          `
      SELECT now() AS at, coalesce(t.accepted,0) AS accepted,coalesce(t.duplicates,0) AS duplicates,coalesce(t.batches,0) AS batches,q.*
      FROM projects p LEFT JOIN ingestion_totals t ON t.project_id=p.id CROSS JOIN LATERAL (
        SELECT count(*) FILTER(WHERE status='pending') AS pending,count(*) FILTER(WHERE status='processing') AS processing,
          count(*) FILTER(WHERE status='failed') AS failed,count(*) FILTER(WHERE completed_at>=now()-interval '24 hours') AS completed,
          count(*) FILTER(WHERE attempts>1) AS retried,
          CASE WHEN count(*) FILTER(WHERE status='pending')>0 THEN greatest(0,extract(epoch FROM now()-min(created_at) FILTER(WHERE status='pending'))) END AS oldest,
          percentile_cont(0.95) WITHIN GROUP(ORDER BY greatest(0,extract(epoch FROM completed_at-created_at)*1000))
            FILTER(WHERE completed_at>=now()-interval '24 hours') AS latency
        FROM detection_jobs WHERE organization_id=$1 AND project_id=$2
      ) q WHERE p.organization_id=$1 AND p.id=$2`,
          [orgId, projectId],
        )
      ).rows[0];
      if (!row) throw new AccessError(404);
      return {
        asOf: new Date(String(row.at)).toISOString(),
        ingestion: {
          accepted: Number(row.accepted),
          duplicates: Number(row.duplicates),
          batches: Number(row.batches),
        },
        queue: {
          pending: Number(row.pending),
          processing: Number(row.processing),
          failed: Number(row.failed),
          completed24h: Number(row.completed),
          retried: Number(row.retried),
          oldestPendingSeconds: row.oldest === null ? null : Number(row.oldest),
          completionP95Ms: row.latency === null ? null : Number(row.latency),
        },
      };
    },
  );
}
