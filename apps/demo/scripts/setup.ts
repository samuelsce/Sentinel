import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { createDatabase } from "@sentinel/database";
import { IdentityService, provisionMember } from "../../api/src/identity.js";
import { ResponseService } from "../../api/src/response.js";
import { randomToken } from "../../api/src/security.js";

if (existsSync(".env.demo")) {
  console.log(
    "Existing .env.demo preserved. Configuration and credentials were not changed.",
  );
} else {
  if (!process.env.DATABASE_URL)
    throw new Error("Initialize the local environment first");
  const url = new URL(process.env.DATABASE_URL);
  if (
    !["localhost", "127.0.0.1"].includes(url.hostname) ||
    url.pathname !== "/sentinel"
  )
    throw new Error("Lab setup requires the local sentinel database");
  const database = createDatabase(url.href);
  try {
    const operatorPassword = randomToken();
    const email = `lab-${randomUUID()}@example.invalid`;
    const member = await provisionMember(database.pool, {
      email,
      password: operatorPassword,
      organizationName: "Sentinel local lab",
      role: "admin",
    });
    const identity = new IdentityService(database.pool);
    const project = await identity.createProject(
      member.userId,
      member.organizationId,
      "Instrumented HTTP lab",
    );
    const key = await identity.issueKey(
      member.userId,
      member.organizationId,
      project.id,
      "demo",
    );
    const responseKey = await new ResponseService(identity).issueKey(
      member.userId,
      member.organizationId,
      project.id,
      "demo",
    );
    writeFileSync(
      ".env.demo",
      `${[
        "DEMO_INGEST_ENDPOINT=http://127.0.0.1:3001/v1/ingest/events",
        `DEMO_INGEST_KEY=${key.key}`,
        "DEMO_RESPONSE_ENDPOINT=http://127.0.0.1:3001/v1/response",
        `DEMO_RESPONSE_KEY=${responseKey.key}`,
        `DEMO_READER_PASSWORD=${randomToken()}`,
        `DEMO_ADMIN_PASSWORD=${randomToken()}`,
        `DEMO_ORGANIZATION_ID=${member.organizationId}`,
        `DEMO_PROJECT_ID=${project.id}`,
        `DEMO_OPERATOR_EMAIL=${email}`,
        `DEMO_OPERATOR_PASSWORD=${operatorPassword}`,
      ].join("\n")}\n`,
      { flag: "wx", mode: 0o600 },
    );
    console.log(
      JSON.stringify({
        status: "configured",
        organizationId: member.organizationId,
        projectId: project.id,
        file: ".env.demo",
      }),
    );
  } catch {
    console.error(
      "Lab setup failed; check migrations and local database access. No secrets were printed.",
    );
    process.exitCode = 1;
  } finally {
    await database.pool.end();
  }
}
