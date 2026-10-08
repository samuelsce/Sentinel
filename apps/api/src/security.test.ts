import { describe, expect, it } from "vitest";
import { readConfig } from "./config.js";
import {
  emailSchema,
  equalToken,
  hashPassword,
  randomToken,
  secretHash,
  verifyPassword,
} from "./security.js";

describe("identity security primitives", () => {
  it("hashes with Argon2id and random salts; verifies without truncating", async () => {
    const password = randomToken();
    const [first, second] = await Promise.all([
      hashPassword(password),
      hashPassword(password),
    ]);
    expect(first).not.toEqual(second);
    expect(first).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
    expect(await verifyPassword(first, password)).toBe(true);
    expect(await verifyPassword(first, `${password}x`)).toBe(false);
  });
  it("separates credential namespaces and checks CSRF tokens exactly", () => {
    const token = randomToken();
    expect(token).toHaveLength(43);
    expect(secretHash("session", token)).not.toEqual(
      secretHash("ingestion", token),
    );
    expect(equalToken(token, token)).toBe(true);
    expect(equalToken(`${token}x`, token)).toBe(false);
    expect(equalToken(undefined, token)).toBe(false);
  });
  it("canonicalizes email and refuses unsafe/noncanonical origins", () => {
    expect(emailSchema.parse(" USER@EXAMPLE.COM ")).toBe("user@example.com");
    for (const origin of [
      "invalid-secret-origin",
      "http://example.com",
      "https://example.com/",
      "https://example.com/path",
      "https://user:secret@example.com",
      "ftp://localhost",
    ]) {
      expect(() =>
        readConfig({
          API_DATABASE_URL: "postgresql://fake:fake@localhost/test",
          APP_ORIGIN: origin,
        }),
      ).toThrow("APP_ORIGIN");
    }
    expect(() =>
      readConfig({
        API_DATABASE_URL: "postgresql://fake:fake@localhost/test",
        NODE_ENV: "production",
      }),
    ).toThrow("APP_ORIGIN");
    expect(
      readConfig({
        API_DATABASE_URL: "postgresql://fake:fake@localhost/test",
        NODE_ENV: "production",
        APP_ORIGIN: "https://sentinel.example.com",
      }).APP_ORIGIN,
    ).toBe("https://sentinel.example.com");
  });
});
