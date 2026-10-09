import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

async function inspect(path) {
  let files = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const target = join(path, entry.name);
    if (entry.isDirectory()) files += await inspect(target);
    else if (/\.(?:js|map)$/.test(entry.name)) {
      const source = await readFile(target, "utf8");
      if (
        /snt_(?:ing|rsp)_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}/i.test(source) ||
        /postgres(?:ql)?:\/\/[^\s"']+:[^\s"']+@/.test(source)
      )
        throw new Error(
          "Server credential detected in public client bundle; details withheld",
        );
      files++;
    }
  }
  return files;
}
const files = await inspect("apps/web/.next/static");
if (files === 0)
  throw new Error(
    "No public build assets found; build the web application first",
  );
console.log(
  `Client secret scan passed (${files} assets; ingestion, response and database credential patterns).`,
);
