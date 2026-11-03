CREATE TABLE "conflicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"equipment_id" uuid NOT NULL,
	"field_name" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "conflicts_status_valid" CHECK ("conflicts"."status" in ('open', 'resolved')),
	CONSTRAINT "conflicts_resolution_matches_status" CHECK (("conflicts"."status" = 'resolved') = ("conflicts"."resolution" is not null and "conflicts"."resolved_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "document_blobs" (
	"document_id" uuid PRIMARY KEY NOT NULL,
	"content" "bytea" NOT NULL,
	CONSTRAINT "document_blobs_content_not_empty" CHECK (octet_length("document_blobs"."content") > 0)
);
--> statement-breakpoint
CREATE TABLE "document_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"page_number" integer NOT NULL,
	"content" text NOT NULL,
	CONSTRAINT "document_pages_document_page_key" UNIQUE("document_id","page_number"),
	CONSTRAINT "document_pages_page_number_positive" CHECK ("document_pages"."page_number" >= 1)
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sha256" text NOT NULL,
	"original_filename" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"page_count" integer NOT NULL,
	"document_type" text NOT NULL,
	"revision" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_sha256_key" UNIQUE("sha256"),
	CONSTRAINT "documents_sha256_format" CHECK ("documents"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "documents_original_filename_length" CHECK (char_length("documents"."original_filename") between 1 and 255),
	CONSTRAINT "documents_byte_size_positive" CHECK ("documents"."byte_size" > 0),
	CONSTRAINT "documents_page_count_positive" CHECK ("documents"."page_count" >= 1),
	CONSTRAINT "documents_document_type_valid" CHECK ("documents"."document_type" in ('datasheet', 'manual', 'brochure')),
	CONSTRAINT "documents_revision_length" CHECK (char_length("documents"."revision") between 1 and 32)
);
--> statement-breakpoint
CREATE TABLE "equipment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tag" text NOT NULL,
	"equipment_class" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "equipment_tag_key" UNIQUE("tag"),
	CONSTRAINT "equipment_tag_length" CHECK (char_length("equipment"."tag") between 1 and 64),
	CONSTRAINT "equipment_class_valid" CHECK ("equipment"."equipment_class" in ('centrifugal_pump', 'electric_motor'))
);
--> statement-breakpoint
CREATE TABLE "extraction_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"tokens" integer,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extraction_runs_model_not_empty" CHECK (char_length("extraction_runs"."model") > 0),
	CONSTRAINT "extraction_runs_prompt_version_not_empty" CHECK (char_length("extraction_runs"."prompt_version") > 0),
	CONSTRAINT "extraction_runs_tokens_nonnegative" CHECK ("extraction_runs"."tokens" >= 0),
	CONSTRAINT "extraction_runs_latency_nonnegative" CHECK ("extraction_runs"."latency_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "fields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"extraction_run_id" uuid NOT NULL,
	"equipment_id" uuid NOT NULL,
	"name" text NOT NULL,
	"value" text NOT NULL,
	"unit" text NOT NULL,
	"quote" text NOT NULL,
	"page" integer NOT NULL,
	"verification_status" text NOT NULL,
	"verification_reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"review_status" text DEFAULT 'pending' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fields_run_equipment_name_key" UNIQUE("extraction_run_id","equipment_id","name"),
	CONSTRAINT "fields_page_positive" CHECK ("fields"."page" >= 1),
	CONSTRAINT "fields_version_positive" CHECK ("fields"."version" >= 1),
	CONSTRAINT "fields_verification_status_valid" CHECK ("fields"."verification_status" in ('verified', 'unverified')),
	CONSTRAINT "fields_review_status_valid" CHECK ("fields"."review_status" in ('pending', 'accepted', 'edited', 'rejected')),
	CONSTRAINT "fields_verification_reasons_valid" CHECK ("fields"."verification_reasons" <@ array['QUOTE_NOT_FOUND', 'QUOTE_TOO_SHORT', 'VALUE_NOT_IN_QUOTE', 'UNIT_UNKNOWN', 'UNIT_MISMATCH', 'OUT_OF_RANGE', 'AMBIGUOUS_NUMBER_FORMAT', 'INTERNAL']::text[]),
	CONSTRAINT "fields_verified_has_no_reasons" CHECK (("fields"."verification_status" = 'verified') = (cardinality("fields"."verification_reasons") = 0))
);
--> statement-breakpoint
CREATE TABLE "register_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"register_version_id" uuid NOT NULL,
	"equipment_id" uuid NOT NULL,
	"tag" text NOT NULL,
	"values" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "register_items_version_equipment_key" UNIQUE("register_version_id","equipment_id"),
	CONSTRAINT "register_items_values_object" CHECK (jsonb_typeof("register_items"."values") = 'object')
);
--> statement-breakpoint
CREATE TABLE "register_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" integer NOT NULL,
	"approved_by" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "register_versions_number_key" UNIQUE("number"),
	CONSTRAINT "register_versions_number_positive" CHECK ("register_versions"."number" >= 1),
	CONSTRAINT "register_versions_published_has_approver" CHECK ("register_versions"."published_at" is null or "register_versions"."approved_by" is not null)
);
--> statement-breakpoint
CREATE TABLE "review_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"field_id" uuid,
	"conflict_id" uuid,
	"register_version_id" uuid,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_events_exactly_one_subject" CHECK (num_nonnulls("review_events"."field_id", "review_events"."conflict_id", "review_events"."register_version_id") = 1),
	CONSTRAINT "review_events_actor_length" CHECK (char_length("review_events"."actor") between 1 and 128),
	CONSTRAINT "review_events_action_valid" CHECK ("review_events"."action" in ('extract', 'accept', 'edit', 'reject', 'resolve', 'publish'))
);
--> statement-breakpoint
ALTER TABLE "conflicts" ADD CONSTRAINT "conflicts_equipment_id_equipment_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "equipment"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_blobs" ADD CONSTRAINT "document_blobs_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_pages" ADD CONSTRAINT "document_pages_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_runs" ADD CONSTRAINT "extraction_runs_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fields" ADD CONSTRAINT "fields_extraction_run_id_extraction_runs_id_fk" FOREIGN KEY ("extraction_run_id") REFERENCES "extraction_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fields" ADD CONSTRAINT "fields_equipment_id_equipment_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "equipment"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "register_items" ADD CONSTRAINT "register_items_register_version_id_register_versions_id_fk" FOREIGN KEY ("register_version_id") REFERENCES "register_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "register_items" ADD CONSTRAINT "register_items_equipment_id_equipment_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "equipment"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_events" ADD CONSTRAINT "review_events_field_id_fields_id_fk" FOREIGN KEY ("field_id") REFERENCES "fields"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_events" ADD CONSTRAINT "review_events_conflict_id_conflicts_id_fk" FOREIGN KEY ("conflict_id") REFERENCES "conflicts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_events" ADD CONSTRAINT "review_events_register_version_id_register_versions_id_fk" FOREIGN KEY ("register_version_id") REFERENCES "register_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conflicts_equipment_id_idx" ON "conflicts" USING btree ("equipment_id");--> statement-breakpoint
CREATE INDEX "extraction_runs_document_id_idx" ON "extraction_runs" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "fields_equipment_id_idx" ON "fields" USING btree ("equipment_id");--> statement-breakpoint
CREATE INDEX "review_events_field_id_idx" ON "review_events" USING btree ("field_id");--> statement-breakpoint
CREATE INDEX "review_events_conflict_id_idx" ON "review_events" USING btree ("conflict_id");--> statement-breakpoint
CREATE INDEX "review_events_register_version_id_idx" ON "review_events" USING btree ("register_version_id");