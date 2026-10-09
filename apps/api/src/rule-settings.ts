import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { audit, type IdentityService, transaction } from "./identity.js";
import { projectScope } from "./response.js";
import { AccessError } from "./security.js";

const params = z.strictObject({ orgId: z.uuid(), projectId: z.uuid() });
const code = z.enum(["AUTH-001", "AUTHZ-001", "ADMIN-001"]);
const body = z.strictObject({
  expectedVersion: z.number().int().positive(),
  enabled: z.boolean(),
  threshold: z.number().int().min(2).max(100),
  windowSeconds: z.number().int().min(30).max(3600),
});
type Definition = {
  code: string;
  version: number;
  title: string;
  severity: string;
  threshold: number;
  windowSeconds: number;
  criticalActions: string[];
};
export const currentRulesSql = `SELECT d.definition,COALESCE(r.enabled,true) AS enabled FROM rule_definitions baseline
  LEFT JOIN LATERAL (SELECT rule_version,enabled FROM project_rule_revisions WHERE organization_id=$1 AND project_id=$2 AND rule_code=baseline.code ORDER BY rule_version DESC LIMIT 1) r ON true
  JOIN rule_definitions d ON d.code=baseline.code AND d.version=COALESCE(r.rule_version,1) WHERE baseline.version=1 ORDER BY d.code`;
export class RuleSettingsService {
  constructor(readonly identity: IdentityService) {}
  async history(user: string, org: string, project: string) {
    return transaction(this.identity.pool, async (client) => {
      await projectScope(client, user, org, project, "read");
      const current = (
        await client.query<{ definition: Definition; enabled: boolean }>(
          currentRulesSql,
          [org, project],
        )
      ).rows.map((row) => ({ ...row.definition, enabled: row.enabled }));
      const history = (
        await client.query<{
          definition: Definition;
          enabled: boolean;
          created_at: Date;
        }>(
          "SELECT d.definition,r.enabled,r.created_at FROM project_rule_revisions r JOIN rule_definitions d ON (d.code,d.version)=(r.rule_code,r.rule_version) WHERE r.organization_id=$1 AND r.project_id=$2 ORDER BY r.created_at DESC,r.rule_version DESC LIMIT 50",
          [org, project],
        )
      ).rows.map((row) => ({
        ...row.definition,
        enabled: row.enabled,
        createdAt: row.created_at.toISOString(),
      }));
      return { current, history };
    });
  }
  async configure(
    user: string,
    org: string,
    project: string,
    ruleCode: z.infer<typeof code>,
    change: z.infer<typeof body>,
  ) {
    return transaction(this.identity.pool, async (client) => {
      await projectScope(client, user, org, project, "admin");
      const current = (
        await client.query<{ definition: Definition; enabled: boolean }>(
          currentRulesSql,
          [org, project],
        )
      ).rows.find((row) => row.definition.code === ruleCode);
      if (!current) throw new AccessError(404);
      if (current.definition.version !== change.expectedVersion)
        throw new AccessError(409);
      if (
        current.enabled === change.enabled &&
        current.definition.threshold === change.threshold &&
        current.definition.windowSeconds === change.windowSeconds
      )
        return { ...current.definition, enabled: current.enabled };
      const version = Number(
        (
          await client.query<{ version: string }>(
            "SELECT nextval('rule_revision_version_seq') AS version",
          )
        ).rows[0]?.version,
      );
      const definition = {
        ...current.definition,
        version,
        threshold: change.threshold,
        windowSeconds: change.windowSeconds,
      };
      await client.query(
        "INSERT INTO rule_definitions(code,version,definition) VALUES($1,$2,$3::jsonb)",
        [ruleCode, version, JSON.stringify(definition)],
      );
      await client.query(
        "INSERT INTO project_rule_revisions(organization_id,project_id,rule_code,rule_version,enabled,created_by) VALUES($1,$2,$3,$4,$5,$6)",
        [org, project, ruleCode, version, change.enabled, user],
      );
      await audit(client, org, user, "rule.configured", project, {
        ruleCode,
        version,
        active: change.enabled,
      });
      return { ...definition, enabled: change.enabled };
    });
  }
}
export async function registerRuleSettingsRoutes(
  app: FastifyInstance,
  service: RuleSettingsService,
  guards: { read: preHandlerHookHandler[]; write: preHandlerHookHandler[] },
) {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const base = "/v1/organizations/:orgId/projects/:projectId/rule-settings";
  const user = (req: { principal: { userId: string } | null }) => {
    if (!req.principal) throw new AccessError(401);
    return req.principal.userId;
  };
  api.get(
    base,
    {
      preHandler: guards.read,
      schema: {
        params,
        querystring: z.strictObject({}),
        tags: ["Rule configuration"],
      },
    },
    (req) => service.history(user(req), req.params.orgId, req.params.projectId),
  );
  api.patch(
    `${base}/:code`,
    {
      preHandler: guards.write,
      schema: {
        params: params.extend({ code }),
        body,
        tags: ["Rule configuration"],
      },
    },
    (req) =>
      service.configure(
        user(req),
        req.params.orgId,
        req.params.projectId,
        req.params.code,
        req.body,
      ),
  );
}
