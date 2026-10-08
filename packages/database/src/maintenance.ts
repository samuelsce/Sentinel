import { createDatabase } from "./index.js";
import { retainAudit, retainProject } from "./retention.js";

const args = process.argv.slice(2);
const valid = /^(?:--(?:project|organization|batch)=.+|--apply)$/;
const options = (name: string) =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
if (
  args.some((arg) => !valid.test(arg)) ||
  new Set(args.map((arg) => arg.split("=")[0])).size !== args.length ||
  Boolean(options("project")) === Boolean(options("organization"))
)
  throw new Error(
    "Use --project=UUID OR --organization=UUID, optional --batch=1..1000 and --apply",
  );
const url = process.env.DATABASE_URL;
if (!url)
  throw new Error("DATABASE_URL is required for private operator maintenance");
const { pool } = createDatabase(url);
try {
  const id = options("project") ?? options("organization");
  if (!id) throw new Error("Scope required");
  console.log(
    JSON.stringify(
      await (options("project") ? retainProject : retainAudit)(
        pool,
        id,
        args.includes("--apply"),
        Number(options("batch") ?? 500),
      ),
    ),
  );
} catch {
  console.error(
    "Maintenance failed; transaction rolled back. Check operator configuration and scope.",
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
