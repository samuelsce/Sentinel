CREATE TYPE "public"."environment" AS ENUM('demo', 'development', 'test', 'staging', 'production');--> statement-breakpoint
CREATE TYPE "public"."event_type" AS ENUM('auth.login_failed', 'auth.login_succeeded', 'authz.access_denied', 'admin.action', 'admin.privilege_changed');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('pending', 'processing', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('admin', 'analyst', 'reader');--> statement-breakpoint
CREATE TABLE "detection_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"status" "job_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"leased_until" timestamp with time zone,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "detection_jobs_event_unique" UNIQUE("organization_id","project_id","event_id"),
	CONSTRAINT "detection_jobs_attempts_nonnegative" CHECK ("detection_jobs"."attempts" >= 0),
	CONSTRAINT "detection_jobs_processing_lease" CHECK ("detection_jobs"."status" <> 'processing' OR ("detection_jobs"."lease_token" IS NOT NULL AND "detection_jobs"."leased_until" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "events" (
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"ingestion_key_id" uuid NOT NULL,
	"environment" "environment" NOT NULL,
	"type" "event_type" NOT NULL,
	"actor_id" text,
	"source_ip" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "events_organization_id_project_id_event_id_pk" PRIMARY KEY("organization_id","project_id","event_id"),
	CONSTRAINT "events_project_event_unique" UNIQUE("project_id","event_id")
);
--> statement-breakpoint
CREATE TABLE "ingestion_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"environment" "environment" NOT NULL,
	"prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ingestion_keys_key_hash_unique" UNIQUE("key_hash"),
	CONSTRAINT "ingestion_keys_scope_unique" UNIQUE("organization_id","project_id","id","environment")
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "member_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_organization_id_user_id_pk" PRIMARY KEY("organization_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_scope_unique" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "detection_jobs" ADD CONSTRAINT "detection_jobs_organization_id_project_id_event_id_events_organization_id_project_id_event_id_fk" FOREIGN KEY ("organization_id","project_id","event_id") REFERENCES "public"."events"("organization_id","project_id","event_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_organization_id_project_id_projects_organization_id_id_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_organization_id_project_id_ingestion_key_id_environment_ingestion_keys_organization_id_project_id_id_environment_fk" FOREIGN KEY ("organization_id","project_id","ingestion_key_id","environment") REFERENCES "public"."ingestion_keys"("organization_id","project_id","id","environment") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_keys" ADD CONSTRAINT "ingestion_keys_organization_id_project_id_projects_organization_id_id_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "detection_jobs_ready_idx" ON "detection_jobs" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "events_project_received_idx" ON "events" USING btree ("project_id","received_at","event_id");--> statement-breakpoint
CREATE INDEX "events_project_type_received_idx" ON "events" USING btree ("project_id","type","received_at");