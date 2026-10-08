import { z } from "zod";

const configSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  API_HOST: z.string().default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  API_DATABASE_URL: z.url().startsWith("postgresql://"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
});

export type ApiConfig = z.infer<typeof configSchema>;

export function readConfig(env: NodeJS.ProcessEnv): ApiConfig {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    // Report field names only: input values may contain database credentials.
    throw new Error(
      `Invalid configuration: ${result.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
    );
  }
  return result.data;
}
