-- Spec 0021 and VRMS spec 0008 (Database roles): audit_logs is append only for the role the app
-- connects as. infra/db/init.sql grants vrms_app its table rights through default privileges, so
-- this runs after every migration (npm run db:deploy, the hosted migration job). Idempotent.
-- Local databases have no vrms_app role, so it does nothing there.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vrms_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM vrms_app;
  END IF;
END
$$;
