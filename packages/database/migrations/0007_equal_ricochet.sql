ALTER TABLE "detection_jobs" ADD COLUMN "event_received_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "detection_jobs" ADD COLUMN "event_ingest_order" bigint;--> statement-breakpoint
UPDATE detection_jobs j SET event_received_at=e.received_at,event_ingest_order=e.ingest_order
FROM events e WHERE (j.organization_id,j.project_id,j.event_id)=(e.organization_id,e.project_id,e.event_id);--> statement-breakpoint
ALTER TABLE detection_jobs ALTER COLUMN event_received_at SET NOT NULL, ALTER COLUMN event_ingest_order SET NOT NULL;--> statement-breakpoint
CREATE FUNCTION capture_job_receipt() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  SELECT e.received_at,e.ingest_order INTO NEW.event_received_at,NEW.event_ingest_order
  FROM public.events e WHERE (e.organization_id,e.project_id,e.event_id)=(NEW.organization_id,NEW.project_id,NEW.event_id);
  IF NOT FOUND THEN RAISE EXCEPTION 'Job event scope mismatch' USING ERRCODE='23503'; END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER job_receipt BEFORE INSERT ON detection_jobs FOR EACH ROW EXECUTE FUNCTION capture_job_receipt();--> statement-breakpoint
CREATE INDEX "jobs_project_head_idx" ON "detection_jobs" USING btree ("project_id","event_received_at","event_ingest_order") WHERE "detection_jobs"."status" IN ('pending','processing');--> statement-breakpoint
CREATE INDEX "jobs_global_head_idx" ON "detection_jobs" USING btree ("event_received_at","event_ingest_order") WHERE "detection_jobs"."status" IN ('pending','processing');
