-- P0-1 boundary · schemas + roles (design §2, PRD §4)
-- RUN AS: a Postgres superuser / cluster owner (you — not the app).
-- IDEMPOTENT. Re-runnable.
--
-- Boundary model (pragmatic split that keeps main portable):
--   * Base tables stay in `public` (owned by core_owner / the main app).
--   * core/billing/compliance are VIEW-ONLY schemas exposing minimal read models.
--   * chat schema holds the chat service's authority tables.
--   * chat_service runtime role: SELECT on the 4 views + CRUD on chat.*; it has
--     NO grant on public.* base tables, so the only way it reads main data is
--     through the views (least privilege, enforced by the DB, not code review).
--
-- Passwords below are PLACEHOLDERS. Set real secrets (or use IAM/peer auth) before
-- production. The app connects with the chat_service role only.

-- ---- roles -------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'core_owner') THEN
    CREATE ROLE core_owner LOGIN PASSWORD 'core_owner_change_me';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chat_owner') THEN
    CREATE ROLE chat_owner LOGIN PASSWORD 'chat_owner_change_me';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chat_service') THEN
    CREATE ROLE chat_service LOGIN PASSWORD 'chat_service_change_me';
  END IF;
END
$$;

-- ---- schemas -----------------------------------------------------------------
-- View-only schemas owned by core_owner (the main app owns public base tables).
CREATE SCHEMA IF NOT EXISTS core       AUTHORIZATION core_owner;
CREATE SCHEMA IF NOT EXISTS billing    AUTHORIZATION core_owner;
CREATE SCHEMA IF NOT EXISTS compliance AUTHORIZATION core_owner;
-- Chat service owns its schema + tables.
CREATE SCHEMA IF NOT EXISTS chat       AUTHORIZATION chat_owner;

-- core_owner needs to read the public base tables so its views resolve.
-- (Views run with the view owner's privileges; chat_service never touches public.)
GRANT USAGE ON SCHEMA public TO core_owner;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO core_owner;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO core_owner;

-- chat_service may resolve names in the view schemas (but only SELECT the views,
-- granted in 04_grants.sql). It must NOT get USAGE on public.
GRANT USAGE ON SCHEMA core, billing, compliance TO chat_service;
GRANT USAGE ON SCHEMA chat TO chat_service;
