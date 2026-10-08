import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Algorithm, hash, verify } from "@node-rs/argon2";
import { z } from "zod";

export const passwordSchema = z.string().min(15).max(128);
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email().max(254));
export const roleSchema = z.enum(["admin", "analyst", "reader"]);
export const nameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[\p{L}\p{N} .,_-]+$/u);
export const passwordOptions = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
  outputLen: 32,
};
export const hashPassword = (password: string) =>
  hash(passwordSchema.parse(password), passwordOptions);
export const verifyPassword = (encoded: string, password: string) =>
  verify(encoded, password);
export const randomToken = () => randomBytes(32).toString("base64url");
export const secretHash = (purpose: string, token: string) =>
  createHash("sha256").update(`${purpose}:${token}`).digest("hex");
export function equalToken(
  actual: string | undefined,
  expected: string,
): boolean {
  if (!actual || actual.length > 128) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
export class AccessError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly retryAfter?: number,
  ) {
    super("Access request rejected");
  }
}
