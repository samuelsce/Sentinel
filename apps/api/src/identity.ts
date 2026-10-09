import { randomUUID } from "node:crypto";
import type { createDatabase } from "@sentinel/database";
import {
  AccessError,
  hashPassword,
  randomToken,
  secretHash,
  verifyPassword,
} from "./security.js";

type Pool = ReturnType<typeof createDatabase>["pool"];
type Client = Pick<Pool, "query">;
export type Role = "admin" | "analyst" | "reader";
export type Environment =
  | "demo"
  | "development"
  | "test"
  | "staging"
  | "production";
export type Principal = {
  sessionId: string;
  userId: string;
  email: string;
  csrfToken: string;
  expiresAt: Date;
};
declare module "fastify" {
  interface FastifyRequest {
    principal: Principal | null;
  }
}
type AuditAction =
  | "organization.created"
  | "member.provisioned"
  | "member.updated"
  | "project.created"
  | "key.created"
  | "key.revoked"
  | "alert.viewed"
  | "alert.status_changed"
  | "response.key_created"
  | "response.key_revoked"
  | "response.requested"
  | "response.applied"
  | "response.failed"
  | "response.expired"
  | "response.expiry_confirmed"
  | "rule.configured"
  | "report.exported";
type AuditDetails = {
  role?: Role;
  active?: boolean;
  version?: number;
  ttlSeconds?: number;
  evidenceCount?: number;
  ruleCode?: "AUTH-001" | "AUTHZ-001" | "ADMIN-001";
  adapterKeyId?: string;
  environment?: Environment;
  fromStatus?: "open" | "triaged" | "resolved";
  toStatus?: "open" | "triaged" | "resolved";
};
export const IDLE_MS = 30 * 60 * 1000;
export const ABSOLUTE_MS = 8 * 60 * 60 * 1000;
const dummyHash = hashPassword(randomToken());

export async function transaction<T>(
  pool: Pool,
  operation: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function audit(
  client: Client,
  organizationId: string,
  actor: string | null,
  action: AuditAction,
  subject: string,
  details: AuditDetails = {},
) {
  await client.query(
    "INSERT INTO audit_entries(organization_id,actor_user_id,action,subject_id,details) VALUES($1,$2,$3,$4,$5::jsonb)",
    [organizationId, actor, action, subject, JSON.stringify(details)],
  );
}

export class IdentityService {
  private verifying = 0;
  private cleanedAt = 0;
  constructor(
    readonly pool: Pool,
    readonly now: () => Date = () => new Date(),
  ) {}

  private async consumeBucket(
    kind: string,
    identity: string,
    limit: number,
    windowMs: number,
  ) {
    const now = this.now();
    const start = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
    const result = await this.pool.query<{ attempts: number }>(
      "INSERT INTO login_buckets(bucket,window_start,attempts) VALUES($1,$2,1) ON CONFLICT(bucket) DO UPDATE SET attempts=CASE WHEN login_buckets.window_start=EXCLUDED.window_start THEN login_buckets.attempts+1 ELSE 1 END,window_start=EXCLUDED.window_start RETURNING attempts",
      [secretHash(`login-${kind}`, identity), start],
    );
    if ((result.rows[0]?.attempts ?? limit + 1) > limit) {
      throw new AccessError(
        429,
        Math.ceil((start.getTime() + windowMs - now.getTime()) / 1000),
      );
    }
  }

  async login(
    email: string,
    password: string,
    ip: string,
    previousToken?: string,
  ) {
    // All counters survive API restarts. Global/IP limits precede account allocation.
    await this.consumeBucket("global", "single-api", 120, 60_000);
    await this.consumeBucket("ip", ip, 30, 900_000);
    await this.consumeBucket("account", email, 5, 900_000);
    if (this.verifying >= 2) throw new AccessError(429, 1);
    this.verifying++;
    try {
      if (this.now().getTime() - this.cleanedAt >= 60_000) {
        await this.pool.query(
          "DELETE FROM login_buckets WHERE window_start < $1",
          [new Date(this.now().getTime() - 86_400_000)],
        );
        this.cleanedAt = this.now().getTime();
      }
      const user = (
        await this.pool.query<{
          id: string;
          password_hash: string;
          disabled_at: Date | null;
        }>("SELECT id,password_hash,disabled_at FROM users WHERE email=$1", [
          email,
        ])
      ).rows[0];
      const valid = await verifyPassword(
        user?.password_hash ?? (await dummyHash),
        password,
      );
      if (!valid || !user || user.disabled_at) throw new AccessError(401);
      const token = randomToken();
      const csrfToken = randomToken();
      const now = this.now();
      const expiresAt = new Date(now.getTime() + ABSOLUTE_MS);
      const session = await transaction(this.pool, async (client) => {
        const current = (
          await client.query<{ password_hash: string }>(
            "SELECT password_hash FROM users WHERE id=$1 AND disabled_at IS NULL FOR UPDATE",
            [user.id],
          )
        ).rows[0];
        if (current?.password_hash !== user.password_hash)
          throw new AccessError(401);
        const member = await client.query(
          "SELECT 1 FROM memberships WHERE user_id=$1 AND active=true LIMIT 1",
          [user.id],
        );
        if (!member.rowCount) throw new AccessError(401);
        if (previousToken)
          await client.query(
            "UPDATE sessions SET revoked_at=$1 WHERE token_hash=$2 AND revoked_at IS NULL",
            [now, secretHash("session", previousToken)],
          );
        // Bound live sessions per user; older sessions are revoked, never reused.
        await client.query(
          "UPDATE sessions SET revoked_at=$2 WHERE user_id=$1 AND revoked_at IS NULL AND id NOT IN (SELECT id FROM sessions WHERE user_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC,id DESC LIMIT 9)",
          [user.id, now],
        );
        return (
          await client.query<{ id: string }>(
            "INSERT INTO sessions(user_id,token_hash,csrf_token,created_at,last_seen_at,expires_at) VALUES($1,$2,$3,$4,$4,$5) RETURNING id",
            [user.id, secretHash("session", token), csrfToken, now, expiresAt],
          )
        ).rows[0];
      });
      if (!session) throw new Error("Session creation failed");
      return {
        token,
        csrfToken,
        expiresAt,
        sessionId: session.id,
        userId: user.id,
        email,
      };
    } finally {
      this.verifying--;
    }
  }

  async authenticate(
    token: string | undefined,
    touch = true,
  ): Promise<Principal> {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new AccessError(401);
    const now = this.now();
    const session = (
      await this.pool.query<{
        id: string;
        user_id: string;
        email: string;
        csrf_token: string;
        expires_at: Date;
      }>(
        touch
          ? "UPDATE sessions s SET last_seen_at=$2 FROM users u WHERE s.token_hash=$1 AND s.user_id=u.id AND u.disabled_at IS NULL AND s.revoked_at IS NULL AND s.expires_at>$2 AND s.last_seen_at>$3 RETURNING s.id,s.user_id,u.email,s.csrf_token,s.expires_at"
          : "SELECT s.id,s.user_id,u.email,s.csrf_token,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND u.disabled_at IS NULL AND s.revoked_at IS NULL AND s.expires_at>$2 AND s.last_seen_at>$3",
        [secretHash("session", token), now, new Date(now.getTime() - IDLE_MS)],
      )
    ).rows[0];
    if (!session) throw new AccessError(401);
    return {
      sessionId: session.id,
      userId: session.user_id,
      email: session.email,
      csrfToken: session.csrf_token,
      expiresAt: session.expires_at,
    };
  }

  async revokeSession(userId: string, id: string) {
    const result = await this.pool.query(
      "UPDATE sessions SET revoked_at=COALESCE(revoked_at,$3) WHERE id=$1 AND user_id=$2 RETURNING id",
      [id, userId, this.now()],
    );
    if (!result.rowCount) throw new AccessError(404);
  }

  async listSessions(principal: Principal) {
    const result = await this.pool.query<{
      id: string;
      created_at: Date;
      last_seen_at: Date;
      expires_at: Date;
      revoked_at: Date | null;
    }>(
      "SELECT id,created_at,last_seen_at,expires_at,revoked_at FROM sessions WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 50",
      [principal.userId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at.toISOString(),
      lastSeenAt: row.last_seen_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
      revokedAt: row.revoked_at?.toISOString() ?? null,
      current: row.id === principal.sessionId,
    }));
  }

  async listOrganizations(userId: string) {
    return (
      await this.pool.query<{ id: string; name: string; role: Role }>(
        "SELECT o.id,o.name,m.role FROM organizations o JOIN memberships m ON m.organization_id=o.id WHERE m.user_id=$1 AND m.active=true ORDER BY o.created_at,o.id LIMIT 100",
        [userId],
      )
    ).rows;
  }

  private async authorize(
    client: Client,
    userId: string,
    organizationId: string,
    roles: readonly Role[],
  ) {
    const member = (
      await client.query<{ role: Role }>(
        "SELECT role FROM memberships WHERE organization_id=$1 AND user_id=$2 AND active=true",
        [organizationId, userId],
      )
    ).rows[0];
    if (!member) throw new AccessError(404);
    if (!roles.includes(member.role)) throw new AccessError(403);
  }

  private async mutateOrganization<T>(
    userId: string,
    orgId: string,
    operation: (client: Client) => Promise<T>,
  ): Promise<T> {
    return transaction(this.pool, async (client) => {
      // Serialize membership changes and mutations to protect the last administrator.
      await client.query(
        "SELECT id FROM organizations WHERE id=$1 FOR UPDATE",
        [orgId],
      );
      await this.authorize(client, userId, orgId, ["admin"]);
      return operation(client);
    });
  }

  async listProjects(userId: string, orgId: string) {
    await this.authorize(this.pool, userId, orgId, [
      "admin",
      "analyst",
      "reader",
    ]);
    return (
      await this.pool.query<{ id: string; name: string; created_at: Date }>(
        "SELECT id,name,created_at FROM projects WHERE organization_id=$1 ORDER BY created_at,id LIMIT 100",
        [orgId],
      )
    ).rows.map((row) => ({
      id: row.id,
      name: row.name,
      createdAt: row.created_at.toISOString(),
    }));
  }

  async getProject(userId: string, orgId: string, projectId: string) {
    await this.authorize(this.pool, userId, orgId, [
      "admin",
      "analyst",
      "reader",
    ]);
    const project = (
      await this.pool.query<{ id: string; name: string; created_at: Date }>(
        "SELECT id,name,created_at FROM projects WHERE organization_id=$1 AND id=$2",
        [orgId, projectId],
      )
    ).rows[0];
    if (!project) throw new AccessError(404);
    return {
      id: project.id,
      name: project.name,
      createdAt: project.created_at.toISOString(),
    };
  }

  async createProject(userId: string, orgId: string, name: string) {
    return this.mutateOrganization(userId, orgId, async (client) => {
      const project = (
        await client.query<{ id: string; name: string; created_at: Date }>(
          "INSERT INTO projects(organization_id,name) VALUES($1,$2) RETURNING id,name,created_at",
          [orgId, name],
        )
      ).rows[0];
      if (!project) throw new Error("Project creation failed");
      await audit(client, orgId, userId, "project.created", project.id);
      return {
        id: project.id,
        name: project.name,
        createdAt: project.created_at.toISOString(),
      };
    });
  }

  private async requireProject(
    client: Client,
    orgId: string,
    projectId: string,
  ) {
    if (
      !(
        await client.query(
          "SELECT 1 FROM projects WHERE organization_id=$1 AND id=$2",
          [orgId, projectId],
        )
      ).rowCount
    )
      throw new AccessError(404);
  }

  async issueKey(
    userId: string,
    orgId: string,
    projectId: string,
    environment: Environment,
  ) {
    return this.mutateOrganization(userId, orgId, async (client) => {
      await this.requireProject(client, orgId, projectId);
      const id = randomUUID();
      const prefix = `snt_ing_${id}`;
      const key = `${prefix}.${randomToken()}`;
      await client.query(
        "INSERT INTO ingestion_keys(id,organization_id,project_id,environment,prefix,key_hash) VALUES($1,$2,$3,$4,$5,$6)",
        [
          id,
          orgId,
          projectId,
          environment,
          prefix,
          secretHash("ingestion", key),
        ],
      );
      await audit(client, orgId, userId, "key.created", id, { environment });
      return { id, prefix, environment, key };
    });
  }

  async listKeys(userId: string, orgId: string, projectId: string) {
    await this.authorize(this.pool, userId, orgId, ["admin"]);
    await this.requireProject(this.pool, orgId, projectId);
    return (
      await this.pool.query<{
        id: string;
        prefix: string;
        environment: Environment;
        created_at: Date;
        revoked_at: Date | null;
      }>(
        "SELECT id,prefix,environment,created_at,revoked_at FROM ingestion_keys WHERE organization_id=$1 AND project_id=$2 ORDER BY created_at,id LIMIT 100",
        [orgId, projectId],
      )
    ).rows.map((row) => ({
      id: row.id,
      prefix: row.prefix,
      environment: row.environment,
      createdAt: row.created_at.toISOString(),
      revokedAt: row.revoked_at?.toISOString() ?? null,
    }));
  }

  async revokeKey(
    userId: string,
    orgId: string,
    projectId: string,
    keyId: string,
  ) {
    await this.mutateOrganization(userId, orgId, async (client) => {
      const row = (
        await client.query<{ revoked_at: Date | null }>(
          "SELECT revoked_at FROM ingestion_keys WHERE organization_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE",
          [orgId, projectId, keyId],
        )
      ).rows[0];
      if (!row) throw new AccessError(404);
      if (!row.revoked_at) {
        await client.query(
          "UPDATE ingestion_keys SET revoked_at=$4 WHERE organization_id=$1 AND project_id=$2 AND id=$3",
          [orgId, projectId, keyId, this.now()],
        );
        await audit(client, orgId, userId, "key.revoked", keyId);
      }
    });
  }

  async authenticateIngestionKey(key: string) {
    if (!/^snt_ing_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(key))
      throw new AccessError(401);
    const scope = (
      await this.pool.query<{
        organization_id: string;
        project_id: string;
        environment: Environment;
        id: string;
      }>(
        "SELECT organization_id,project_id,environment,id FROM ingestion_keys WHERE key_hash=$1 AND revoked_at IS NULL",
        [secretHash("ingestion", key)],
      )
    ).rows[0];
    if (!scope) throw new AccessError(401);
    return {
      organizationId: scope.organization_id,
      projectId: scope.project_id,
      environment: scope.environment,
      keyId: scope.id,
    };
  }

  async listMembers(userId: string, orgId: string) {
    await this.authorize(this.pool, userId, orgId, ["admin"]);
    return (
      await this.pool.query<{
        userId: string;
        email: string;
        role: Role;
        active: boolean;
      }>(
        'SELECT m.user_id AS "userId",u.email,m.role,m.active FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=$1 ORDER BY m.created_at,m.user_id LIMIT 100',
        [orgId],
      )
    ).rows;
  }

  async updateMember(
    userId: string,
    orgId: string,
    targetId: string,
    change: { role: Role; active: boolean },
  ) {
    await this.mutateOrganization(userId, orgId, async (client) => {
      const member = (
        await client.query<{ role: Role; active: boolean }>(
          "SELECT role,active FROM memberships WHERE organization_id=$1 AND user_id=$2 FOR UPDATE",
          [orgId, targetId],
        )
      ).rows[0];
      if (!member) throw new AccessError(404);
      if (
        member.active &&
        member.role === "admin" &&
        (!change.active || change.role !== "admin")
      ) {
        const other = await client.query(
          "SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=$1 AND m.user_id<>$2 AND m.role='admin' AND m.active=true AND u.disabled_at IS NULL LIMIT 1",
          [orgId, targetId],
        );
        if (!other.rowCount) throw new AccessError(409);
      }
      await client.query(
        "UPDATE memberships SET role=$3,active=$4 WHERE organization_id=$1 AND user_id=$2",
        [orgId, targetId, change.role, change.active],
      );
      await audit(client, orgId, userId, "member.updated", targetId, change);
    });
  }

  async listAudit(userId: string, orgId: string) {
    await this.authorize(this.pool, userId, orgId, ["admin", "analyst"]);
    return (
      await this.pool.query<{
        id: string;
        actor_user_id: string | null;
        action: AuditAction;
        subject_id: string;
        details: AuditDetails;
        created_at: Date;
      }>(
        "SELECT id,actor_user_id,action,subject_id,details,created_at FROM audit_entries WHERE organization_id=$1 ORDER BY created_at DESC,id DESC LIMIT 50",
        [orgId],
      )
    ).rows.map((row) => ({
      id: row.id,
      actorUserId: row.actor_user_id,
      action: row.action,
      subjectId: row.subject_id,
      details: row.details,
      createdAt: row.created_at.toISOString(),
    }));
  }
}

// Privileged local provisioning; password is never reset or supplied by an HTTP request.
export async function provisionMember(
  pool: Pool,
  input: {
    email: string;
    password?: string;
    organizationId?: string;
    organizationName?: string;
    role: Role;
  },
) {
  const passwordHash =
    input.password === undefined
      ? undefined
      : await hashPassword(input.password);
  return transaction(pool, async (client) => {
    const user =
      passwordHash === undefined
        ? (
            await client.query<{ id: string }>(
              "SELECT id FROM users WHERE email=$1 AND disabled_at IS NULL",
              [input.email],
            )
          ).rows[0]
        : (
            await client.query<{ id: string }>(
              "INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id",
              [input.email, passwordHash],
            )
          ).rows[0];
    if (!user) throw new Error("Provisioning failed");
    let orgId = input.organizationId;
    if (orgId) {
      if (
        !(
          await client.query(
            "SELECT 1 FROM organizations WHERE id=$1 FOR UPDATE",
            [orgId],
          )
        ).rowCount
      )
        throw new AccessError(404);
    } else {
      if (!input.organizationName || input.role !== "admin")
        throw new AccessError(400);
      orgId = (
        await client.query<{ id: string }>(
          "INSERT INTO organizations(name) VALUES($1) RETURNING id",
          [input.organizationName],
        )
      ).rows[0]?.id;
      if (!orgId) throw new Error("Provisioning failed");
      await audit(client, orgId, null, "organization.created", orgId);
    }
    await client.query(
      "INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,$3)",
      [orgId, user.id, input.role],
    );
    await audit(client, orgId, null, "member.provisioned", user.id, {
      role: input.role,
      active: true,
    });
    return { userId: user.id, organizationId: orgId, role: input.role };
  });
}
