CREATE TABLE "ingestion_quotas" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"events" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "ingestion_quotas_nonnegative" CHECK ("ingestion_quotas"."requests" >= 0 AND "ingestion_quotas"."events" >= 0)
);
--> statement-breakpoint
ALTER TABLE "ingestion_quotas" ADD CONSTRAINT "ingestion_quotas_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;