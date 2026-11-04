CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text NOT NULL,
	"attempts" integer NOT NULL,
	"max_attempts" integer NOT NULL,
	"run_at" timestamp with time zone NOT NULL,
	"locked_until" timestamp with time zone,
	"locked_by" text,
	"last_error" text,
	"correlation_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "jobs_idempotency_key_key" UNIQUE("idempotency_key"),
	CONSTRAINT "jobs_type_format" CHECK ("jobs"."type" ~ '^[a-z][a-z0-9_]{0,62}$'),
	CONSTRAINT "jobs_status_valid" CHECK ("jobs"."status" in ('queued', 'running', 'succeeded', 'failed', 'dead')),
	CONSTRAINT "jobs_idempotency_key_length" CHECK (char_length("jobs"."idempotency_key") between 1 and 200),
	CONSTRAINT "jobs_payload_object" CHECK (jsonb_typeof("jobs"."payload") = 'object'),
	CONSTRAINT "jobs_max_attempts_range" CHECK ("jobs"."max_attempts" between 1 and 100),
	CONSTRAINT "jobs_attempts_range" CHECK ("jobs"."attempts" between 0 and "jobs"."max_attempts"),
	CONSTRAINT "jobs_lease_matches_status" CHECK (("jobs"."status" = 'running') = ("jobs"."locked_by" is not null and "jobs"."locked_until" is not null)),
	CONSTRAINT "jobs_locked_by_length" CHECK (char_length("jobs"."locked_by") between 1 and 200),
	CONSTRAINT "jobs_last_error_length" CHECK (char_length("jobs"."last_error") between 1 and 500)
);
--> statement-breakpoint
ALTER TABLE "extraction_runs" ADD COLUMN "job_id" uuid;--> statement-breakpoint
CREATE INDEX "jobs_status_run_at_idx" ON "jobs" USING btree ("status","run_at");--> statement-breakpoint
ALTER TABLE "extraction_runs" ADD CONSTRAINT "extraction_runs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conflicts_open_equipment_field_key" ON "conflicts" USING btree ("equipment_id","field_name") WHERE status = 'open';--> statement-breakpoint
ALTER TABLE "extraction_runs" ADD CONSTRAINT "extraction_runs_job_id_key" UNIQUE("job_id");