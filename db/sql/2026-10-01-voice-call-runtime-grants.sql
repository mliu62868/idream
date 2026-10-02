-- RUN AS: migration/table owner, in the target Main database.
-- Set idream.main_runtime_role to the role from Main's DATABASE_URL before
-- executing. The deployment owner may differ from that application role.
-- Additive and idempotent; never rewrites applied Prisma migration checksums.
DO $$
DECLARE
  runtime_role NAME := current_setting('idream.main_runtime_role', true);
BEGIN
  IF runtime_role IS NULL OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role) THEN
    RAISE EXCEPTION 'set idream.main_runtime_role to the actual Main application role';
  END IF;
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', runtime_role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.voice_calls, public.voice_call_utterances TO %I', runtime_role);
  -- The same migration creator must grant future public tables as well.
  -- Immutable authority remains enforced by their own CHECKs and triggers.
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', runtime_role);
END;
$$;
