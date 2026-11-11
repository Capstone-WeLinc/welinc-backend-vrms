-- Suite spec 0012, AC-25: audit_logs stays append only, with one narrow way through. Inside a
-- transaction that ran set_config('vrms.erasure', 'on', true), an UPDATE may change only
-- actor_name (to 'Deleted user'), actor_email (to null) and changes; every other column must
-- stay equal, compared one by one. DELETE and TRUNCATE are refused as before.

CREATE OR REPLACE FUNCTION audit_logs_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND current_setting('vrms.erasure', true) = 'on'
     AND NEW."id" = OLD."id"
     AND NEW."repair_ticket_id" = OLD."repair_ticket_id"
     AND NEW."actor_user_id" IS NOT DISTINCT FROM OLD."actor_user_id"
     AND NEW."actor_role" IS NOT DISTINCT FROM OLD."actor_role"
     AND NEW."action" = OLD."action"
     AND NEW."note" IS NOT DISTINCT FROM OLD."note"
     AND NEW."created_at" = OLD."created_at"
     AND (NEW."actor_name" IS NOT DISTINCT FROM OLD."actor_name" OR NEW."actor_name" = 'Deleted user')
     AND (NEW."actor_email" IS NOT DISTINCT FROM OLD."actor_email" OR NEW."actor_email" IS NULL)
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit_logs is append only';
END $$;
