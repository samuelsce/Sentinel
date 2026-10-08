import { createHash } from "node:crypto";
import { type SecurityEvent, securityEventSchema } from "@sentinel/contracts";
import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { audit, type IdentityService, transaction } from "./identity.js";
import { AccessError } from "./security.js";

const id = z.uuid();
const date = z.iso.datetime();
const environment = z.enum([
  "demo",
  "development",
  "test",
  "staging",
  "production",
]);
const status = z.enum(["open", "triaged", "resolved"]);
const code = z.enum(["AUTH-001", "AUTHZ-001", "ADMIN-001"]);
const decision = z.strictObject({
  timeBasis: z.literal("received_at"),
  windowSeconds: z.number().int().positive(),
  threshold: z.number().int().nonnegative(),
  windowStart: date,
  windowEnd: date,
  count: z.number().int().nonnegative(),
  triggerEventId: id,
  reason: z.enum([
    "threshold",
    "privilege_change",
    "critical_action_after_failures",
  ]),
});
const eventView = z.strictObject({
  id,
  receivedAt: date,
  payload: securityEventSchema,
});
const alertView = z.strictObject({
  id,
  environment,
  ruleCode: code,
  ruleVersion: z.number().int().positive(),
  severity: z.enum(["high", "medium"]),
  status,
  statusVersion: z.number().int().positive(),
  correlation: z.strictObject({
    kind: z.enum(["ip", "actor"]),
    value: z.string().max(128),
  }),
  episode: z.strictObject({
    id,
    startedAt: date,
    lastRelevantAt: date,
    endedAt: date.nullable(),
    totalRelevant: z.number().int().nonnegative(),
  }),
  initialDecision: decision,
  lastDecision: decision,
  peakCount: z.number().int().nonnegative(),
  evidenceTruncated: z.boolean(),
  initialTriggerRawAvailable: z.boolean(),
  lastTriggerRawAvailable: z.boolean(),
  createdAt: date,
  updatedAt: date,
});
const ruleView = z.strictObject({
  code,
  version: z.number().int().positive(),
  title: z.string(),
  severity: z.enum(["high", "medium"]),
  windowSeconds: z.number().int().positive(),
  threshold: z.number().int().positive(),
  criticalActions: z.array(z.string()),
});
const params = z.strictObject({ orgId: id, projectId: id });
const paging = {
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .max(1024)
    .optional(),
};
const eventQuery = z
  .strictObject({
    ...paging,
    environment: environment.optional(),
    type: z
      .enum([
        "auth.login_failed",
        "auth.login_succeeded",
        "authz.access_denied",
        "admin.action",
        "admin.privilege_changed",
      ])
      .optional(),
    from: date.optional(),
    to: date.optional(),
  })
  .refine((q) => !q.from || !q.to || Date.parse(q.from) <= Date.parse(q.to));
const alertQuery = z.strictObject({
  ...paging,
  environment: environment.optional(),
  ruleCode: code.optional(),
  status: status.optional(),
});
const jobStatus = z.enum(["pending", "processing", "completed", "failed"]);
const jobQuery = z.strictObject({
  ...paging,
  status: jobStatus.default("failed"),
});
const jobView = z.strictObject({
  id,
  eventId: id,
  status: jobStatus,
  attempts: z.number().int().nonnegative(),
  availableAt: date,
  leasedUntil: date.nullable(),
  lastErrorCode: z
    .enum(["invalid_event", "processing_error", "lease_exhausted"])
    .nullable(),
  createdAt: date,
});
type Position = { time: string; id: string; sequence?: string | undefined };
const cursorSchema = z.strictObject({
  scope: z.string(),
  fingerprint: z.string(),
  position: z.strictObject({
    time: date,
    id,
    sequence: z
      .string()
      .regex(/^[1-9][0-9]{0,18}$/)
      .refine((value) => BigInt(value) <= 9223372036854775807n)
      .optional(),
  }),
});
type Query = {
  limit: number;
  cursor?: string | undefined;
  environment?: string | undefined;
  type?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  ruleCode?: string | undefined;
  status?: string | undefined;
};
type EventRow = {
  event_id: string;
  received_at: Date;
  payload: SecurityEvent;
  cursor_at: string;
  ingest_order: string;
  role?: "trigger" | "support" | "context";
  raw_available?: boolean;
};
type AlertRow = {
  id: string;
  environment: z.infer<typeof environment>;
  rule_code: z.infer<typeof code>;
  rule_version: number;
  severity: "high" | "medium";
  status: z.infer<typeof status>;
  status_version: number;
  episode_id: string;
  correlation_kind: "ip" | "actor";
  correlation_value: string;
  started_at: Date;
  last_relevant_at: Date;
  ended_at: Date | null;
  total_relevant: number;
  initial_decision: z.infer<typeof decision>;
  last_decision: z.infer<typeof decision>;
  peak_count: number;
  evidence_truncated: boolean;
  initial_trigger_raw_available: boolean;
  last_trigger_raw_available: boolean;
  created_at: Date;
  updated_at: Date;
  cursor_at: string;
};
type JobRow = {
  id: string;
  event_id: string;
  status: z.infer<typeof jobStatus>;
  attempts: number;
  available_at: Date;
  leased_until: Date | null;
  last_error_code: string | null;
  created_at: Date;
  cursor_at: string;
};
const exactTime = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at`;
const alertColumns = `a.*,ep.correlation_kind,ep.correlation_value,ep.started_at,ep.last_relevant_at,ep.ended_at,ep.total_relevant,
 EXISTS(SELECT 1 FROM events e WHERE e.organization_id=a.organization_id AND e.project_id=a.project_id AND e.event_id=(a.initial_decision->>'triggerEventId')::uuid) AS initial_trigger_raw_available,
 EXISTS(SELECT 1 FROM events e WHERE e.organization_id=a.organization_id AND e.project_id=a.project_id AND e.event_id=(a.last_decision->>'triggerEventId')::uuid) AS last_trigger_raw_available,
 ${exactTime("a.created_at")}`;
const alertJoin = "alerts a JOIN detection_episodes ep ON ep.id=a.episode_id";
function eventOutput(row: EventRow) {
  return {
    id: row.event_id,
    receivedAt: row.received_at.toISOString(),
    payload: row.payload,
  };
}
function alertOutput(row: AlertRow) {
  return {
    id: row.id,
    environment: row.environment,
    ruleCode: row.rule_code,
    ruleVersion: row.rule_version,
    severity: row.severity,
    status: row.status,
    statusVersion: row.status_version,
    correlation: { kind: row.correlation_kind, value: row.correlation_value },
    episode: {
      id: row.episode_id,
      startedAt: row.started_at.toISOString(),
      lastRelevantAt: row.last_relevant_at.toISOString(),
      endedAt: row.ended_at?.toISOString() ?? null,
      totalRelevant: row.total_relevant,
    },
    initialDecision: row.initial_decision,
    lastDecision: row.last_decision,
    peakCount: row.peak_count,
    evidenceTruncated: row.evidence_truncated,
    initialTriggerRawAvailable: row.initial_trigger_raw_available,
    lastTriggerRawAvailable: row.last_trigger_raw_available,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function fingerprint(q: Query) {
  const { cursor: _cursor, limit: _limit, ...filters } = q;
  return createHash("sha256")
    .update(
      JSON.stringify(
        Object.entries(filters).sort(([a], [b]) => a.localeCompare(b)),
      ),
    )
    .digest("hex");
}
function decode(
  q: Query,
  scope: string,
  sequence: boolean,
): Position | undefined {
  if (!q.cursor) return;
  try {
    const bytes = Buffer.from(q.cursor, "base64url");
    if (bytes.toString("base64url") !== q.cursor) throw new Error();
    const parsed = cursorSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (
      parsed.scope !== scope ||
      parsed.fingerprint !== fingerprint(q) ||
      Boolean(parsed.position.sequence) !== sequence
    )
      throw new Error();
    return parsed.position;
  } catch {
    throw new AccessError(400);
  }
}
function next(q: Query, scope: string, position: Position) {
  return Buffer.from(
    JSON.stringify({ scope, fingerprint: fingerprint(q), position }),
  ).toString("base64url");
}
function page<T>(
  rows: T[],
  q: Query,
  scope: string,
  position: (row: T) => Position,
) {
  const more = rows.length > q.limit;
  const items = rows.slice(0, q.limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor: more && last ? next(q, scope, position(last)) : null,
  };
}

export class InvestigationService {
  constructor(readonly identity: IdentityService) {}
  get pool() {
    return this.identity.pool;
  }
  async events(userId: string, orgId: string, projectId: string, q: Query) {
    await this.identity.getProject(userId, orgId, projectId);
    const scope = `${orgId}/${projectId}/events`;
    const cursor = decode(q, scope, true);
    const values: unknown[] = [orgId, projectId];
    const where = ["organization_id=$1", "project_id=$2"];
    const add = (sql: string, value: unknown) => {
      values.push(value);
      where.push(`${sql}$${values.length}`);
    };
    if (q.environment) add("environment=", q.environment);
    if (q.type) add("type=", q.type);
    if (q.from) add("received_at>=", q.from);
    if (q.to) add("received_at<=", q.to);
    if (cursor) {
      values.push(cursor.time, cursor.sequence);
      where.push(
        `(received_at,ingest_order)<($${values.length - 1},$${values.length}::bigint)`,
      );
    }
    values.push(q.limit + 1);
    const result = await this.pool.query<EventRow>(
      `SELECT event_id,received_at,payload,ingest_order,${exactTime("received_at")} FROM events WHERE ${where.join(" AND ")} ORDER BY received_at DESC,ingest_order DESC LIMIT $${values.length}`,
      values,
    );
    const resultPage = page(result.rows, q, scope, (row) => ({
      time: row.cursor_at,
      id: row.event_id,
      sequence: row.ingest_order,
    }));
    return { ...resultPage, items: resultPage.items.map(eventOutput) };
  }
  async event(
    userId: string,
    orgId: string,
    projectId: string,
    eventId: string,
  ) {
    await this.identity.getProject(userId, orgId, projectId);
    const row = (
      await this.pool.query<EventRow>(
        "SELECT event_id,received_at,payload FROM events WHERE organization_id=$1 AND project_id=$2 AND event_id=$3",
        [orgId, projectId, eventId],
      )
    ).rows[0];
    if (!row) throw new AccessError(404);
    return eventOutput(row);
  }
  async alerts(userId: string, orgId: string, projectId: string, q: Query) {
    await this.identity.getProject(userId, orgId, projectId);
    const scope = `${orgId}/${projectId}/alerts`;
    const cursor = decode(q, scope, false);
    const values: unknown[] = [orgId, projectId];
    const where = ["a.organization_id=$1", "a.project_id=$2"];
    for (const [property, column] of [
      ["environment", "a.environment"],
      ["ruleCode", "a.rule_code"],
      ["status", "a.status"],
    ] as const)
      if (q[property]) {
        values.push(q[property]);
        where.push(`${column}=$${values.length}`);
      }
    if (cursor) {
      values.push(cursor.time, cursor.id);
      where.push(
        `(a.created_at,a.id)<($${values.length - 1},$${values.length})`,
      );
    }
    values.push(q.limit + 1);
    const rows = await this.pool.query<AlertRow>(
      `SELECT ${alertColumns} FROM ${alertJoin} WHERE ${where.join(" AND ")} ORDER BY a.created_at DESC,a.id DESC LIMIT $${values.length}`,
      values,
    );
    const result = page(rows.rows, q, scope, (row) => ({
      time: row.cursor_at,
      id: row.id,
    }));
    return { ...result, items: result.items.map(alertOutput) };
  }
  async alert(
    userId: string,
    orgId: string,
    projectId: string,
    alertId: string,
  ) {
    return transaction(this.pool, async (client) => {
      await this.scope(client, userId, orgId, projectId, false);
      const row = (
        await client.query<AlertRow>(
          `SELECT ${alertColumns} FROM ${alertJoin} WHERE a.organization_id=$1 AND a.project_id=$2 AND a.id=$3`,
          [orgId, projectId, alertId],
        )
      ).rows[0];
      if (!row) throw new AccessError(404);
      await audit(client, orgId, userId, "alert.viewed", alertId);
      return alertOutput(row);
    });
  }
  private async scope(
    client: Pick<typeof this.pool, "query">,
    userId: string,
    orgId: string,
    projectId: string,
    write: boolean,
  ) {
    await client.query(
      `SELECT id FROM organizations WHERE id=$1 ${write ? "FOR UPDATE" : "FOR SHARE"}`,
      [orgId],
    );
    const member = (
      await client.query<{ role: string }>(
        "SELECT role FROM memberships WHERE user_id=$1 AND organization_id=$2 AND active=true",
        [userId, orgId],
      )
    ).rows[0];
    if (!member) throw new AccessError(404);
    if (write && !["admin", "analyst"].includes(member.role))
      throw new AccessError(403);
    if (
      !(
        await client.query(
          "SELECT id FROM projects WHERE organization_id=$1 AND id=$2",
          [orgId, projectId],
        )
      ).rowCount
    )
      throw new AccessError(404);
  }
  async update(
    userId: string,
    orgId: string,
    projectId: string,
    alertId: string,
    body: { status: z.infer<typeof status>; expectedVersion: number },
  ) {
    return transaction(this.pool, async (client) => {
      await this.scope(client, userId, orgId, projectId, true);
      const row = (
        await client.query<{
          id: string;
          status: z.infer<typeof status>;
          status_version: number;
        }>(
          "SELECT id,status,status_version FROM alerts WHERE organization_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE",
          [orgId, projectId, alertId],
        )
      ).rows[0];
      if (!row) throw new AccessError(404);
      if (row.status_version !== body.expectedVersion)
        throw new AccessError(409);
      if (row.status !== body.status) {
        await client.query(
          "UPDATE alerts SET status=$4,status_version=status_version+1,updated_at=now() WHERE organization_id=$1 AND project_id=$2 AND id=$3",
          [orgId, projectId, alertId, body.status],
        );
        await audit(client, orgId, userId, "alert.status_changed", alertId, {
          fromStatus: row.status,
          toStatus: body.status,
        });
        row.status_version++;
      }
      return {
        id: row.id,
        status: body.status,
        statusVersion: row.status_version,
      };
    });
  }
  async evidence(
    userId: string,
    orgId: string,
    projectId: string,
    alertId: string,
    q: Query,
  ) {
    await this.identity.getProject(userId, orgId, projectId);
    if (
      !(
        await this.pool.query(
          "SELECT 1 FROM alerts WHERE organization_id=$1 AND project_id=$2 AND id=$3",
          [orgId, projectId, alertId],
        )
      ).rowCount
    )
      throw new AccessError(404);
    const scope = `${orgId}/${projectId}/alerts/${alertId}/evidence`;
    const cursor = decode(q, scope, true);
    const values: unknown[] = [orgId, projectId, alertId];
    let after = "";
    if (cursor) {
      values.push(cursor.time, cursor.sequence);
      after = ` AND (ae.received_at,ae.ingest_order)>($4,$5::bigint)`;
    }
    values.push(q.limit + 1);
    const rows = await this.pool.query<EventRow>(
      `SELECT ae.event_id,ae.received_at,ae.ingest_order,ae.payload,ae.role,EXISTS(SELECT 1 FROM events e WHERE (e.organization_id,e.project_id,e.event_id)=(ae.organization_id,ae.project_id,ae.event_id)) AS raw_available,${exactTime("ae.received_at")} FROM alert_evidence ae WHERE ae.organization_id=$1 AND ae.project_id=$2 AND ae.alert_id=$3${after} ORDER BY ae.received_at,ae.ingest_order LIMIT $${values.length}`,
      values,
    );
    const result = page(rows.rows, q, scope, (row) => ({
      time: row.cursor_at,
      id: row.event_id,
      sequence: row.ingest_order,
    }));
    return {
      ...result,
      items: result.items.map((row) => ({
        ...eventOutput(row),
        role: row.role,
        rawAvailable: row.raw_available,
      })),
    };
  }
  async rules(userId: string, orgId: string, projectId: string) {
    await this.identity.getProject(userId, orgId, projectId);
    return (
      await this.pool.query<{ definition: z.infer<typeof ruleView> }>(
        "SELECT definition FROM rule_definitions ORDER BY code,version",
      )
    ).rows.map((row) => row.definition);
  }
  async jobs(userId: string, orgId: string, projectId: string, q: Query) {
    await this.identity.getProject(userId, orgId, projectId);
    const role = (
      await this.pool.query<{ role: string }>(
        "SELECT role FROM memberships WHERE user_id=$1 AND organization_id=$2 AND active=true",
        [userId, orgId],
      )
    ).rows[0]?.role;
    if (!role || !["admin", "analyst"].includes(role))
      throw new AccessError(403);
    const scope = `${orgId}/${projectId}/jobs`;
    const cursor = decode(q, scope, false);
    const values: unknown[] = [orgId, projectId, q.status];
    let after = "";
    if (cursor) {
      values.push(cursor.time, cursor.id);
      after = " AND (created_at,id)<($4,$5)";
    }
    values.push(q.limit + 1);
    const rows = await this.pool.query<JobRow>(
      `SELECT id,event_id,status,attempts,available_at,leased_until,last_error_code,created_at,${exactTime("created_at")} FROM detection_jobs WHERE organization_id=$1 AND project_id=$2 AND status=$3${after} ORDER BY created_at DESC,id DESC LIMIT $${values.length}`,
      values,
    );
    const result = page(rows.rows, q, scope, (row) => ({
      time: row.cursor_at,
      id: row.id,
    }));
    return {
      ...result,
      items: result.items.map((row) => ({
        id: row.id,
        eventId: row.event_id,
        status: row.status,
        attempts: row.attempts,
        availableAt: row.available_at.toISOString(),
        leasedUntil: row.leased_until?.toISOString() ?? null,
        lastErrorCode:
          row.last_error_code === null
            ? null
            : ["invalid_event", "processing_error", "lease_exhausted"].includes(
                  row.last_error_code,
                )
              ? row.last_error_code
              : "processing_error",
        createdAt: row.created_at.toISOString(),
      })),
    };
  }
}

export async function registerInvestigationRoutes(
  app: FastifyInstance,
  service: InvestigationService,
  guards: { read: preHandlerHookHandler[]; write: preHandlerHookHandler[] },
) {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const base = "/v1/organizations/:orgId/projects/:projectId";
  const user = (request: { principal: { userId: string } | null }) => {
    if (!request.principal) throw new AccessError(401);
    return request.principal.userId;
  };
  const pageOf = (schema: z.ZodType) =>
    z.strictObject({
      items: z.array(schema).max(100),
      nextCursor: z.string().nullable(),
    });
  api.get(
    `${base}/events`,
    {
      preHandler: guards.read,
      schema: {
        params,
        querystring: eventQuery,
        response: { 200: pageOf(eventView) },
      },
    },
    async (req) =>
      service.events(
        user(req),
        req.params.orgId,
        req.params.projectId,
        req.query,
      ),
  );
  api.get(
    `${base}/events/:eventId`,
    {
      preHandler: guards.read,
      schema: {
        params: params.extend({ eventId: id }),
        response: { 200: eventView },
      },
    },
    async (req) =>
      service.event(
        user(req),
        req.params.orgId,
        req.params.projectId,
        req.params.eventId,
      ),
  );
  api.get(
    `${base}/alerts`,
    {
      preHandler: guards.read,
      schema: {
        params,
        querystring: alertQuery,
        response: { 200: pageOf(alertView) },
      },
    },
    async (req) =>
      service.alerts(
        user(req),
        req.params.orgId,
        req.params.projectId,
        req.query,
      ),
  );
  api.get(
    `${base}/alerts/:alertId`,
    {
      preHandler: guards.read,
      schema: {
        params: params.extend({ alertId: id }),
        response: { 200: alertView },
      },
    },
    async (req) =>
      service.alert(
        user(req),
        req.params.orgId,
        req.params.projectId,
        req.params.alertId,
      ),
  );
  api.get(
    `${base}/alerts/:alertId/evidence`,
    {
      preHandler: guards.read,
      schema: {
        params: params.extend({ alertId: id }),
        querystring: z.strictObject(paging),
        response: {
          200: pageOf(
            eventView.extend({
              role: z.enum(["trigger", "support", "context"]),
              rawAvailable: z.boolean(),
            }),
          ),
        },
      },
    },
    async (req) =>
      service.evidence(
        user(req),
        req.params.orgId,
        req.params.projectId,
        req.params.alertId,
        req.query,
      ),
  );
  api.patch(
    `${base}/alerts/:alertId`,
    {
      preHandler: guards.write,
      schema: {
        params: params.extend({ alertId: id }),
        body: z.strictObject({
          status,
          expectedVersion: z.number().int().positive(),
        }),
        response: {
          200: z.strictObject({
            id,
            status,
            statusVersion: z.number().int().positive(),
          }),
        },
      },
    },
    async (req) =>
      service.update(
        user(req),
        req.params.orgId,
        req.params.projectId,
        req.params.alertId,
        req.body,
      ),
  );
  api.get(
    `${base}/rules`,
    {
      preHandler: guards.read,
      schema: { params, response: { 200: z.array(ruleView) } },
    },
    async (req) =>
      service.rules(user(req), req.params.orgId, req.params.projectId),
  );
  api.get(
    `${base}/jobs`,
    {
      preHandler: guards.read,
      schema: {
        params,
        querystring: jobQuery,
        response: { 200: pageOf(jobView) },
      },
    },
    async (req) =>
      service.jobs(
        user(req),
        req.params.orgId,
        req.params.projectId,
        req.query,
      ),
  );
}
