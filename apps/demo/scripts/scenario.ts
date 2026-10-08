import { runScenario } from "../src/scenario.js";

try {
  const reader = process.env.DEMO_READER_PASSWORD;
  const admin = process.env.DEMO_ADMIN_PASSWORD;
  if (!reader || !admin) throw new Error("Missing lab configuration");
  console.log(
    JSON.stringify(
      await runScenario("http://127.0.0.1:3002", { reader, admin }),
    ),
  );
  console.log(
    "Inspect http://localhost:3002/lab/metrics for acknowledged events and SDK losses.",
  );
} catch {
  console.error(
    "Lab scenario failed. Check the demo process and .env.demo; credentials were not logged.",
  );
  process.exitCode = 1;
}
