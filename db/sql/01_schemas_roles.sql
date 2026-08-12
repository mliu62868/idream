-- P0-1 boundary · schemas + roles (design §2, PRD §4)
-- RUN AS: a Postgres superuser / cluster owner (you — not the app).
-- IDEMPOTENT. Re-runnable.
--
-- Boundary model (pragmatic split that keeps main portable):
--   * Base tables stay in `public` (owned by core_owner / the main app).
--   * core/billing/compliance are VIEW-ONLY schemas exposing minimal read models.
--   * chat schema holds the chat service's authority tables.
--   * chat_service is the request/domain role: it reads the Main views, writes
--     normal chat transactions, and may create durable file intents only through
--     the narrow columns granted in 04_grants.sql. It cannot forge completion.
--   * chat_projector is the durable-file projection role: after applying the
--     CHAT_FS_ROOT side effect it may advance the mutation receipt under the
--     file-ledger trigger. Direct intent INSERT/DELETE is denied; account erasure
--     uses only the narrow function that validates the canonical erasure intent.
--   * Neither runtime role receives a grant on public.* base tables; Main data is
--     exposed only through the read models granted to chat_service.
--
-- Role bootstrap is deliberately outside this file. A DBA/IAM authority must
-- pre-create all four roles and configure the two runtime identities with real,
-- distinct credentials. Silently creating placeholder LOGIN roles makes a clean
-- production install look successful while leaving Chat unable to authenticate.

-- ---- roles -------------------------------------------------------------------
DO $$
DECLARE
  missing_roles text;
  invalid_posture text;
BEGIN
  SELECT string_agg(required.role_name, ', ' ORDER BY required.role_name)
  INTO missing_roles
  FROM unnest(ARRAY[
    'core_owner',
    'chat_owner',
    'chat_service',
    'chat_projector'
  ]) AS required(role_name)
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = required.role_name
  );

  IF missing_roles IS NOT NULL THEN
    RAISE EXCEPTION
      'Chat boundary roles must be provisioned by DBA/IAM before apply: %',
      missing_roles;
  END IF;

  SELECT string_agg(
    role_state.role_name || ' must be ' ||
      CASE WHEN role_state.must_login THEN 'LOGIN' ELSE 'NOLOGIN' END,
    ', ' ORDER BY role_state.role_name
  )
  INTO invalid_posture
  FROM (
    VALUES
      ('core_owner', false),
      ('chat_owner', false),
      ('chat_service', true),
      ('chat_projector', true)
  ) AS role_state(role_name, must_login)
  JOIN pg_roles AS r ON r.rolname = role_state.role_name
  WHERE r.rolcanlogin IS DISTINCT FROM role_state.must_login;

  IF invalid_posture IS NOT NULL THEN
    RAISE EXCEPTION
      'Chat boundary role posture must be repaired by DBA/IAM before apply: %',
      invalid_posture;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (VALUES
      ('chat_service', 'core_owner'),
      ('chat_service', 'chat_owner'),
      ('chat_projector', 'core_owner'),
      ('chat_projector', 'chat_owner')
    ) AS forbidden(runtime_role, owner_role)
    WHERE pg_has_role(
      forbidden.runtime_role,
      forbidden.owner_role,
      'MEMBER'
    )
  ) THEN
    RAISE EXCEPTION
      'Chat runtime roles must not inherit or hold membership in owner roles';
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

-- chat_service may resolve names in the view schemas (but only SELECT the views,
-- granted in 04_grants.sql). It must NOT get USAGE on public.
GRANT USAGE ON SCHEMA core, billing, compliance TO chat_service;
GRANT USAGE ON SCHEMA chat TO chat_service;
GRANT USAGE ON SCHEMA chat TO chat_projector;
