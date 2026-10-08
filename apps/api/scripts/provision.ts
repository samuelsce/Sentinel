import { emitKeypressEvents } from "node:readline";
import { createInterface as createPrompts } from "node:readline/promises";
import { createDatabase } from "@sentinel/database";
import { z } from "zod";
import { provisionMember } from "../src/identity.js";
import {
  emailSchema,
  nameSchema,
  passwordSchema,
  roleSchema,
} from "../src/security.js";

async function secretPrompt(label: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error("An interactive terminal is required");
  process.stdout.write(label);
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let password = "";
    const finish = (error?: Error) => {
      process.stdin.off("keypress", onKey);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(password);
    };
    const onKey = (
      text: string | undefined,
      key: { name?: string; ctrl?: boolean },
    ) => {
      if (key.ctrl && key.name === "c") return finish(new Error("Cancelled"));
      if (key.name === "return" || key.name === "enter") return finish();
      if (key.name === "backspace") {
        password = [...password].slice(0, -1).join("");
        return;
      }
      // Keep terminal escape sequences and control characters out of a password.
      if (
        text &&
        [...text].every(
          (character) =>
            character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
        )
      )
        password += text;
      if (password.length > 128) finish(new Error("Password is too long"));
    };
    process.stdin.on("keypress", onKey);
  });
}

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  if (
    args.some((arg) => arg !== "--link") ||
    args.length > 1 ||
    !process.stdin.isTTY ||
    !process.stdout.isTTY
  )
    throw new Error(
      "Use an interactive terminal; passwords cannot be supplied as arguments",
    );
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString)
    throw new Error("Migration database configuration is required");
  const prompts = createPrompts({
    input: process.stdin,
    output: process.stdout,
  });
  let email: string;
  let orgId: string | undefined;
  let orgName: string | undefined;
  let role: "admin" | "analyst" | "reader";
  try {
    email = emailSchema.parse(await prompts.question("Email: "));
    const orgAnswer = (
      await prompts.question(
        "Organization UUID (empty creates a new organization): ",
      )
    ).trim();
    orgId = orgAnswer ? z.uuid().parse(orgAnswer) : undefined;
    orgName = orgId
      ? undefined
      : nameSchema.parse(await prompts.question("Organization name: "));
    role = orgId
      ? roleSchema.parse(
          (await prompts.question("Role (admin/analyst/reader): ")).trim(),
        )
      : "admin";
  } finally {
    prompts.close();
  }
  let password: string | undefined;
  if (!args.includes("--link")) {
    password = passwordSchema.parse(
      await secretPrompt("Password (15–128 characters, hidden): "),
    );
    if (password !== (await secretPrompt("Confirm password (hidden): ")))
      throw new Error("Passwords must match");
  }
  const { pool } = createDatabase(connectionString);
  try {
    const result = await provisionMember(pool, {
      email,
      role,
      ...(password === undefined ? {} : { password }),
      ...(orgId
        ? { organizationId: orgId }
        : { organizationName: orgName ?? "" }),
    });
    console.log(JSON.stringify(result));
    console.log(
      "Member provisioned. No password was printed or reset. Use this organization UUID in API requests.",
    );
  } finally {
    await pool.end();
  }
}

try {
  await main();
} catch {
  // Database and validation exceptions can contain input values. Do not print them.
  console.error(
    "Provisioning failed. Check input, existing membership/email and migration configuration. No changes were committed on failure.",
  );
  process.exitCode = 1;
}
