CREATE TABLE "register_counter" (
	"id" integer PRIMARY KEY NOT NULL,
	"last_number" integer NOT NULL,
	CONSTRAINT "register_counter_single_row" CHECK ("register_counter"."id" = 1),
	CONSTRAINT "register_counter_last_number_nonnegative" CHECK ("register_counter"."last_number" >= 0)
);
--> statement-breakpoint
ALTER TABLE "conflicts" ADD COLUMN "resolved_by" text;--> statement-breakpoint
ALTER TABLE "conflicts" ADD COLUMN "chosen_field_id" uuid;--> statement-breakpoint
ALTER TABLE "conflicts" ADD COLUMN "decided_value" text;--> statement-breakpoint
ALTER TABLE "conflicts" ADD COLUMN "decided_unit" text;--> statement-breakpoint
ALTER TABLE "conflicts" ADD COLUMN "based_on" jsonb;--> statement-breakpoint
ALTER TABLE "conflicts" ADD CONSTRAINT "conflicts_chosen_field_id_fields_id_fk" FOREIGN KEY ("chosen_field_id") REFERENCES "fields"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conflicts" ADD CONSTRAINT "conflicts_resolved_has_decision" CHECK (("conflicts"."status" = 'resolved') = ("conflicts"."resolved_by" is not null and "conflicts"."decided_value" is not null
        and "conflicts"."decided_unit" is not null and "conflicts"."based_on" is not null));--> statement-breakpoint
ALTER TABLE "conflicts" ADD CONSTRAINT "conflicts_resolved_by_length" CHECK (char_length("conflicts"."resolved_by") between 1 and 128);--> statement-breakpoint
ALTER TABLE "conflicts" ADD CONSTRAINT "conflicts_decided_value_length" CHECK (char_length("conflicts"."decided_value") between 1 and 64);--> statement-breakpoint
ALTER TABLE "conflicts" ADD CONSTRAINT "conflicts_decided_unit_length" CHECK (char_length("conflicts"."decided_unit") between 1 and 32);--> statement-breakpoint
ALTER TABLE "conflicts" ADD CONSTRAINT "conflicts_based_on_array" CHECK (jsonb_typeof("conflicts"."based_on") = 'array');--> statement-breakpoint
-- Hand-written: the counter has exactly one row, starting after any version that already exists.
INSERT INTO "register_counter" ("id", "last_number") SELECT 1, COALESCE(MAX("number"), 0) FROM "register_versions";
