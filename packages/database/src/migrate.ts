import { applyMigrations } from "./migrations.js";

if (!process.env.DATABASE_URL)
  throw new Error("DATABASE_URL is required for migrations.");
try {
  await applyMigrations(process.env.DATABASE_URL);
  console.log("Database migrations applied successfully.");
} catch {
  console.error(
    "Migration failed. Check database access and migration files; credentials were not logged.",
  );
  process.exitCode = 1;
}
