import cookie from "@fastify/cookie";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { ApiConfig } from "./config.js";
import {
  ABSOLUTE_MS,
  type IdentityService,
  type Principal,
} from "./identity.js";
import {
  InvestigationService,
  registerInvestigationRoutes,
} from "./investigation.js";
import {
  AccessError,
  emailSchema,
  equalToken,
  nameSchema,
  roleSchema,
} from "./security.js";

declare module "fastify" {
  interface FastifyRequest {
    principal: Principal | null;
  }
}
const id = z.uuid();
const date = z.iso.datetime();
const env = z.enum(["demo", "development", "test", "staging", "production"]);
const orgParams = z.strictObject({ orgId: id });
const projectParams = orgParams.extend({ projectId: id });
const projectSchema = z.strictObject({ id, name: z.string(), createdAt: date });
const keyMetadata = z.strictObject({
  id,
  prefix: z.string(),
  environment: env,
  createdAt: date,
  revokedAt: date.nullable(),
});
const memberSchema = z.strictObject({
  userId: id,
  email: z.string(),
  role: roleSchema,
  active: z.boolean(),
});

function principal(request: FastifyRequest): Principal {
  if (!request.principal) throw new AccessError(401);
  return request.principal;
}

export async function registerIdentityRoutes(
  app: FastifyInstance,
  config: ApiConfig,
  identity: IdentityService,
) {
  await app.register(cookie);
  app.decorateRequest("principal", null);
  const api = app.withTypeProvider<ZodTypeProvider>();
  const secure = new URL(config.APP_ORIGIN).protocol === "https:";
  const cookieName = secure ? "__Host-sentinel_session" : "sentinel_session";
  const cookieOptions = {
    httpOnly: true,
    secure,
    sameSite: "lax" as const,
    path: "/",
  };
  const originGuard = async (request: FastifyRequest) => {
    if (
      request.headers.origin !== config.APP_ORIGIN ||
      request.headers["sec-fetch-site"] === "cross-site"
    )
      throw new AccessError(403);
  };
  const authenticate = async (request: FastifyRequest) => {
    if (request.headers["sec-fetch-site"] === "cross-site")
      throw new AccessError(403);
    request.principal = await identity.authenticate(
      request.cookies[cookieName],
    );
  };
  const csrfGuard = async (request: FastifyRequest) => {
    await originGuard(request);
    const token = request.headers["x-csrf-token"];
    if (
      !equalToken(
        typeof token === "string" ? token : undefined,
        principal(request).csrfToken,
      )
    )
      throw new AccessError(403);
  };
  const read = [authenticate];
  const write = [authenticate, csrfGuard];
  await registerInvestigationRoutes(app, new InvestigationService(identity), {
    read,
    write,
  });
  // Session/key responses must not be retained by a browser or intermediary cache.
  app.addHook("onSend", async (request, reply, payload) => {
    if (request.url.startsWith("/v1/")) {
      reply.header("Cache-Control", "no-store");
      reply.header("X-Content-Type-Options", "nosniff");
    }
    return payload;
  });
  api.post(
    "/v1/auth/login",
    {
      bodyLimit: 8 * 1024,
      onRequest: originGuard,
      schema: {
        body: z.strictObject({
          email: emailSchema,
          password: z.string().min(1).max(128),
        }),
        response: {
          200: z.strictObject({
            user: z.strictObject({ id, email: z.string() }),
            csrfToken: z.string(),
            expiresAt: date,
          }),
        },
      },
    },
    async (request, reply) => {
      const session = await identity.login(
        request.body.email,
        request.body.password,
        request.ip,
        request.cookies[cookieName],
      );
      reply.setCookie(cookieName, session.token, {
        ...cookieOptions,
        maxAge: ABSOLUTE_MS / 1000,
      });
      return {
        user: { id: session.userId, email: session.email },
        csrfToken: session.csrfToken,
        expiresAt: session.expiresAt.toISOString(),
      };
    },
  );
  api.get(
    "/v1/auth/session",
    {
      preHandler: read,
      schema: {
        response: {
          200: z.strictObject({
            user: z.strictObject({ id, email: z.string() }),
            csrfToken: z.string(),
            expiresAt: date,
          }),
        },
      },
    },
    async (request) => {
      const session = principal(request);
      return {
        user: { id: session.userId, email: session.email },
        csrfToken: session.csrfToken,
        expiresAt: session.expiresAt.toISOString(),
      };
    },
  );
  api.post("/v1/auth/logout", { preHandler: write }, async (request, reply) => {
    const session = principal(request);
    await identity.revokeSession(session.userId, session.sessionId);
    return reply.clearCookie(cookieName, cookieOptions).code(204).send();
  });
  api.get(
    "/v1/auth/sessions",
    {
      preHandler: read,
      schema: {
        response: {
          200: z.array(
            z.strictObject({
              id,
              createdAt: date,
              lastSeenAt: date,
              expiresAt: date,
              revokedAt: date.nullable(),
              current: z.boolean(),
            }),
          ),
        },
      },
    },
    async (request) => identity.listSessions(principal(request)),
  );
  api.delete(
    "/v1/auth/sessions/:sessionId",
    {
      preHandler: write,
      schema: { params: z.strictObject({ sessionId: id }) },
    },
    async (request, reply) => {
      const session = principal(request);
      await identity.revokeSession(session.userId, request.params.sessionId);
      if (session.sessionId === request.params.sessionId)
        reply.clearCookie(cookieName, cookieOptions);
      return reply.code(204).send();
    },
  );
  api.get(
    "/v1/organizations",
    {
      preHandler: read,
      schema: {
        response: {
          200: z.array(
            z.strictObject({ id, name: z.string(), role: roleSchema }),
          ),
        },
      },
    },
    async (request) => identity.listOrganizations(principal(request).userId),
  );
  api.get(
    "/v1/organizations/:orgId/projects",
    {
      preHandler: read,
      schema: { params: orgParams, response: { 200: z.array(projectSchema) } },
    },
    async (request) =>
      identity.listProjects(principal(request).userId, request.params.orgId),
  );
  api.get(
    "/v1/organizations/:orgId/projects/:projectId",
    {
      preHandler: read,
      schema: { params: projectParams, response: { 200: projectSchema } },
    },
    async (request) =>
      identity.getProject(
        principal(request).userId,
        request.params.orgId,
        request.params.projectId,
      ),
  );
  api.post(
    "/v1/organizations/:orgId/projects",
    {
      preHandler: write,
      schema: {
        params: orgParams,
        body: z.strictObject({ name: nameSchema }),
        response: { 201: projectSchema },
      },
    },
    async (request, reply) => {
      const project = await identity.createProject(
        principal(request).userId,
        request.params.orgId,
        request.body.name,
      );
      return reply.code(201).send(project);
    },
  );
  api.get(
    "/v1/organizations/:orgId/projects/:projectId/keys",
    {
      preHandler: read,
      schema: {
        params: projectParams,
        response: { 200: z.array(keyMetadata) },
      },
    },
    async (request) =>
      identity.listKeys(
        principal(request).userId,
        request.params.orgId,
        request.params.projectId,
      ),
  );
  api.post(
    "/v1/organizations/:orgId/projects/:projectId/keys",
    {
      preHandler: write,
      schema: {
        params: projectParams,
        body: z.strictObject({ environment: env }),
        response: {
          201: z.strictObject({
            id,
            prefix: z.string(),
            environment: env,
            key: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      const key = await identity.issueKey(
        principal(request).userId,
        request.params.orgId,
        request.params.projectId,
        request.body.environment,
      );
      return reply.code(201).send(key);
    },
  );
  api.delete(
    "/v1/organizations/:orgId/projects/:projectId/keys/:keyId",
    {
      preHandler: write,
      schema: { params: projectParams.extend({ keyId: id }) },
    },
    async (request, reply) => {
      await identity.revokeKey(
        principal(request).userId,
        request.params.orgId,
        request.params.projectId,
        request.params.keyId,
      );
      return reply.code(204).send();
    },
  );
  api.get(
    "/v1/organizations/:orgId/members",
    {
      preHandler: read,
      schema: { params: orgParams, response: { 200: z.array(memberSchema) } },
    },
    async (request) =>
      identity.listMembers(principal(request).userId, request.params.orgId),
  );
  api.patch(
    "/v1/organizations/:orgId/members/:userId",
    {
      preHandler: write,
      schema: {
        params: orgParams.extend({ userId: id }),
        body: z.strictObject({ role: roleSchema, active: z.boolean() }),
      },
    },
    async (request, reply) => {
      await identity.updateMember(
        principal(request).userId,
        request.params.orgId,
        request.params.userId,
        request.body,
      );
      return reply.code(204).send();
    },
  );
  api.get(
    "/v1/organizations/:orgId/audit",
    {
      preHandler: read,
      schema: {
        params: orgParams,
        response: {
          200: z.array(
            z.strictObject({
              id,
              actorUserId: id.nullable(),
              action: z.enum([
                "organization.created",
                "member.provisioned",
                "member.updated",
                "project.created",
                "key.created",
                "key.revoked",
                "alert.viewed",
                "alert.status_changed",
              ]),
              subjectId: id,
              details: z.strictObject({
                role: roleSchema.optional(),
                active: z.boolean().optional(),
                environment: env.optional(),
                fromStatus: z.enum(["open", "triaged", "resolved"]).optional(),
                toStatus: z.enum(["open", "triaged", "resolved"]).optional(),
              }),
              createdAt: date,
            }),
          ),
        },
      },
    },
    async (request) =>
      identity.listAudit(principal(request).userId, request.params.orgId),
  );
}
