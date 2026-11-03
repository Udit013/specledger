-- Hand-written: history and published registers are immutable in the database itself, so no code
-- path (a bug, a script, a manual query) can rewrite them. Custom SQLSTATEs let callers and tests
-- tell these refusals apart from any other error:
--   SL001  review_events is append-only
--   SL002  a published register version or its items cannot change
-- Each function pins search_path to the schema it was created in, so a caller's search_path cannot
-- redirect the lookups inside it.

CREATE FUNCTION reject_review_event_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
BEGIN
  RAISE EXCEPTION 'review_events is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'SL001';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER review_events_append_only
  BEFORE UPDATE OR DELETE ON review_events
  FOR EACH ROW EXECUTE FUNCTION reject_review_event_change();
--> statement-breakpoint
CREATE TRIGGER review_events_no_truncate
  BEFORE TRUNCATE ON review_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_review_event_change();
--> statement-breakpoint
CREATE FUNCTION protect_published_register_version() RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
BEGIN
  -- A draft (published_at is null) may still change, including the update that publishes it.
  IF OLD.published_at IS NOT NULL THEN
    RAISE EXCEPTION 'register version % is published: % is not allowed', OLD.number, TG_OP
      USING ERRCODE = 'SL002';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER register_versions_immutable_once_published
  BEFORE UPDATE OR DELETE ON register_versions
  FOR EACH ROW EXECUTE FUNCTION protect_published_register_version();
--> statement-breakpoint
CREATE FUNCTION protect_published_register_items() RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
BEGIN
  -- FOR SHARE waits for a concurrent publish of the same version to commit, then sees it, so an
  -- item cannot slip into a version while it is being published.
  IF TG_OP IN ('UPDATE', 'DELETE') AND EXISTS (
    SELECT 1 FROM register_versions
    WHERE id = OLD.register_version_id AND published_at IS NOT NULL
    FOR SHARE
  ) THEN
    RAISE EXCEPTION 'register item belongs to a published version: % is not allowed', TG_OP
      USING ERRCODE = 'SL002';
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND EXISTS (
    SELECT 1 FROM register_versions
    WHERE id = NEW.register_version_id AND published_at IS NOT NULL
    FOR SHARE
  ) THEN
    RAISE EXCEPTION 'register version is published: items cannot be added or moved into it'
      USING ERRCODE = 'SL002';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER register_items_immutable_once_published
  BEFORE INSERT OR UPDATE OR DELETE ON register_items
  FOR EACH ROW EXECUTE FUNCTION protect_published_register_items();
--> statement-breakpoint
CREATE FUNCTION reject_truncate_with_published_register() RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM register_versions WHERE published_at IS NOT NULL) THEN
    RAISE EXCEPTION '% of % is not allowed while a published register version exists',
      TG_OP, TG_TABLE_NAME
      USING ERRCODE = 'SL002';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER register_versions_no_truncate
  BEFORE TRUNCATE ON register_versions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate_with_published_register();
--> statement-breakpoint
CREATE TRIGGER register_items_no_truncate
  BEFORE TRUNCATE ON register_items
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate_with_published_register();
