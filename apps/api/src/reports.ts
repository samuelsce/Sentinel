import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { audit, type IdentityService, transaction } from "./identity.js";
import { projectScope } from "./response.js";
import { AccessError } from "./security.js";

// Construct an allowlisted projection; never redact arbitrary JSON after serialization.
export async function investigationReport(
  identity: IdentityService,
  user: string,
  org: string,
  project: string,
  alertId: string,
) {
  return transaction(identity.pool, async (client) => {
    await projectScope(client, user, org, project, "read");
    const alert = (
      await client.query(
        "SELECT a.*,d.definition FROM alerts a JOIN rule_definitions d ON (a.rule_code,a.rule_version)=(d.code,d.version) WHERE a.organization_id=$1 AND a.project_id=$2 AND a.id=$3 FOR SHARE OF a",
        [org, project, alertId],
      )
    ).rows[0];
    if (!alert) throw new AccessError(404);
    const rows = (
      await client.query(
        "SELECT event_id,payload,host((payload->>'source_ip')::inet) AS source_identity,received_at,role,EXISTS(SELECT 1 FROM events e WHERE (e.organization_id,e.project_id,e.event_id)=(ae.organization_id,ae.project_id,ae.event_id)) AS raw_available FROM alert_evidence ae WHERE organization_id=$1 AND project_id=$2 AND alert_id=$3 ORDER BY received_at,ingest_order LIMIT 200",
        [org, project, alertId],
      )
    ).rows;
    const pseudonyms = new Map<string, string>();
    const label = (kind: string, value: unknown) => {
      if (typeof value !== "string") return null;
      const key = `${kind}:${value}`;
      if (!pseudonyms.has(key))
        pseudonyms.set(
          key,
          `${kind}-${[...pseudonyms.keys()].filter((item) => item.startsWith(`${kind}:`)).length + 1}`,
        );
      return pseudonyms.get(key);
    };
    for (const row of rows) label("event", row.event_id);
    const decision = (value: Record<string, unknown>) => ({
      timeBasis: "received_at",
      windowSeconds: value.windowSeconds,
      threshold: value.threshold,
      count: value.count,
      windowStart: value.windowStart,
      windowEnd: value.windowEnd,
      reason: value.reason,
      trigger: label("event", value.triggerEventId),
    });
    const evidence = rows.map((row) => ({
      event: label("event", row.event_id),
      role: row.role,
      receivedAt: row.received_at.toISOString(),
      occurredAt: row.payload.occurred_at,
      type: row.payload.type,
      action: row.payload.action,
      outcome: row.payload.outcome,
      actor: label("actor", row.payload.actor_id),
      source: label("ip", row.source_identity),
      rawAvailable: row.raw_available,
    }));
    const responses = (
      await client.query(
        "SELECT CASE WHEN state IN ('requested','applied') AND expires_at<=clock_timestamp() THEN 'expired' ELSE state END AS state,count(*)::integer AS count FROM response_actions WHERE organization_id=$1 AND project_id=$2 AND alert_id=$3 GROUP BY 1",
        [org, project, alertId],
      )
    ).rows;
    await audit(client, org, user, "report.exported", alertId, {
      evidenceCount: evidence.length,
    });
    return {
      format: "sentinel.investigation.v1",
      generatedAt: new Date().toISOString(),
      privacy:
        "Report-local pseudonyms; identifiers, IPs, resources, metadata, credentials and response reasons omitted. Timestamps remain; review before sharing.",
      environment: alert.environment,
      rule: {
        code: alert.rule_code,
        version: alert.rule_version,
        threshold: alert.definition.threshold,
        windowSeconds: alert.definition.windowSeconds,
      },
      investigation: {
        status: alert.status,
        severity: alert.severity,
        peakCount: alert.peak_count,
        evidenceTruncated: alert.evidence_truncated,
        initialDecision: decision(alert.initial_decision),
        lastDecision: decision(alert.last_decision),
      },
      evidence,
      responses,
    };
  });
}
export async function registerReportRoutes(
  app: FastifyInstance,
  identity: IdentityService,
  read: preHandlerHookHandler[],
) {
  app.withTypeProvider<ZodTypeProvider>().get(
    "/v1/organizations/:orgId/projects/:projectId/alerts/:alertId/report",
    {
      preHandler: read,
      schema: {
        params: z.strictObject({
          orgId: z.uuid(),
          projectId: z.uuid(),
          alertId: z.uuid(),
        }),
        querystring: z.strictObject({}),
        tags: ["Investigation reports"],
      },
    },
    async (req, reply) => {
      if (!req.principal) throw new AccessError(401);
      const result = await investigationReport(
        identity,
        req.principal.userId,
        req.params.orgId,
        req.params.projectId,
        req.params.alertId,
      );
      return reply
        .header(
          "Content-Disposition",
          'attachment; filename="sentinel-investigation.json"',
        )
        .send(result);
    },
  );
}
