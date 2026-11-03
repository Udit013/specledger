ALTER TABLE "conflicts" ADD CONSTRAINT "conflicts_field_name_format" CHECK ("conflicts"."field_name" ~ '^[a-z][a-z0-9_]*$' and char_length("conflicts"."field_name") between 1 and 64);--> statement-breakpoint
ALTER TABLE "conflicts" ADD CONSTRAINT "conflicts_resolution_not_empty" CHECK (char_length("conflicts"."resolution") >= 1);--> statement-breakpoint
ALTER TABLE "fields" ADD CONSTRAINT "fields_name_format" CHECK ("fields"."name" ~ '^[a-z][a-z0-9_]*$' and char_length("fields"."name") between 1 and 64);--> statement-breakpoint
ALTER TABLE "fields" ADD CONSTRAINT "fields_value_length" CHECK (char_length("fields"."value") between 1 and 64);--> statement-breakpoint
ALTER TABLE "fields" ADD CONSTRAINT "fields_unit_length" CHECK (char_length("fields"."unit") between 1 and 32);--> statement-breakpoint
ALTER TABLE "fields" ADD CONSTRAINT "fields_quote_length" CHECK (char_length("fields"."quote") between 1 and 1000);--> statement-breakpoint
ALTER TABLE "register_items" ADD CONSTRAINT "register_items_tag_length" CHECK (char_length("register_items"."tag") between 1 and 64);--> statement-breakpoint
ALTER TABLE "register_versions" ADD CONSTRAINT "register_versions_approved_by_length" CHECK (char_length("register_versions"."approved_by") between 1 and 128);--> statement-breakpoint
ALTER TABLE "review_events" ADD CONSTRAINT "review_events_reason_not_empty" CHECK (char_length("review_events"."reason") >= 1);