-- RUN AS: migration/table owner in the selected Main database.
-- Set idream.main_runtime_role to the actual DATABASE_URL application role.
DO $$
DECLARE
  runtime_role NAME := current_setting('idream.main_runtime_role', true);
BEGIN
  IF runtime_role IS NULL OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role) THEN
    RAISE EXCEPTION 'set idream.main_runtime_role to the actual Main application role';
  END IF;
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', runtime_role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.packs, public.pack_releases, public.pack_grants TO %I', runtime_role);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', runtime_role);
END;
$$;
