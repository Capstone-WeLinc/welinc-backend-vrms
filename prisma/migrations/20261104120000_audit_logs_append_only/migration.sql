-- Spec 0021, AC-13: audit_logs is append only. INSERT and SELECT keep working; any UPDATE, DELETE
-- or TRUNCATE fails, from any connection. Prisma does not model triggers, so `migrate dev` reports
-- no drift. A later migration that truly must change rows here has to switch these triggers off
-- inside itself and say why. The seed switches them off for its cleanup (prisma/seed.ts).

CREATE FUNCTION audit_logs_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append only';
END $$;

CREATE TRIGGER audit_logs_no_change
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION audit_logs_append_only();

CREATE TRIGGER audit_logs_no_truncate
  BEFORE TRUNCATE ON "audit_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_append_only();
