import { buildApp } from "./app.js";
import { readConfig } from "./config.js";

const config = readConfig(process.env);
const app = await buildApp(config);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app.close();
  });
}
try {
  await app.listen({ host: config.API_HOST, port: config.API_PORT });
} catch {
  app.log.fatal(
    "API could not start. Check configuration and port availability.",
  );
  await app.close();
  process.exitCode = 1;
}
