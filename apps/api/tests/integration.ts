import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { createDatabase } from "@sentinel/database";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { applyMigrations } from "../../../packages/database/src/migrations.js";
import { buildApp } from "../src/app.js";
import { readConfig } from "../src/config.js";
import {
  ABSOLUTE_MS,
  IDLE_MS,
  IdentityService,
  provisionMember,
} from "../src/identity.js";
import { randomToken, secretHash, verifyPassword } from "../src/security.js";

const url = process.env.TEST_DATABASE_URL;
if (
  !url ||
  new URL(url).pathname !== "/sentinel_test" ||
  !process.env.SENTINEL_API_DB_PASSWORD
)
  throw new Error(
    "Identity integration requires the isolated sentinel_test database and API role",
  );
await applyMigrations(url);
await applyMigrations(url);
const owner = createDatabase(url);
const apiUrl = new URL(url);
apiUrl.username = "sentinel_api";
apiUrl.password = process.env.SENTINEL_API_DB_PASSWORD;
const runtime = createDatabase(apiUrl.toString());
let clock = new Date();
const service = new IdentityService(runtime.pool, () => clock);
let logs = "";
const stream = new Writable({
  write(chunk, _encoding, callback) {
    logs += chunk.toString();
    callback();
  },
});
const config = readConfig({
  API_DATABASE_URL: apiUrl.toString(),
  NODE_ENV: "test",
  LOG_LEVEL: "info",
});
const app = await buildApp(config, {
  isReady: async () => true,
  identity: service,
  logDestination: stream,
});
const marker = randomUUID();
const fixtures = Array.from({ length: 5 }, (_, index) => ({
  email: `m2-${marker}-${index}@example.invalid`,
  password: randomToken(),
}));
const [a, b, analyst, reader, secondAdmin] = fixtures;
assert.ok(a && b && analyst && reader && secondAdmin);
const userIds: string[] = [];
const orgIds: string[] = [];
const lock = await owner.pool.connect();
await lock.query(
  "SELECT pg_advisory_lock(hashtext('sentinel-m2-integration'))",
);
let scenarios = 0;
async function scenario(name: string, operation: () => Promise<void>) {
  await operation();
  scenarios++;
  console.log(`PASS ${name}`);
}
type Session = { cookie: string; csrf: string; userId: string };
async function login(
  fixture: { email: string; password: string },
  previous?: Session,
): Promise<Session> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    headers: {
      origin: config.APP_ORIGIN,
      ...(previous ? { cookie: previous.cookie } : {}),
    },
    payload: fixture,
  });
  assert.equal(response.statusCode, 200, "Fixture login should succeed");
  const setCookie = response.headers["set-cookie"];
  assert.equal(typeof setCookie, "string");
  assert.ok(typeof setCookie === "string");
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Path=\//);
  assert.equal(response.headers["cache-control"], "no-store");
  const body = response.json<{ csrfToken: string; user: { id: string } }>();
  return {
    cookie: setCookie.split(";")[0] ?? "",
    csrf: body.csrfToken,
    userId: body.user.id,
  };
}
function headers(session: Session) {
  return {
    cookie: session.cookie,
    origin: config.APP_ORIGIN,
    "x-csrf-token": session.csrf,
  };
}
const scoped = (orgId: string) => `/v1/organizations/${orgId}`;
try {
  await owner.pool.query("DELETE FROM login_buckets");
  const orgA = await provisionMember(owner.pool, {
    ...a,
    organizationName: "M2 A",
    role: "admin",
  });
  userIds.push(orgA.userId);
  orgIds.push(orgA.organizationId);
  const orgB = await provisionMember(owner.pool, {
    ...b,
    organizationName: "M2 B",
    role: "admin",
  });
  userIds.push(orgB.userId);
  orgIds.push(orgB.organizationId);
  for (const [fixture, role] of [
    [analyst, "analyst"],
    [reader, "reader"],
    [secondAdmin, "admin"],
  ] as const) {
    userIds.push(
      (
        await provisionMember(owner.pool, {
          ...fixture,
          organizationId: orgA.organizationId,
          role,
        })
      ).userId,
    );
  }
  const rootA = scoped(orgA.organizationId);
  const rootB = scoped(orgB.organizationId);
  await scenario(
    "Argon2id storage, actual API role and private worker privileges",
    async () => {
      const row = (
        await owner.pool.query<{ password_hash: string }>(
          "SELECT password_hash FROM users WHERE id=$1",
          [orgA.userId],
        )
      ).rows[0];
      assert.ok(row);
      assert.match(row.password_hash, /^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
      assert.equal(await verifyPassword(row.password_hash, a.password), true);
      assert.equal(
        await verifyPassword(row.password_hash, "incorrect-password"),
        false,
      );
      const role = (await runtime.pool.query("SELECT current_user AS name"))
        .rows[0];
      assert.equal(role?.name, "sentinel_api");
      const privileges = (
        await owner.pool.query(
          "SELECT has_table_privilege('sentinel_detector','sessions','SELECT') AS sessions,has_table_privilege('sentinel_detector','audit_entries','SELECT') AS audit,has_table_privilege('sentinel_api','audit_entries','UPDATE') AS audit_update,has_table_privilege('sentinel_api','audit_entries','DELETE') AS audit_delete",
        )
      ).rows[0];
      assert.deepEqual(privileges, {
        sessions: false,
        audit: false,
        audit_update: false,
        audit_delete: false,
      });
    },
  );
  await scenario(
    "login CSRF, generic credentials and strict body limits",
    async () => {
      for (const origin of [undefined, "https://attacker.invalid"]) {
        assert.equal(
          (
            await app.inject({
              method: "POST",
              url: "/v1/auth/login",
              headers: origin ? { origin } : {},
              payload: a,
            })
          ).statusCode,
          403,
        );
      }
      const failures = [];
      for (const payload of [
        { email: a.email, password: "incorrect-password" },
        {
          email: `missing-${marker}@example.invalid`,
          password: "incorrect-password",
        },
      ]) {
        const response = await app.inject({
          method: "POST",
          url: "/v1/auth/login",
          headers: { origin: config.APP_ORIGIN },
          payload,
        });
        assert.equal(response.statusCode, 401);
        assert.equal(response.headers["set-cookie"], undefined);
        failures.push(response.body);
      }
      assert.equal(failures[0], failures[1]);
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/v1/auth/login",
            headers: { origin: config.APP_ORIGIN },
            payload: { ...a, role: "admin" },
          })
        ).statusCode,
        400,
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/v1/auth/login",
            headers: { origin: config.APP_ORIGIN },
            payload: { email: a.email, password: "x".repeat(9000) },
          })
        ).statusCode,
        413,
      );
    },
  );
  let admin = await login(a);
  const adminB = await login(b);
  const analystSession = await login(analyst);
  const readerSession = await login(reader);
  const otherAdmin = await login(secondAdmin);
  let projectA = "";
  let projectB = "";
  let credential = "";
  let keyId = "";
  await scenario(
    "organization visibility and session tokens stored only as hashes",
    async () => {
      const response = await app.inject({
        url: "/v1/organizations",
        headers: headers(admin),
      });
      assert.deepEqual(response.json(), [
        { id: orgA.organizationId, name: "M2 A", role: "admin" },
      ]);
      const raw = admin.cookie.split("=")[1] ?? "";
      const session = (
        await owner.pool.query<{ token_hash: string }>(
          "SELECT token_hash FROM sessions WHERE user_id=$1",
          [admin.userId],
        )
      ).rows[0];
      assert.equal(session?.token_hash, secretHash("session", raw));
      assert.notEqual(session?.token_hash, raw);
      assert.equal((await app.inject("/v1/auth/session")).statusCode, 401);
    },
  );
  await scenario(
    "CSRF token required and bound to the current session",
    async () => {
      for (const attempt of [
        { cookie: admin.cookie, origin: config.APP_ORIGIN },
        { ...headers(admin), "x-csrf-token": readerSession.csrf },
        { ...headers(admin), origin: "https://attacker.invalid" },
        { ...headers(admin), "sec-fetch-site": "cross-site" },
      ]) {
        assert.equal(
          (
            await app.inject({
              method: "POST",
              url: `${rootA}/projects`,
              headers: attempt,
              payload: { name: "Forbidden" },
            })
          ).statusCode,
          403,
        );
      }
      for (const [session, root, name] of [
        [admin, rootA, "Application A"],
        [adminB, rootB, "Application B"],
      ] as const) {
        const response = await app.inject({
          method: "POST",
          url: `${root}/projects`,
          headers: headers(session),
          payload: { name },
        });
        assert.equal(response.statusCode, 201);
        if (root === rootA) projectA = response.json<{ id: string }>().id;
        else projectB = response.json<{ id: string }>().id;
      }
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: `${rootA}/projects`,
            headers: headers(admin),
            payload: { name: "Invalid", organizationId: orgB.organizationId },
          })
        ).statusCode,
        400,
      );
    },
  );
  await scenario(
    "reader and analyst can read projects but cannot mutate projects or keys",
    async () => {
      for (const session of [readerSession, analystSession]) {
        assert.equal(
          (
            await app.inject({
              url: `${rootA}/projects/${projectA}`,
              headers: headers(session),
            })
          ).statusCode,
          200,
        );
        assert.equal(
          (
            await app.inject({
              method: "POST",
              url: `${rootA}/projects`,
              headers: headers(session),
              payload: { name: "Forbidden" },
            })
          ).statusCode,
          403,
        );
        assert.equal(
          (
            await app.inject({
              method: "POST",
              url: `${rootA}/projects/${projectA}/keys`,
              headers: headers(session),
              payload: { environment: "production" },
            })
          ).statusCode,
          403,
        );
        assert.equal(
          (
            await app.inject({
              url: `${rootA}/projects/${projectA}/keys`,
              headers: headers(session),
            })
          ).statusCode,
          403,
        );
        assert.equal(
          (
            await app.inject({
              url: `${rootA}/members`,
              headers: headers(session),
            })
          ).statusCode,
          403,
        );
        assert.equal(
          (
            await app.inject({
              method: "PATCH",
              url: `${rootA}/members/${admin.userId}`,
              headers: headers(session),
              payload: { role: "reader", active: true },
            })
          ).statusCode,
          403,
        );
      }
    },
  );
  await scenario(
    "known foreign organizations and project IDs match nonexistent responses",
    async () => {
      const missing = await app.inject({
        url: `${rootA}/projects/${randomUUID()}`,
        headers: headers(admin),
      });
      for (const path of [
        `${rootB}/projects`,
        `${rootA}/projects/${projectB}`,
        `${rootB}/projects/${projectB}/keys`,
        `${rootB}/members`,
        `${rootB}/audit`,
      ]) {
        const response = await app.inject({
          url: path,
          headers: headers(admin),
        });
        assert.equal(response.statusCode, 404);
        assert.equal(response.body, missing.body);
      }
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: `${rootA}/projects/${projectB}/keys`,
            headers: headers(admin),
            payload: { environment: "demo" },
          })
        ).statusCode,
        404,
      );
    },
  );
  await scenario(
    "ingestion credentials expose their secret once and derive immutable scope",
    async () => {
      const response = await app.inject({
        method: "POST",
        url: `${rootA}/projects/${projectA}/keys`,
        headers: headers(admin),
        payload: { environment: "production" },
      });
      assert.equal(response.statusCode, 201);
      assert.equal(response.headers["cache-control"], "no-store");
      const issued = response.json<{ id: string; key: string }>();
      keyId = issued.id;
      credential = issued.key;
      assert.deepEqual(await service.authenticateIngestionKey(credential), {
        organizationId: orgA.organizationId,
        projectId: projectA,
        environment: "production",
        keyId,
      });
      await assert.rejects(service.authenticateIngestionKey(`${credential}x`), {
        statusCode: 401,
      });
      const stored = (
        await owner.pool.query<{ key_hash: string }>(
          "SELECT key_hash FROM ingestion_keys WHERE id=$1",
          [keyId],
        )
      ).rows[0];
      assert.equal(stored?.key_hash, secretHash("ingestion", credential));
      const listing = await app.inject({
        url: `${rootA}/projects/${projectA}/keys`,
        headers: headers(admin),
      });
      assert.equal(listing.statusCode, 200);
      assert.ok(!listing.body.includes(credential));
      assert.ok(!listing.body.includes(stored?.key_hash ?? "invalid"));
      assert.equal(
        (
          await app.inject({
            url: "/v1/organizations",
            headers: { authorization: `Bearer ${credential}` },
          })
        ).statusCode,
        401,
      );
      assert.equal(
        (
          await app.inject({
            url: "/v1/auth/session",
            headers: { cookie: `sentinel_session=${credential}` },
          })
        ).statusCode,
        401,
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: `${rootA}/projects/${projectA}/keys`,
            headers: headers(admin),
            payload: {
              environment: "demo",
              organizationId: orgB.organizationId,
            },
          })
        ).statusCode,
        400,
      );
    },
  );
  await scenario(
    "revocation is scoped, idempotent and immediately rejects the key",
    async () => {
      assert.equal(
        (
          await app.inject({
            method: "DELETE",
            url: `${rootB}/projects/${projectB}/keys/${keyId}`,
            headers: headers(adminB),
          })
        ).statusCode,
        404,
      );
      assert.equal(
        (
          await app.inject({
            method: "DELETE",
            url: `${rootA}/projects/${projectA}/keys/${keyId}`,
            headers: headers(readerSession),
          })
        ).statusCode,
        403,
      );
      for (let i = 0; i < 2; i++)
        assert.equal(
          (
            await app.inject({
              method: "DELETE",
              url: `${rootA}/projects/${projectA}/keys/${keyId}`,
              headers: headers(admin),
            })
          ).statusCode,
          204,
        );
      await assert.rejects(service.authenticateIngestionKey(credential), {
        statusCode: 401,
      });
      const entries = await owner.pool.query(
        "SELECT 1 FROM audit_entries WHERE subject_id=$1 AND action='key.revoked'",
        [keyId],
      );
      assert.equal(entries.rowCount, 1);
    },
  );
  await scenario(
    "audit has sanitized actions, preserves transactions and respects roles",
    async () => {
      const response = await app.inject({
        url: `${rootA}/audit`,
        headers: headers(analystSession),
      });
      assert.equal(response.statusCode, 200);
      assert.ok(response.body.includes("key.created"));
      assert.ok(!response.body.includes(credential));
      assert.ok(!response.body.includes(a.password));
      assert.ok(
        response
          .json<Array<{ actorUserId: string | null }>>()
          .some((entry) => entry.actorUserId === null),
      );
      assert.equal(
        (
          await app.inject({
            url: `${rootA}/audit`,
            headers: headers(readerSession),
          })
        ).statusCode,
        403,
      );
      const counts = async () =>
        (
          await owner.pool.query(
            "SELECT (SELECT count(*) FROM projects WHERE organization_id=$1)::int AS projects,(SELECT count(*) FROM audit_entries WHERE organization_id=$1)::int AS audit",
            [orgA.organizationId],
          )
        ).rows[0];
      const before = await counts();
      await owner.pool.query(
        "CREATE FUNCTION m2_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test audit failure'; END $$; CREATE TRIGGER m2_reject_audit_trigger BEFORE INSERT ON audit_entries FOR EACH ROW EXECUTE FUNCTION m2_reject_audit()",
      );
      try {
        assert.equal(
          (
            await app.inject({
              method: "POST",
              url: `${rootA}/projects`,
              headers: headers(admin),
              payload: { name: "Must roll back" },
            })
          ).statusCode,
          500,
        );
        assert.deepEqual(await counts(), before);
      } finally {
        await owner.pool.query(
          "DROP TRIGGER m2_reject_audit_trigger ON audit_entries; DROP FUNCTION m2_reject_audit()",
        );
      }
    },
  );
  await scenario(
    "membership changes take effect without logging in again",
    async () => {
      assert.equal(
        (
          await app.inject({
            method: "PATCH",
            url: `${rootA}/members/${readerSession.userId}`,
            headers: headers(admin),
            payload: { role: "analyst", active: true },
          })
        ).statusCode,
        204,
      );
      assert.equal(
        (
          await app.inject({
            url: `${rootA}/audit`,
            headers: headers(readerSession),
          })
        ).statusCode,
        200,
      );
      assert.equal(
        (
          await app.inject({
            method: "PATCH",
            url: `${rootA}/members/${readerSession.userId}`,
            headers: headers(admin),
            payload: { role: "reader", active: false },
          })
        ).statusCode,
        204,
      );
      assert.equal(
        (
          await app.inject({
            url: `${rootA}/projects`,
            headers: headers(readerSession),
          })
        ).statusCode,
        404,
      );
      assert.deepEqual(
        (
          await app.inject({
            url: "/v1/organizations",
            headers: headers(readerSession),
          })
        ).json(),
        [],
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/v1/auth/login",
            headers: { origin: config.APP_ORIGIN },
            payload: reader,
          })
        ).statusCode,
        401,
      );
    },
  );
  await scenario(
    "the last active administrator survives concurrent demotions",
    async () => {
      const results = await Promise.all([
        app.inject({
          method: "PATCH",
          url: `${rootA}/members/${admin.userId}`,
          headers: headers(admin),
          payload: { role: "reader", active: true },
        }),
        app.inject({
          method: "PATCH",
          url: `${rootA}/members/${otherAdmin.userId}`,
          headers: headers(otherAdmin),
          payload: { role: "reader", active: true },
        }),
      ]);
      assert.deepEqual(
        results.map((response) => response.statusCode).sort(),
        [204, 409],
      );
      assert.equal(
        (
          await owner.pool.query(
            "SELECT 1 FROM memberships WHERE organization_id=$1 AND role='admin' AND active=true",
            [orgA.organizationId],
          )
        ).rowCount,
        1,
      );
    },
  );
  await scenario(
    "login rotates session and CSRF; users cannot revoke another user's session",
    async () => {
      const old = admin;
      admin = await login(a, old);
      assert.notEqual(admin.cookie, old.cookie);
      assert.notEqual(admin.csrf, old.csrf);
      assert.equal(
        (await app.inject({ url: "/v1/auth/session", headers: headers(old) }))
          .statusCode,
        401,
      );
      const own = (
        await app.inject({ url: "/v1/auth/sessions", headers: headers(admin) })
      )
        .json<Array<{ id: string; current: boolean }>>()
        .find((session) => session.current);
      assert.ok(own);
      assert.equal(
        (
          await app.inject({
            method: "DELETE",
            url: `/v1/auth/sessions/${own.id}`,
            headers: headers(adminB),
          })
        ).statusCode,
        404,
      );
      assert.equal(
        (
          await app.inject({
            method: "DELETE",
            url: `/v1/auth/sessions/${own.id}`,
            headers: { ...headers(admin), "x-csrf-token": old.csrf },
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await app.inject({
            method: "DELETE",
            url: `/v1/auth/sessions/${own.id}`,
            headers: headers(admin),
          })
        ).statusCode,
        204,
      );
      assert.equal(
        (await app.inject({ url: "/v1/auth/session", headers: headers(admin) }))
          .statusCode,
        401,
      );
    },
  );
  await scenario(
    "logout revokes the session, requires CSRF and clears the cookie",
    async () => {
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/v1/auth/logout",
            headers: { cookie: adminB.cookie, origin: config.APP_ORIGIN },
          })
        ).statusCode,
        403,
      );
      const response = await app.inject({
        method: "POST",
        url: "/v1/auth/logout",
        headers: headers(adminB),
      });
      assert.equal(response.statusCode, 204);
      assert.ok(response.headers["set-cookie"]);
      assert.equal(
        (
          await app.inject({
            url: "/v1/auth/session",
            headers: headers(adminB),
          })
        ).statusCode,
        401,
      );
    },
  );
  await scenario(
    "idle and absolute expiration are evaluated on every request",
    async () => {
      const idle = await login(b);
      clock = new Date(clock.getTime() + IDLE_MS);
      assert.equal(
        (await app.inject({ url: "/v1/auth/session", headers: headers(idle) }))
          .statusCode,
        401,
      );
      const absolute = await login(b);
      // Regular activity keeps the session idle timer fresh but cannot extend its absolute expiry.
      for (
        let elapsed = 20 * 60_000;
        elapsed < ABSOLUTE_MS;
        elapsed += 20 * 60_000
      ) {
        clock = new Date(clock.getTime() + 20 * 60_000);
        assert.equal(
          (
            await app.inject({
              url: "/v1/auth/session",
              headers: headers(absolute),
            })
          ).statusCode,
          200,
        );
      }
      clock = new Date(clock.getTime() + 20 * 60_000);
      assert.equal(
        (
          await app.inject({
            url: "/v1/auth/session",
            headers: headers(absolute),
          })
        ).statusCode,
        401,
      );
    },
  );
  await scenario(
    "disabled users lose access through an existing session",
    async () => {
      const session = await login(b);
      await owner.pool.query("UPDATE users SET disabled_at=now() WHERE id=$1", [
        session.userId,
      ]);
      assert.equal(
        (
          await app.inject({
            url: "/v1/auth/session",
            headers: headers(session),
          })
        ).statusCode,
        401,
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/v1/auth/login",
            headers: { origin: config.APP_ORIGIN },
            payload: b,
          })
        ).statusCode,
        401,
      );
    },
  );
  await scenario(
    "account rate limits persist across API instances and expire predictably",
    async () => {
      const payload = {
        email: `rate-${marker}@example.invalid`,
        password: "incorrect-password",
      };
      for (let i = 0; i < 5; i++)
        assert.equal(
          (
            await app.inject({
              method: "POST",
              url: "/v1/auth/login",
              headers: { origin: config.APP_ORIGIN },
              payload,
            })
          ).statusCode,
          401,
        );
      const rejected = await app.inject({
        method: "POST",
        url: "/v1/auth/login",
        headers: { origin: config.APP_ORIGIN },
        payload,
      });
      assert.equal(rejected.statusCode, 429);
      assert.ok(Number(rejected.headers["retry-after"]) > 0);
      const restarted = new IdentityService(runtime.pool, () => clock);
      await assert.rejects(
        restarted.login(payload.email, payload.password, "127.0.0.1"),
        { statusCode: 429 },
      );
      clock = new Date(clock.getTime() + 900_000);
      await assert.rejects(
        restarted.login(payload.email, payload.password, "127.0.0.1"),
        { statusCode: 401 },
      );
    },
  );
  await scenario(
    "IP limits cannot be bypassed by forged proxy headers; global limits precede account allocation",
    async () => {
      clock = new Date(clock.getTime() + 900_000);
      for (let i = 0; i < 30; i++) {
        assert.equal(
          (
            await app.inject({
              method: "POST",
              url: "/v1/auth/login",
              headers: { origin: config.APP_ORIGIN },
              payload: {
                email: `ip-${marker}-${i}@example.invalid`,
                password: "incorrect-password",
              },
            })
          ).statusCode,
          401,
        );
      }
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/v1/auth/login",
            headers: {
              origin: config.APP_ORIGIN,
              "x-forwarded-for": "192.0.2.45",
            },
            payload: {
              email: `ip-over-${marker}@example.invalid`,
              password: "incorrect-password",
            },
          })
        ).statusCode,
        429,
      );
      const start = new Date(Math.floor(clock.getTime() / 60_000) * 60_000);
      await owner.pool.query(
        "UPDATE login_buckets SET window_start=$2,attempts=120 WHERE bucket=$1",
        [secretHash("login-global", "single-api"), start],
      );
      const response = await app.inject({
        method: "POST",
        url: "/v1/auth/login",
        remoteAddress: "192.0.2.46",
        headers: { origin: config.APP_ORIGIN },
        payload: {
          email: `global-${marker}@example.invalid`,
          password: "incorrect-password",
        },
      });
      assert.equal(response.statusCode, 429);
      assert.equal(
        (
          await owner.pool.query(
            "SELECT 1 FROM login_buckets WHERE bucket=$1",
            [secretHash("login-account", `global-${marker}@example.invalid`)],
          )
        ).rowCount,
        0,
      );
      clock = new Date(clock.getTime() + 900_000);
    },
  );
  await scenario(
    "privileged linking creates a membership without resetting the password",
    async () => {
      const before = (
        await owner.pool.query("SELECT password_hash FROM users WHERE id=$1", [
          readerSession.userId,
        ])
      ).rows[0]?.password_hash;
      const linked = await provisionMember(owner.pool, {
        email: reader.email,
        organizationId: orgB.organizationId,
        role: "reader",
      });
      assert.equal(linked.userId, readerSession.userId);
      assert.equal(
        (
          await owner.pool.query(
            "SELECT password_hash FROM users WHERE id=$1",
            [readerSession.userId],
          )
        ).rows[0]?.password_hash,
        before,
      );
      await assert.rejects(
        provisionMember(owner.pool, {
          email: reader.email,
          organizationId: orgB.organizationId,
          role: "admin",
        }),
      );
      assert.equal(
        (
          await owner.pool.query(
            "SELECT role FROM memberships WHERE organization_id=$1 AND user_id=$2",
            [orgB.organizationId, readerSession.userId],
          )
        ).rows[0]?.role,
        "reader",
      );
    },
  );
  await scenario(
    "HTTPS cookies enforce host scope and sessions are bounded per user",
    async () => {
      const httpsConfig = readConfig({
        API_DATABASE_URL: apiUrl.toString(),
        APP_ORIGIN: "https://sentinel.example.com",
        NODE_ENV: "production",
        LOG_LEVEL: "silent",
      });
      const httpsApp: FastifyInstance = await buildApp(httpsConfig, {
        isReady: async () => true,
        identity: service,
      });
      try {
        let lastCookie = "";
        let firstCookie = "";
        for (let i = 0; i < 11; i++) {
          clock = new Date(clock.getTime() + 900_000);
          const response: LightMyRequestResponse = await httpsApp.inject({
            method: "POST",
            url: "/v1/auth/login",
            headers: { origin: httpsConfig.APP_ORIGIN },
            payload: reader,
          });
          assert.equal(response.statusCode, 200);
          const setCookie = response.headers["set-cookie"];
          assert.equal(typeof setCookie, "string");
          assert.ok(typeof setCookie === "string");
          assert.match(setCookie, /^__Host-sentinel_session=/);
          assert.match(setCookie, /Secure/);
          assert.match(setCookie, /HttpOnly/);
          assert.ok(!setCookie.includes("Domain="));
          lastCookie = setCookie.split(";")[0] ?? "";
          if (i === 0) firstCookie = lastCookie;
        }
        assert.equal(
          (
            await owner.pool.query(
              "SELECT 1 FROM sessions WHERE user_id=$1 AND revoked_at IS NULL",
              [readerSession.userId],
            )
          ).rowCount,
          10,
        );
        assert.equal(
          (
            await httpsApp.inject({
              url: "/v1/auth/session",
              headers: { cookie: lastCookie },
            })
          ).statusCode,
          200,
        );
        assert.equal(
          (
            await httpsApp.inject({
              url: "/v1/auth/session",
              headers: { cookie: firstCookie },
            })
          ).statusCode,
          401,
        );
        assert.ok(httpsApp.swagger().paths?.["/v1/auth/login"]);
      } finally {
        await httpsApp.close();
      }
    },
  );
  await scenario(
    "logs and responses omit password, raw session/key, CSRF and query secrets",
    async () => {
      await app.inject({
        url: `/unknown/${credential}?token=query-secret`,
        headers: {
          authorization: `Bearer ${credential}`,
          cookie: admin.cookie,
        },
      });
      for (const secret of [
        credential,
        admin.cookie.split("=")[1] ?? "",
        admin.csrf,
        ...fixtures.map((fixture) => fixture.password),
        "query-secret",
      ])
        assert.ok(
          !logs.includes(secret),
          "Logs must not contain request secrets",
        );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/v1/ingest/events",
            headers: { authorization: `Bearer ${credential}` },
            payload: {},
          })
        ).statusCode,
        401,
      );
    },
  );
  console.log(
    `Identity integration passed: ${scenarios} scenarios on real PostgreSQL using the API role; fixture data is cleaned up.`,
  );
} finally {
  await app.close();
  await runtime.pool.end();
  await owner.pool.query(
    "DROP TRIGGER IF EXISTS m2_reject_audit_trigger ON audit_entries; DROP FUNCTION IF EXISTS m2_reject_audit()",
  );
  if (orgIds.length) {
    await owner.pool.query(
      "DELETE FROM audit_entries WHERE organization_id=ANY($1::uuid[])",
      [orgIds],
    );
    await owner.pool.query(
      "DELETE FROM ingestion_keys WHERE organization_id=ANY($1::uuid[])",
      [orgIds],
    );
    await owner.pool.query(
      "DELETE FROM projects WHERE organization_id=ANY($1::uuid[])",
      [orgIds],
    );
    await owner.pool.query(
      "DELETE FROM memberships WHERE organization_id=ANY($1::uuid[])",
      [orgIds],
    );
    await owner.pool.query(
      "DELETE FROM organizations WHERE id=ANY($1::uuid[])",
      [orgIds],
    );
  }
  if (userIds.length) {
    await owner.pool.query(
      "DELETE FROM sessions WHERE user_id=ANY($1::uuid[])",
      [userIds],
    );
    await owner.pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [
      userIds,
    ]);
  }
  await owner.pool.query("DELETE FROM login_buckets");
  await lock.query(
    "SELECT pg_advisory_unlock(hashtext('sentinel-m2-integration'))",
  );
  lock.release();
  await owner.pool.end();
}
