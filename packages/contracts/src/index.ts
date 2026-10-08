import { z } from "zod";

export const EVENT_MAX_BYTES = 8 * 1024;
export const BATCH_MAX_BYTES = 256 * 1024;
export const BATCH_MAX_EVENTS = 100;
const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/);
const role = z.enum(["user", "admin", "service"]);
const base = {
  schema_version: z.literal(1),
  event_id: z.uuid(),
  occurred_at: z.iso.datetime(),
  environment: z.enum(["demo", "development", "test", "staging", "production"]),
  actor_id: identifier.optional(),
  actor_role: role.optional(),
  source_ip: z.union([z.ipv4(), z.ipv6()]).optional(),
  request_id: identifier.optional(),
  resource: z
    .string()
    .min(1)
    .max(160)
    .regex(/^\/[A-Za-z0-9/_:.-]*$/)
    .optional(),
};

// Strict variants are portable to JSON Schema. No transforms or refinements are
// allowed here: both runtimes must accept exactly the same wire representation.
export const securityEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...base,
    type: z.literal("auth.login_failed"),
    action: z.literal("log_in"),
    outcome: z.literal("failure"),
    metadata: z.strictObject({
      reason: z.enum(["invalid_credentials", "account_locked"]).optional(),
    }),
  }),
  z.strictObject({
    ...base,
    type: z.literal("auth.login_succeeded"),
    action: z.literal("log_in"),
    outcome: z.literal("success"),
    metadata: z.strictObject({
      auth_method: z.enum(["password", "passkey", "mfa"]).optional(),
    }),
  }),
  z.strictObject({
    ...base,
    type: z.literal("authz.access_denied"),
    action: z.literal("access_resource"),
    outcome: z.literal("failure"),
    metadata: z.strictObject({
      permission: identifier.optional(),
      reason: z.enum(["insufficient_role", "resource_policy"]).optional(),
    }),
  }),
  z.strictObject({
    ...base,
    actor_id: identifier,
    type: z.literal("admin.action"),
    action: z.enum([
      "create_user",
      "disable_user",
      "change_settings",
      "rotate_key",
      "export_report",
    ]),
    outcome: z.enum(["success", "failure"]),
    metadata: z.strictObject({ target_id: identifier.optional() }),
  }),
  z.strictObject({
    ...base,
    actor_id: identifier,
    type: z.literal("admin.privilege_changed"),
    action: z.literal("change_privilege"),
    outcome: z.literal("success"),
    metadata: z.strictObject({
      target_id: identifier,
      previous_role: role,
      new_role: role,
    }),
  }),
]);

export const eventBatchSchema = z.strictObject({
  events: z.array(securityEventSchema).min(1).max(BATCH_MAX_EVENTS),
});
export type SecurityEvent = z.infer<typeof securityEventSchema>;
export type EventBatch = z.infer<typeof eventBatchSchema>;

export function isEventWithinTimeWindow(
  event: SecurityEvent,
  receivedAt: Date,
): boolean {
  const ageMs = receivedAt.getTime() - Date.parse(event.occurred_at);
  return ageMs >= -2 * 60_000 && ageMs <= 24 * 60 * 60_000;
}
