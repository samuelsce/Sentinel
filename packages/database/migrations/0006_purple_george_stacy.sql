CREATE TABLE "ingestion_totals" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"accepted" bigint DEFAULT 0 NOT NULL,
	"duplicates" bigint DEFAULT 0 NOT NULL,
	"batches" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alert_evidence" DROP CONSTRAINT "alert_evidence_organization_id_project_id_event_id_environment_events_organization_id_project_id_event_id_environment_fk";
--> statement-breakpoint
ALTER TABLE "alert_evidence" ADD COLUMN "received_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "alert_evidence" ADD COLUMN "ingest_order" bigint;--> statement-breakpoint
ALTER TABLE "alert_evidence" ADD COLUMN "payload" jsonb;--> statement-breakpoint
UPDATE alert_evidence ae SET received_at=e.received_at, ingest_order=e.ingest_order, payload=e.payload
FROM events e WHERE (ae.organization_id,ae.project_id,ae.event_id,ae.environment)=(e.organization_id,e.project_id,e.event_id,e.environment);--> statement-breakpoint
ALTER TABLE alert_evidence ALTER COLUMN received_at SET NOT NULL, ALTER COLUMN ingest_order SET NOT NULL, ALTER COLUMN payload SET NOT NULL;--> statement-breakpoint
CREATE FUNCTION capture_evidence_snapshot() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  SELECT e.received_at,e.ingest_order,e.payload INTO NEW.received_at,NEW.ingest_order,NEW.payload
  FROM public.events e WHERE (e.organization_id,e.project_id,e.event_id,e.environment)=
    (NEW.organization_id,NEW.project_id,NEW.event_id,NEW.environment);
  IF NOT FOUND THEN RAISE EXCEPTION 'Evidence event scope mismatch' USING ERRCODE='23503'; END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER evidence_snapshot BEFORE INSERT ON alert_evidence FOR EACH ROW EXECUTE FUNCTION capture_evidence_snapshot();--> statement-breakpoint
ALTER TABLE "detection_jobs" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ingestion_totals" ADD CONSTRAINT "ingestion_totals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
