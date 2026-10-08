import type { SecurityEvent } from "@sentinel/contracts";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
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
  uniqueIndex,
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
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
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
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.userId] })],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    tokenHash: text("token_hash").notNull().unique(),
    csrfToken: text("csrf_token").notNull(),
    createdAt: createdAt(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    index("sessions_user_idx").on(table.userId),
    check(
      "sessions_expiry_after_creation",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
  ],
);

export const loginBuckets = pgTable(
  "login_buckets",
  {
    bucket: text("bucket").primaryKey(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    attempts: integer("attempts").notNull(),
  },
  (table) => [
    check("login_buckets_attempts_positive", sql`${table.attempts} > 0`),
  ],
);

export const auditAction = pgEnum("audit_action", [
  "organization.created",
  "member.provisioned",
  "member.updated",
  "project.created",
  "key.created",
  "key.revoked",
  "alert.viewed",
  "alert.status_changed",
]);
export const auditEntries = pgTable(
  "audit_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    actorUserId: uuid("actor_user_id").references(() => users.id),
    action: auditAction("action").notNull(),
    subjectId: uuid("subject_id").notNull(),
    details: jsonb("details")
      .$type<{
        role?: "admin" | "analyst" | "reader";
        active?: boolean;
        environment?:
          | "demo"
          | "development"
          | "test"
          | "staging"
          | "production";
        fromStatus?: "open" | "triaged" | "resolved";
        toStatus?: "open" | "triaged" | "resolved";
      }>()
      .notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index("audit_entries_scope_created_idx").on(
      table.organizationId,
      table.createdAt,
      table.id,
    ),
  ],
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

// One bounded quota row per project; rotating credentials cannot reset quotas.
export const ingestionQuotas = pgTable(
  "ingestion_quotas",
  {
    projectId: uuid("project_id")
      .primaryKey()
      .references(() => projects.id),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    requests: integer("requests").notNull().default(0),
    events: integer("events").notNull().default(0),
  },
  (table) => [
    check(
      "ingestion_quotas_nonnegative",
      sql`${table.requests} >= 0 AND ${table.events} >= 0`,
    ),
  ],
);

export const events = pgTable(
  "events",
  {
    organizationId: uuid("organization_id").notNull(),
    projectId: uuid("project_id").notNull(),
    eventId: uuid("event_id").notNull(),
    ingestOrder: bigint("ingest_order", { mode: "bigint" })
      .generatedAlwaysAsIdentity()
      .notNull()
      .unique(),
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
    unique("events_scope_environment_unique").on(
      table.organizationId,
      table.projectId,
      table.eventId,
      table.environment,
    ),
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
    index("events_project_receipt_order_idx").on(
      table.projectId,
      table.receivedAt,
      table.ingestOrder,
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
    completedAt: timestamp("completed_at", { withTimezone: true }),
    eventReceivedAt: timestamp("event_received_at", {
      withTimezone: true,
    }).notNull(),
    eventIngestOrder: bigint("event_ingest_order", {
      mode: "bigint",
    }).notNull(),
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
    index("detection_jobs_project_status_idx").on(
      table.projectId,
      table.status,
    ),
    index("jobs_project_head_idx")
      .on(table.projectId, table.eventReceivedAt, table.eventIngestOrder)
      .where(sql`${table.status} IN ('pending','processing')`),
    index("jobs_global_head_idx")
      .on(table.eventReceivedAt, table.eventIngestOrder)
      .where(sql`${table.status} IN ('pending','processing')`),
    check("detection_jobs_attempts_nonnegative", sql`${table.attempts} >= 0`),
    check(
      "detection_jobs_processing_lease",
      sql`${table.status} <> 'processing' OR (${table.leaseToken} IS NOT NULL AND ${table.leasedUntil} IS NOT NULL)`,
    ),
  ],
);

export const ruleDefinitions = pgTable(
  "rule_definitions",
  {
    code: text("code").notNull(),
    version: integer("version").notNull(),
    definition: jsonb("definition").$type<Record<string, unknown>>().notNull(),
  },
  (table) => [primaryKey({ columns: [table.code, table.version] })],
);

export const detectionEpisodes = pgTable(
  "detection_episodes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    projectId: uuid("project_id").notNull(),
    environment: environment("environment").notNull(),
    ruleCode: text("rule_code").notNull(),
    ruleVersion: integer("rule_version").notNull(),
    correlationKind: text("correlation_kind").notNull(),
    correlationValue: text("correlation_value").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    lastRelevantAt: timestamp("last_relevant_at", {
      withTimezone: true,
    }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    totalRelevant: integer("total_relevant").notNull().default(0),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.projectId],
      foreignColumns: [projects.organizationId, projects.id],
    }),
    foreignKey({
      columns: [table.ruleCode, table.ruleVersion],
      foreignColumns: [ruleDefinitions.code, ruleDefinitions.version],
    }),
    unique("episodes_scope_unique").on(
      table.organizationId,
      table.projectId,
      table.id,
      table.environment,
      table.ruleCode,
      table.ruleVersion,
    ),
    uniqueIndex("episodes_active_correlation_unique")
      .on(
        table.projectId,
        table.environment,
        table.ruleCode,
        table.ruleVersion,
        table.correlationKind,
        table.correlationValue,
      )
      .where(sql`${table.endedAt} IS NULL`),
    check(
      "episodes_valid_correlation",
      sql`${table.correlationKind} IN ('ip','actor') AND length(${table.correlationValue}) BETWEEN 1 AND 128`,
    ),
    check("episodes_valid_count", sql`${table.totalRelevant} >= 0`),
  ],
);

export const alertStatus = pgEnum("alert_status", [
  "open",
  "triaged",
  "resolved",
]);
export const alerts = pgTable(
  "alerts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    projectId: uuid("project_id").notNull(),
    environment: environment("environment").notNull(),
    episodeId: uuid("episode_id").notNull().unique(),
    ruleCode: text("rule_code").notNull(),
    ruleVersion: integer("rule_version").notNull(),
    severity: text("severity").notNull(),
    status: alertStatus("status").notNull().default("open"),
    statusVersion: integer("status_version").notNull().default(1),
    initialDecision: jsonb("initial_decision")
      .$type<Record<string, unknown>>()
      .notNull(),
    lastDecision: jsonb("last_decision")
      .$type<Record<string, unknown>>()
      .notNull(),
    peakCount: integer("peak_count").notNull(),
    evidenceTruncated: boolean("evidence_truncated").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [
        table.organizationId,
        table.projectId,
        table.episodeId,
        table.environment,
        table.ruleCode,
        table.ruleVersion,
      ],
      foreignColumns: [
        detectionEpisodes.organizationId,
        detectionEpisodes.projectId,
        detectionEpisodes.id,
        detectionEpisodes.environment,
        detectionEpisodes.ruleCode,
        detectionEpisodes.ruleVersion,
      ],
    }),
    unique("alerts_scope_unique").on(
      table.organizationId,
      table.projectId,
      table.id,
      table.environment,
    ),
    index("alerts_project_created_idx").on(
      table.projectId,
      table.createdAt,
      table.id,
    ),
    check("alerts_valid_severity", sql`${table.severity} IN ('high','medium')`),
    check(
      "alerts_valid_version_count",
      sql`${table.statusVersion} >= 1 AND ${table.peakCount} >= 0`,
    ),
  ],
);

export const alertEvidence = pgTable(
  "alert_evidence",
  {
    organizationId: uuid("organization_id").notNull(),
    projectId: uuid("project_id").notNull(),
    environment: environment("environment").notNull(),
    alertId: uuid("alert_id").notNull(),
    eventId: uuid("event_id").notNull(),
    role: text("role").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    ingestOrder: bigint("ingest_order", { mode: "bigint" }).notNull(),
    payload: jsonb("payload").$type<SecurityEvent>().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.organizationId,
        table.projectId,
        table.alertId,
        table.eventId,
      ],
    }),
    foreignKey({
      columns: [
        table.organizationId,
        table.projectId,
        table.alertId,
        table.environment,
      ],
      foreignColumns: [
        alerts.organizationId,
        alerts.projectId,
        alerts.id,
        alerts.environment,
      ],
    }),
    check(
      "evidence_valid_role",
      sql`${table.role} IN ('trigger','support','context')`,
    ),
  ],
);

export const ingestionTotals = pgTable("ingestion_totals", {
  projectId: uuid("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  accepted: bigint("accepted", { mode: "number" }).notNull().default(0),
  duplicates: bigint("duplicates", { mode: "number" }).notNull().default(0),
  batches: bigint("batches", { mode: "number" }).notNull().default(0),
});
