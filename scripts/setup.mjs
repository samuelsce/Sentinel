import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";

if (existsSync(".env")) {
  console.log(".env already exists; existing configuration was preserved.");
} else {
  const migrator = randomBytes(24).toString("hex");
  const api = randomBytes(24).toString("hex");
  const detector = randomBytes(24).toString("hex");
  const lines = [
    "POSTGRES_USER=sentinel_migrator",
    "POSTGRES_DB=sentinel",
    "POSTGRES_PORT=55432",
    `POSTGRES_PASSWORD=${migrator}`,
    `SENTINEL_API_DB_PASSWORD=${api}`,
    `SENTINEL_DETECTOR_DB_PASSWORD=${detector}`,
    `DATABASE_URL=postgresql://sentinel_migrator:${migrator}@127.0.0.1:55432/sentinel`,
    `API_DATABASE_URL=postgresql://sentinel_api:${api}@127.0.0.1:55432/sentinel`,
    `DETECTOR_DATABASE_URL=postgresql://sentinel_detector:${detector}@127.0.0.1:55432/sentinel`,
    `TEST_DATABASE_URL=postgresql://sentinel_migrator:${migrator}@127.0.0.1:55432/sentinel_test`,
    "API_HOST=127.0.0.1",
    "API_PORT=3001",
    "APP_ORIGIN=http://localhost:3000",
    "API_INTERNAL_URL=http://127.0.0.1:3001",
    "LOG_LEVEL=info",
  ];
  writeFileSync(".env", `${lines.join("\n")}\n`, { flag: "wx", mode: 0o600 });
  console.log(
    "Created .env with random local credentials. No secrets were printed.",
  );
}
