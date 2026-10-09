import { createHash, randomBytes } from "node:crypto";
import cookie from "@fastify/cookie";
import { hash, verify } from "@node-rs/argon2";
import type { SentinelClient } from "@sentinel/sdk";
import Fastify from "fastify";
import { z } from "zod";
import type { DemoResponseAdapter } from "./response-adapter.js";

export async function buildDemo(
  sdk: SentinelClient,
  passwords: { reader: string; admin: string },
  origin = "http://localhost:3002",
  responseAdapter?: DemoResponseAdapter,
) {
  const passwordSchema = z.string().min(15).max(128);
  const users = {
    reader: {
      id: "lab-reader",
      role: "user" as const,
      hash: await hash(passwordSchema.parse(passwords.reader), {
        memoryCost: 65536,
        timeCost: 3,
        parallelism: 1,
      }),
    },
    admin: {
      id: "lab-admin",
      role: "admin" as const,
      hash: await hash(passwordSchema.parse(passwords.admin), {
        memoryCost: 65536,
        timeCost: 3,
        parallelism: 1,
      }),
    },
  };
  type User = (typeof users)[keyof typeof users];
  const sessions = new Map<
    string,
    { user: User; csrf: string; expiresAt: number }
  >();
  const digest = (token: string) =>
    createHash("sha256").update(token).digest("hex");
  const app = Fastify({
    logger: false,
    trustProxy: false,
    bodyLimit: 4096,
    requestTimeout: 10_000,
  });
  await app.register(cookie);
  let settingsEnabled = false;
  let windowStart = Date.now();
  let requests = 0;
  let verifying = 0;
  app.addHook("onRequest", async (request, reply) => {
    if (
      request.url !== "/health/live" &&
      responseAdapter?.isBlocked(request.ip)
    )
      return reply.code(403).send({ message: "Temporary access restriction" });
    if (request.method !== "POST") return;
    if (request.headers.origin !== origin)
      return reply.code(403).send({ message: "Invalid request" });
    if (Date.now() - windowStart >= 60_000) {
      windowStart = Date.now();
      requests = 0;
    }
    if (++requests > 60)
      return reply
        .header("Retry-After", 60)
        .code(429)
        .send({ message: "Invalid request" });
  });
  app.addHook("onSend", async (_request, reply) => {
    reply
      .header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff");
  });
  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/lab/metrics", async () => sdk.stats());
  app.post("/login", async (request, reply) => {
    const body = z
      .strictObject({
        username: z.string().min(1).max(64),
        password: z.string().max(128),
      })
      .safeParse(request.body);
    if (!body.success)
      return reply.code(400).send({ message: "Invalid request" });
    const user =
      body.data.username === "reader"
        ? users.reader
        : body.data.username === "admin"
          ? users.admin
          : undefined;
    if (verifying >= 2)
      return reply.code(503).send({ message: "Lab capacity reached" });
    verifying++;
    let valid: boolean;
    try {
      valid = await verify(user?.hash ?? users.reader.hash, body.data.password);
    } finally {
      verifying--;
    }
    if (!user || !valid) {
      // The attempted username/password is never copied into the event.
      sdk.track({
        type: "auth.login_failed",
        action: "log_in",
        outcome: "failure",
        actor_id: user?.id ?? "lab-unknown",
        source_ip: request.ip,
        resource: "/login",
        metadata: { reason: "invalid_credentials" },
      });
      return reply.code(401).send({ message: "Invalid credentials" });
    }
    for (const [key, session] of sessions)
      if (session.expiresAt <= Date.now()) sessions.delete(key);
    if (sessions.size >= 256)
      return reply.code(503).send({ message: "Lab capacity reached" });
    const token = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(32).toString("base64url");
    const previous = request.cookies.lab_session;
    if (previous) sessions.delete(digest(previous));
    sessions.set(digest(token), {
      user,
      csrf: csrfToken,
      expiresAt: Date.now() + 30 * 60_000,
    });
    reply.setCookie("lab_session", token, {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      maxAge: 1800,
    });
    sdk.track({
      type: "auth.login_succeeded",
      action: "log_in",
      outcome: "success",
      actor_id: user.id,
      actor_role: user.role,
      source_ip: request.ip,
      resource: "/login",
      metadata: { auth_method: "password" },
    });
    return { user: { id: user.id, role: user.role }, csrfToken };
  });
  app.post("/admin/settings", async (request, reply) => {
    const token = request.cookies.lab_session;
    const session = token ? sessions.get(digest(token)) : undefined;
    if (!session || session.expiresAt <= Date.now())
      return reply.code(401).send({ message: "Invalid session" });
    if (request.headers["x-csrf-token"] !== session.csrf)
      return reply.code(403).send({ message: "Invalid request" });
    if (session.user.role !== "admin") {
      sdk.track({
        type: "authz.access_denied",
        action: "access_resource",
        outcome: "failure",
        actor_id: session.user.id,
        actor_role: session.user.role,
        source_ip: request.ip,
        resource: "/admin/settings",
        metadata: { permission: "settings.write", reason: "insufficient_role" },
      });
      return reply.code(403).send({ message: "Access denied" });
    }
    const body = z
      .strictObject({ enabled: z.boolean() })
      .safeParse(request.body);
    if (!body.success)
      return reply.code(400).send({ message: "Invalid request" });
    settingsEnabled = body.data.enabled;
    sdk.track({
      type: "admin.action",
      action: "change_settings",
      outcome: "success",
      actor_id: session.user.id,
      actor_role: "admin",
      source_ip: request.ip,
      resource: "/admin/settings",
      metadata: { target_id: "lab-settings" },
    });
    return { enabled: settingsEnabled };
  });
  app.setErrorHandler((error, _request, reply) => {
    const code =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number" &&
      error.statusCode >= 400 &&
      error.statusCode < 500
        ? error.statusCode
        : 500;
    reply.code(code).send({ message: "Lab operation failed" });
  });
  app.addHook("onClose", async () => {
    await sdk.close();
  });
  return app;
}
