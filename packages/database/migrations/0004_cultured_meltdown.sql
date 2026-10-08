CREATE TYPE "public"."alert_status" AS ENUM('open', 'triaged', 'resolved');--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'alert.viewed';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'alert.status_changed';--> statement-breakpoint
CREATE TABLE "alert_evidence" (
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"environment" "environment" NOT NULL,
	"alert_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"role" text NOT NULL,
	CONSTRAINT "alert_evidence_organization_id_project_id_alert_id_event_id_pk" PRIMARY KEY("organization_id","project_id","alert_id","event_id"),
	CONSTRAINT "evidence_valid_role" CHECK ("alert_evidence"."role" IN ('trigger','support','context'))
);
--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"environment" "environment" NOT NULL,
	"episode_id" uuid NOT NULL,
	"rule_code" text NOT NULL,
	"rule_version" integer NOT NULL,
	"severity" text NOT NULL,
	"status" "alert_status" DEFAULT 'open' NOT NULL,
	"status_version" integer DEFAULT 1 NOT NULL,
	"initial_decision" jsonb NOT NULL,
	"last_decision" jsonb NOT NULL,
	"peak_count" integer NOT NULL,
	"evidence_truncated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alerts_episode_id_unique" UNIQUE("episode_id"),
	CONSTRAINT "alerts_scope_unique" UNIQUE("organization_id","project_id","id","environment"),
	CONSTRAINT "alerts_valid_severity" CHECK ("alerts"."severity" IN ('high','medium')),
	CONSTRAINT "alerts_valid_version_count" CHECK ("alerts"."status_version" >= 1 AND "alerts"."peak_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "detection_episodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"environment" "environment" NOT NULL,
	"rule_code" text NOT NULL,
	"rule_version" integer NOT NULL,
	"correlation_kind" text NOT NULL,
	"correlation_value" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"last_relevant_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"total_relevant" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "episodes_scope_unique" UNIQUE("organization_id","project_id","id","environment","rule_code","rule_version"),
	CONSTRAINT "episodes_valid_correlation" CHECK ("detection_episodes"."correlation_kind" IN ('ip','actor') AND length("detection_episodes"."correlation_value") BETWEEN 1 AND 128),
	CONSTRAINT "episodes_valid_count" CHECK ("detection_episodes"."total_relevant" >= 0)
);
--> statement-breakpoint
CREATE TABLE "rule_definitions" (
	"code" text NOT NULL,
	"version" integer NOT NULL,
	"definition" jsonb NOT NULL,
	CONSTRAINT "rule_definitions_code_version_pk" PRIMARY KEY("code","version")
);
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_scope_environment_unique" UNIQUE("organization_id","project_id","event_id","environment");--> statement-breakpoint
ALTER TABLE "alert_evidence" ADD CONSTRAINT "alert_evidence_organization_id_project_id_alert_id_environment_alerts_organization_id_project_id_id_environment_fk" FOREIGN KEY ("organization_id","project_id","alert_id","environment") REFERENCES "public"."alerts"("organization_id","project_id","id","environment") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_evidence" ADD CONSTRAINT "alert_evidence_organization_id_project_id_event_id_environment_events_organization_id_project_id_event_id_environment_fk" FOREIGN KEY ("organization_id","project_id","event_id","environment") REFERENCES "public"."events"("organization_id","project_id","event_id","environment") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_organization_id_project_id_episode_id_environment_rule_code_rule_version_detection_episodes_organization_id_project_id_id_environment_rule_code_rule_version_fk" FOREIGN KEY ("organization_id","project_id","episode_id","environment","rule_code","rule_version") REFERENCES "public"."detection_episodes"("organization_id","project_id","id","environment","rule_code","rule_version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "detection_episodes" ADD CONSTRAINT "detection_episodes_organization_id_project_id_projects_organization_id_id_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "detection_episodes" ADD CONSTRAINT "detection_episodes_rule_code_rule_version_rule_definitions_code_version_fk" FOREIGN KEY ("rule_code","rule_version") REFERENCES "public"."rule_definitions"("code","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alerts_project_created_idx" ON "alerts" USING btree ("project_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "episodes_active_correlation_unique" ON "detection_episodes" USING btree ("project_id","environment","rule_code","rule_version","correlation_kind","correlation_value") WHERE "detection_episodes"."ended_at" IS NULL;--> statement-breakpoint
CREATE INDEX "detection_jobs_project_status_idx" ON "detection_jobs" USING btree ("project_id","status");--> statement-breakpoint
