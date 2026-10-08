import type { SecurityEvent } from "@sentinel/contracts";
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
export const memberRole = pgEnum("member_role", ["admin", "analyst", "reader"]);
export const environment = pgEnum("environment", [
  "demo",
  "development",
  "test",
  "staging",
  "production",
]);
export const eventType = pgEnum("event_type", [
  "auth.login_failed",
  "auth.login_succeeded",
  "authz.access_denied",
  "admin.action",
  "admin.privilege_changed",
]);
export const jobStatus = pgEnum("job_status", [
  "pending",
  "processing",
  "completed",
  "failed",
]);

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: createdAt(),
});
export const organizations = pgTable("organizations", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  createdAt: createdAt(),
});
export const memberships = pgTable(
  "memberships",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    role: memberRole("role").notNull(),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.userId] })],
);

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    name: text("name").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique("projects_scope_unique").on(table.organizationId, table.id),
  ],
);

export const ingestionKeys = pgTable(
  "ingestion_keys",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    projectId: uuid("project_id").notNull(),
    environment: environment("environment").notNull(),
    prefix: text("prefix").notNull(),
    keyHash: text("key_hash").notNull().unique(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.projectId],
      foreignColumns: [projects.organizationId, projects.id],
    }),
    unique("ingestion_keys_scope_unique").on(
      table.organizationId,
      table.projectId,
      table.id,
      table.environment,
    ),
  ],
);

export const events = pgTable(
  "events",
  {
    organizationId: uuid("organization_id").notNull(),
    projectId: uuid("project_id").notNull(),
    eventId: uuid("event_id").notNull(),
    ingestionKeyId: uuid("ingestion_key_id").notNull(),
    environment: environment("environment").notNull(),
    type: eventType("type").notNull(),
    actorId: text("actor_id"),
    sourceIp: text("source_ip"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    payload: jsonb("payload").$type<SecurityEvent>().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.organizationId, table.projectId, table.eventId],
    }),
    unique("events_project_event_unique").on(table.projectId, table.eventId),
    foreignKey({
      columns: [table.organizationId, table.projectId],
      foreignColumns: [projects.organizationId, projects.id],
    }),
    foreignKey({
      columns: [
        table.organizationId,
        table.projectId,
        table.ingestionKeyId,
        table.environment,
      ],
      foreignColumns: [
        ingestionKeys.organizationId,
        ingestionKeys.projectId,
        ingestionKeys.id,
        ingestionKeys.environment,
      ],
    }),
    index("events_project_received_idx").on(
      table.projectId,
      table.receivedAt,
      table.eventId,
    ),
    index("events_project_type_received_idx").on(
      table.projectId,
      table.type,
      table.receivedAt,
    ),
  ],
);

export const detectionJobs = pgTable(
  "detection_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    projectId: uuid("project_id").notNull(),
    eventId: uuid("event_id").notNull(),
    status: jobStatus("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    leaseToken: uuid("lease_token"),
    leasedUntil: timestamp("leased_until", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.projectId, table.eventId],
      foreignColumns: [events.organizationId, events.projectId, events.eventId],
    }),
    unique("detection_jobs_event_unique").on(
      table.organizationId,
      table.projectId,
      table.eventId,
    ),
    index("detection_jobs_ready_idx").on(table.status, table.availableAt),
    check("detection_jobs_attempts_nonnegative", sql`${table.attempts} >= 0`),
    check(
      "detection_jobs_processing_lease",
      sql`${table.status} <> 'processing' OR (${table.leaseToken} IS NOT NULL AND ${table.leasedUntil} IS NOT NULL)`,
    ),
  ],
);
