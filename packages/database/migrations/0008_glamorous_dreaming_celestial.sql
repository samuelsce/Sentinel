ALTER TYPE "public"."audit_action" ADD VALUE 'response.key_created';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'response.key_revoked';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'response.requested';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'response.applied';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'response.failed';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'response.expired';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'response.expiry_confirmed';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'rule.configured';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'report.exported';--> statement-breakpoint
CREATE TABLE "project_rule_revisions" (
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"rule_code" text NOT NULL,
	"rule_version" integer NOT NULL,
	"enabled" boolean NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_rule_revisions_organization_id_project_id_rule_code_rule_version_pk" PRIMARY KEY("organization_id","project_id","rule_code","rule_version")
);
--> statement-breakpoint
CREATE TABLE "response_actions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"environment" "environment" NOT NULL,
	"alert_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"source_ip" text NOT NULL,
	"reason" text NOT NULL,
	"ttl_seconds" integer NOT NULL,
	"state" text DEFAULT 'requested' NOT NULL,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"applied_at" timestamp with time zone,
	"expired_confirmed_at" timestamp with time zone,
	CONSTRAINT "response_valid_state" CHECK ("response_actions"."state" IN ('requested','applied','failed','expired')),
	CONSTRAINT "response_valid_ttl" CHECK ("response_actions"."ttl_seconds" BETWEEN 15 AND 3600)
);
--> statement-breakpoint
CREATE TABLE "response_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"environment" "environment" NOT NULL,
	"key_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "response_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
ALTER TABLE "detection_jobs" ADD COLUMN "rule_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "project_rule_revisions" ADD CONSTRAINT "project_rule_revisions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_rule_revisions" ADD CONSTRAINT "project_rule_revisions_organization_id_project_id_projects_organization_id_id_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_rule_revisions" ADD CONSTRAINT "project_rule_revisions_rule_code_rule_version_rule_definitions_code_version_fk" FOREIGN KEY ("rule_code","rule_version") REFERENCES "public"."rule_definitions"("code","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "response_actions" ADD CONSTRAINT "response_actions_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "response_actions" ADD CONSTRAINT "response_actions_organization_id_project_id_alert_id_environment_alerts_organization_id_project_id_id_environment_fk" FOREIGN KEY ("organization_id","project_id","alert_id","environment") REFERENCES "public"."alerts"("organization_id","project_id","id","environment") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "response_keys" ADD CONSTRAINT "response_keys_organization_id_project_id_projects_organization_id_id_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "response_scope_idx" ON "response_actions" USING btree ("project_id","environment","expires_at");
--> statement-breakpoint
CREATE SEQUENCE rule_revision_version_seq AS integer START WITH 2;
--> statement-breakpoint
CREATE FUNCTION capture_job_rules() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.rule_snapshot IS DISTINCT FROM OLD.rule_snapshot THEN
      RAISE EXCEPTION 'Job rule snapshot is immutable' USING ERRCODE='23514';
    END IF;
  ELSE
    SELECT jsonb_agg(jsonb_build_object('code',b.code,'version',COALESCE(r.rule_version,1),'enabled',COALESCE(r.enabled,true)) ORDER BY b.code)
    INTO NEW.rule_snapshot FROM public.rule_definitions b
    LEFT JOIN LATERAL (SELECT rule_version,enabled FROM public.project_rule_revisions
      WHERE organization_id=NEW.organization_id AND project_id=NEW.project_id AND rule_code=b.code
      ORDER BY rule_version DESC LIMIT 1) r ON true WHERE b.version=1;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER job_rule_snapshot BEFORE INSERT OR UPDATE OF rule_snapshot ON detection_jobs FOR EACH ROW EXECUTE FUNCTION capture_job_rules();
