import { SentinelClient } from "@sentinel/sdk";
import { buildDemo } from "./app.js";
import { DemoResponseAdapter } from "./response-adapter.js";

try {
  const endpoint = process.env.DEMO_INGEST_ENDPOINT;
  const ingestionKey = process.env.DEMO_INGEST_KEY;
  const reader = process.env.DEMO_READER_PASSWORD;
  const admin = process.env.DEMO_ADMIN_PASSWORD;
  if (!endpoint || !ingestionKey || !reader || !admin)
    throw new Error("Missing lab configuration");
  const sdk = new SentinelClient({
    endpoint,
    ingestionKey,
    environment: "demo",
  });
  const responseEndpoint = process.env.DEMO_RESPONSE_ENDPOINT;
  const responseKey = process.env.DEMO_RESPONSE_KEY;
  if (Boolean(responseEndpoint) !== Boolean(responseKey))
    throw new Error("Incomplete adapter configuration");
  const adapter =
    responseEndpoint && responseKey
      ? new DemoResponseAdapter({
          endpoint: responseEndpoint,
          key: responseKey,
        })
      : undefined;
  if (adapter) await adapter.sync();
  const app = await buildDemo(
    sdk,
    { reader, admin },
    "http://localhost:3002",
    adapter,
  );
  const timer = adapter
    ? setInterval(() => {
        void adapter.sync().catch(() => {});
      }, 2000)
    : undefined;
  timer?.unref();
  app.addHook("onClose", async () => {
    if (timer) clearInterval(timer);
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      void app.close();
    });
  await app.listen({ host: "127.0.0.1", port: 3002 });
  console.log(
    "Sentinel lab ready at http://localhost:3002. Credentials are server-side in .env.demo.",
  );
} catch {
  console.error(
    "Lab startup failed. Run demo:setup and check the local configuration; no secrets were logged.",
  );
  process.exitCode = 1;
}
