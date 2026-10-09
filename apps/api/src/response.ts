import { randomUUID } from "node:crypto";
import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { audit, type IdentityService, transaction } from "./identity.js";
import { AccessError, randomToken, secretHash } from "./security.js";

const id = z.uuid();
const environment = z.enum([
  "demo",
  "development",
  "test",
  "staging",
  "production",
]);
const scopeParams = z.strictObject({ orgId: id, projectId: id });
const actionParams = scopeParams.extend({ alertId: id });
const ip = z.union([z.ipv4(), z.ipv6()]);
const requestBody = z.strictObject({
  requestId: id,
  sourceIp: ip,
  reason: z
    .string()
    .trim()
    .min(10)
    .max(240)
    .regex(/^[\p{L}\p{N} .,:;_()/-]+$/u),
  ttlSeconds: z.number().int().min(15).max(3600),
});
const ackBody = z
  .strictObject({
    state: z.enum(["applied", "failed", "expired"]),
    failureCode: z
      .enum(["capacity", "unsupported_target", "adapter_error"])
      .optional(),
  })
  .refine((body) => (body.state === "failed") === Boolean(body.failureCode));
type Pool = IdentityService["pool"];
type Client = Pick<Pool, "query">;
type ActionRow = {
  id: string;
  alert_id: string;
  source_ip: string;
  reason: string;
  ttl_seconds: number;
  state: "requested" | "applied" | "failed" | "expired";
  failure_code: string | null;
  created_at: Date;
  expires_at: Date;
  applied_at: Date | null;
  expired_confirmed_at: Date | null;
  requested_by: string;
  environment: z.infer<typeof environment>;
};
function output(row: ActionRow) {
  return {
    id: row.id,
    alertId: row.alert_id,
    sourceIp: row.source_ip,
    reason: row.reason,
    ttlSeconds: row.ttl_seconds,
    state: row.state,
    failureCode: row.failure_code,
    environment: row.environment,
    requestedAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    appliedAt: row.applied_at?.toISOString() ?? null,
    expiredConfirmedAt: row.expired_confirmed_at?.toISOString() ?? null,
  };
}
// Same organization lock used by membership changes prevents role revocation races.
export async function projectScope(
  client: Client,
  user: string,
  org: string,
  project: string,
  permission: "read" | "respond" | "admin",
) {
  await client.query("SELECT id FROM organizations WHERE id=$1 FOR SHARE", [
    org,
  ]);
  const member = (
    await client.query<{ role: string }>(
      "SELECT role FROM memberships WHERE organization_id=$1 AND user_id=$2 AND active=true",
      [org, user],
    )
  ).rows[0];
  if (!member) throw new AccessError(404);
  if (
    (permission === "admin" && member.role !== "admin") ||
    (permission === "respond" && member.role === "reader")
  )
    throw new AccessError(403);
  if (
    !(
      await client.query(
        "SELECT id FROM projects WHERE organization_id=$1 AND id=$2 FOR UPDATE",
        [org, project],
      )
    ).rowCount
  )
    throw new AccessError(404);
}

export class ResponseService {
  constructor(readonly identity: IdentityService) {}
  get pool() {
    return this.identity.pool;
  }
  async issueKey(
    user: string,
    org: string,
    project: string,
    env: z.infer<typeof environment>,
  ) {
    return transaction(this.pool, async (client) => {
      await projectScope(client, user, org, project, "admin");
      // A single active credential per project/environment avoids conflicting adapters.
      if (
        (
          await client.query(
            "SELECT 1 FROM response_keys WHERE organization_id=$1 AND project_id=$2 AND environment=$3 AND revoked_at IS NULL",
            [org, project, env],
          )
        ).rowCount
      )
        throw new AccessError(409);
      const keyId = randomUUID(),
        key = `snt_rsp_${keyId}.${randomToken()}`;
      await client.query(
        "INSERT INTO response_keys(id,organization_id,project_id,environment,key_hash) VALUES($1,$2,$3,$4,$5)",
        [keyId, org, project, env, secretHash("response", key)],
      );
      await audit(client, org, user, "response.key_created", keyId, {
        environment: env,
      });
      return { id: keyId, key, environment: env };
    });
  }
  async keys(user: string, org: string, project: string) {
    return transaction(this.pool, async (client) => {
      await projectScope(client, user, org, project, "admin");
      return (
        await client.query(
          'SELECT id,environment,created_at AS "createdAt",revoked_at AS "revokedAt" FROM response_keys WHERE organization_id=$1 AND project_id=$2 ORDER BY created_at DESC LIMIT 50',
          [org, project],
        )
      ).rows;
    });
  }
  async revoke(user: string, org: string, project: string, keyId: string) {
    await transaction(this.pool, async (client) => {
      await projectScope(client, user, org, project, "admin");
      const row = await client.query(
        "UPDATE response_keys SET revoked_at=COALESCE(revoked_at,now()) WHERE organization_id=$1 AND project_id=$2 AND id=$3 RETURNING id",
        [org, project, keyId],
      );
      if (!row.rowCount) throw new AccessError(404);
      await audit(client, org, user, "response.key_revoked", keyId);
    });
  }
  async expire(client: Client, org: string, project: string, env?: string) {
    const rows = await client.query<{ id: string }>(
      "UPDATE response_actions SET state='expired' WHERE organization_id=$1 AND project_id=$2 AND ($3::text IS NULL OR environment::text=$3) AND state IN ('requested','applied') AND expires_at<=clock_timestamp() RETURNING id",
      [org, project, env ?? null],
    );
    for (const row of rows.rows)
      await audit(client, org, null, "response.expired", row.id);
  }
  async request(
    user: string,
    org: string,
    project: string,
    alert: string,
    body: z.infer<typeof requestBody>,
  ) {
    return transaction(this.pool, async (client) => {
      await projectScope(client, user, org, project, "respond");
      const found = (
        await client.query<{ environment: string }>(
          "SELECT environment FROM alerts WHERE organization_id=$1 AND project_id=$2 AND id=$3",
          [org, project, alert],
        )
      ).rows[0];
      if (!found) throw new AccessError(404);
      // Only a reviewed IP from this alert's immutable evidence can be targeted.
      if (
        !(
          await client.query(
            "SELECT 1 FROM alert_evidence WHERE organization_id=$1 AND project_id=$2 AND alert_id=$3 AND (payload->>'source_ip')::inet=$4::inet LIMIT 1",
            [org, project, alert, body.sourceIp],
          )
        ).rowCount
      )
        throw new AccessError(400);
      const canonical = (
        await client.query<{ ip: string }>("SELECT host($1::inet) AS ip", [
          body.sourceIp,
        ])
      ).rows[0]?.ip;
      const old = (
        await client.query<ActionRow>(
          "SELECT * FROM response_actions WHERE id=$1",
          [body.requestId],
        )
      ).rows[0];
      if (old) {
        if (
          old.alert_id !== alert ||
          old.requested_by !== user ||
          old.source_ip !== canonical ||
          old.reason !== body.reason ||
          old.ttl_seconds !== body.ttlSeconds
        )
          throw new AccessError(409);
        await this.expire(client, org, project);
        return output(
          (
            await client.query<ActionRow>(
              "SELECT * FROM response_actions WHERE id=$1",
              [old.id],
            )
          ).rows[0] as ActionRow,
        );
      }
      await this.expire(client, org, project);
      const count = (
        await client.query<{ count: string }>(
          "SELECT count(*) FROM response_actions WHERE project_id=$1 AND state IN ('requested','applied')",
          [project],
        )
      ).rows[0];
      if (Number(count?.count) >= 100) throw new AccessError(429, 60);
      const row = (
        await client.query<ActionRow>(
          "INSERT INTO response_actions(id,organization_id,project_id,environment,alert_id,requested_by,source_ip,reason,ttl_seconds,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp()+$9::integer*interval '1 second') RETURNING *",
          [
            body.requestId,
            org,
            project,
            found.environment,
            alert,
            user,
            canonical,
            body.reason,
            body.ttlSeconds,
          ],
        )
      ).rows[0];
      await audit(client, org, user, "response.requested", body.requestId, {
        environment: found.environment as z.infer<typeof environment>,
        ttlSeconds: body.ttlSeconds,
      });
      return output(row as ActionRow);
    });
  }
  async list(user: string, org: string, project: string, alert: string) {
    return transaction(this.pool, async (client) => {
      await projectScope(client, user, org, project, "read");
      if (
        !(
          await client.query(
            "SELECT 1 FROM alerts WHERE organization_id=$1 AND project_id=$2 AND id=$3",
            [org, project, alert],
          )
        ).rowCount
      )
        throw new AccessError(404);
      await this.expire(client, org, project);
      return (
        await client.query<ActionRow>(
          "SELECT * FROM response_actions WHERE organization_id=$1 AND project_id=$2 AND alert_id=$3 ORDER BY created_at DESC,id DESC LIMIT 100",
          [org, project, alert],
        )
      ).rows.map(output);
    });
  }
  private async adapter(client: Client, key: string) {
    if (!/^snt_rsp_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(key))
      throw new AccessError(401);
    const row = (
      await client.query<{
        id: string;
        organization_id: string;
        project_id: string;
        environment: string;
      }>(
        "SELECT id,organization_id,project_id,environment FROM response_keys WHERE key_hash=$1 AND revoked_at IS NULL",
        [secretHash("response", key)],
      )
    ).rows[0];
    if (!row) throw new AccessError(401);
    await client.query("SELECT id FROM projects WHERE id=$1 FOR UPDATE", [
      row.project_id,
    ]);
    if (
      !(
        await client.query(
          "SELECT id FROM response_keys WHERE key_hash=$1 AND revoked_at IS NULL FOR SHARE",
          [secretHash("response", key)],
        )
      ).rowCount
    )
      throw new AccessError(401);
    return row;
  }
  async commands(key: string) {
    return transaction(this.pool, async (client) => {
      const scope = await this.adapter(client, key);
      await this.expire(
        client,
        scope.organization_id,
        scope.project_id,
        scope.environment,
      );
      const rows = await client.query<ActionRow>(
        "SELECT * FROM response_actions WHERE organization_id=$1 AND project_id=$2 AND environment=$3 AND (state IN ('requested','applied') OR (state='expired' AND expired_confirmed_at IS NULL)) ORDER BY (state='expired'),created_at,id LIMIT 200",
        [scope.organization_id, scope.project_id, scope.environment],
      );
      // No analyst memo or user identity is sent to the application.
      return {
        commands: rows.rows.map((row) => ({
          id: row.id,
          environment: row.environment,
          sourceIp: row.source_ip,
          state: row.state,
          expiresAt: row.expires_at.toISOString(),
        })),
      };
    });
  }
  async acknowledge(
    key: string,
    actionId: string,
    body: z.infer<typeof ackBody>,
  ) {
    return transaction(this.pool, async (client) => {
      const scope = await this.adapter(client, key);
      await this.expire(
        client,
        scope.organization_id,
        scope.project_id,
        scope.environment,
      );
      const row = (
        await client.query<ActionRow>(
          "SELECT * FROM response_actions WHERE id=$1 AND organization_id=$2 AND project_id=$3 AND environment=$4 FOR UPDATE",
          [
            actionId,
            scope.organization_id,
            scope.project_id,
            scope.environment,
          ],
        )
      ).rows[0];
      if (!row) throw new AccessError(404);
      if (body.state === "expired") {
        if (row.state !== "expired") throw new AccessError(409);
        if (!row.expired_confirmed_at) {
          await client.query(
            "UPDATE response_actions SET expired_confirmed_at=clock_timestamp() WHERE id=$1",
            [actionId],
          );
          await audit(
            client,
            scope.organization_id,
            null,
            "response.expiry_confirmed",
            actionId,
            { adapterKeyId: scope.id },
          );
        }
      } else if (row.state === "requested") {
        await client.query(
          "UPDATE response_actions SET state=$2,failure_code=$3,applied_at=CASE WHEN $2='applied' THEN clock_timestamp() ELSE NULL END WHERE id=$1",
          [actionId, body.state, body.failureCode ?? null],
        );
        await audit(
          client,
          scope.organization_id,
          null,
          body.state === "applied" ? "response.applied" : "response.failed",
          actionId,
          { adapterKeyId: scope.id },
        );
      } else if (
        row.state !== body.state ||
        row.failure_code !== (body.failureCode ?? null)
      )
        throw new AccessError(409);
      return { status: "confirmed" };
    });
  }
}

export async function registerResponseRoutes(
  app: FastifyInstance,
  service: ResponseService,
  guards: { read: preHandlerHookHandler[]; write: preHandlerHookHandler[] },
) {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const base = "/v1/organizations/:orgId/projects/:projectId";
  const user = (req: { principal: { userId: string } | null }) => {
    if (!req.principal) throw new AccessError(401);
    return req.principal.userId;
  };
  api.get(
    `${base}/response-keys`,
    {
      preHandler: guards.read,
      schema: {
        params: scopeParams,
        querystring: z.strictObject({}),
        tags: ["Response"],
      },
    },
    (req) => service.keys(user(req), req.params.orgId, req.params.projectId),
  );
  api.post(
    `${base}/response-keys`,
    {
      preHandler: guards.write,
      schema: {
        params: scopeParams,
        body: z.strictObject({ environment }),
        tags: ["Response"],
      },
    },
    (req, reply) => {
      reply.code(201);
      return service.issueKey(
        user(req),
        req.params.orgId,
        req.params.projectId,
        req.body.environment,
      );
    },
  );
  api.delete(
    `${base}/response-keys/:keyId`,
    {
      preHandler: guards.write,
      schema: { params: scopeParams.extend({ keyId: id }), tags: ["Response"] },
    },
    async (req, reply) => {
      await service.revoke(
        user(req),
        req.params.orgId,
        req.params.projectId,
        req.params.keyId,
      );
      return reply.code(204).send();
    },
  );
  api.get(
    `${base}/alerts/:alertId/responses`,
    {
      preHandler: guards.read,
      schema: {
        params: actionParams,
        querystring: z.strictObject({}),
        tags: ["Response"],
      },
    },
    (req) =>
      service.list(
        user(req),
        req.params.orgId,
        req.params.projectId,
        req.params.alertId,
      ),
  );
  api.post(
    `${base}/alerts/:alertId/responses`,
    {
      preHandler: guards.write,
      schema: { params: actionParams, body: requestBody, tags: ["Response"] },
    },
    (req, reply) => {
      reply.code(202);
      return service.request(
        user(req),
        req.params.orgId,
        req.params.projectId,
        req.params.alertId,
        req.body,
      );
    },
  );
  const bearer = (req: { headers: { authorization?: string | undefined } }) => {
    const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (!token) throw new AccessError(401);
    return token;
  };
  api.get(
    "/v1/response/commands",
    { schema: { querystring: z.strictObject({}), tags: ["Response adapter"] } },
    (req) => service.commands(bearer(req)),
  );
  api.post(
    "/v1/response/commands/:actionId/ack",
    {
      schema: {
        params: z.strictObject({ actionId: id }),
        body: ackBody,
        tags: ["Response adapter"],
      },
    },
    (req) => service.acknowledge(bearer(req), req.params.actionId, req.body),
  );
}
