import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { eventBatchSchema, securityEventSchema } from "../src/index.js";

const entries = [
  ["security-event.v1.json", securityEventSchema],
  ["event-batch.v1.json", eventBatchSchema],
] as const;
for (const [filename, schema] of entries) {
  const path = new URL(`../schema/${filename}`, import.meta.url);
  const content = `${JSON.stringify(z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" }), null, 2)}\n`;
  if (process.argv.includes("--check")) {
    if (readFileSync(path, "utf8") !== content)
      throw new Error(`Generated contract drift: ${filename}`);
  } else {
    writeFileSync(path, content);
  }
}
console.log(
  process.argv.includes("--check")
    ? "Generated schemas are current."
    : "Generated event and batch schemas.",
);
