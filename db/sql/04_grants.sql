-- P0-1 boundary · grants (design §2). The teeth of the boundary.
-- RUN order: core_owner grants on views; chat_owner grants on chat.* tables.
\set ON_ERROR_STOP on

-- Revoke-first convergence and the exact grants are one authority transition.
-- A runtime role must never observe an intermediate broader posture.
BEGIN;

-- ---- core_owner: expose only the read-only views to chat_service --------------
-- (run as core_owner)
SET LOCAL ROLE core_owner;
REVOKE ALL ON
  core.chat_user_view,
  core.chat_character_view,
  core.chat_character_content_version_view,
  core.chat_character_release_view,
  core.chat_character_tags_view,
  billing.chat_entitlement_view,
  compliance.chat_user_eligibility_view
  FROM chat_service, chat_projector;
GRANT SELECT ON core.chat_user_view              TO chat_service;
GRANT SELECT ON core.chat_character_view         TO chat_service;
GRANT SELECT ON core.chat_character_content_version_view TO chat_service;
GRANT SELECT ON core.chat_character_release_view TO chat_service;
GRANT SELECT ON core.chat_character_tags_view    TO chat_service;
GRANT SELECT ON billing.chat_entitlement_view    TO chat_service;
GRANT SELECT ON compliance.chat_user_eligibility_view TO chat_service;
RESET ROLE;

-- ---- chat_owner: exact runtime capabilities on chat.* ------------------------
-- (run as chat_owner)
SET LOCAL ROLE chat_owner;

-- Remove old broad grants and defaults before rebuilding the allowlist below.
-- New tables/sequences/functions therefore arrive inaccessible until this file
-- names the runtime operation that needs them.
REVOKE ALL ON ALL TABLES IN SCHEMA chat
  FROM PUBLIC, chat_service, chat_projector;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA chat
  FROM PUBLIC, chat_service, chat_projector;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA chat
  FROM PUBLIC, chat_service, chat_projector;
-- Global and per-schema defaults are additive. Revoke both layers so a legacy
-- global grant cannot survive the narrower Chat-schema posture. chat_owner owns
-- only Chat authority objects, so this does not rewrite another owner boundary.
ALTER DEFAULT PRIVILEGES FOR ROLE chat_owner
  REVOKE ALL ON TABLES FROM PUBLIC, chat_service, chat_projector;
ALTER DEFAULT PRIVILEGES FOR ROLE chat_owner
  REVOKE ALL ON SEQUENCES FROM PUBLIC, chat_service, chat_projector;
ALTER DEFAULT PRIVILEGES FOR ROLE chat_owner
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, chat_service, chat_projector;
ALTER DEFAULT PRIVILEGES FOR ROLE chat_owner IN SCHEMA chat
  REVOKE ALL ON TABLES FROM PUBLIC, chat_service, chat_projector;
ALTER DEFAULT PRIVILEGES FOR ROLE chat_owner IN SCHEMA chat
  REVOKE ALL ON SEQUENCES FROM PUBLIC, chat_service, chat_projector;
ALTER DEFAULT PRIVILEGES FOR ROLE chat_owner IN SCHEMA chat
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, chat_service, chat_projector;

-- Request/domain transactions own the ordinary Chat tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  chat.chat_sessions,
  chat.chat_send_receipts,
  chat.chat_session_release_migrations,
  chat.messages,
  chat.message_attachments,
  chat.message_versions,
  chat.chat_usage,
  chat.chat_moderation_events,
  chat.chat_outbox_events,
  chat.chat_inbox_events
  TO chat_service;

-- Scene revisions are append-only request authority. The file projector has no
-- Scene responsibility and therefore receives no capability on this table.
GRANT SELECT, INSERT ON chat.chat_scene_revisions TO chat_service;

-- File intents are an immutable runtime ledger. Account/relationship erasure
-- uses narrow SECURITY DEFINER functions; the service role cannot drop a
-- pending intent or forge completion by deleting the row.
GRANT SELECT ON chat.chat_file_mutations TO chat_service;
GRANT INSERT (id, user_id, kind, payload)
  ON chat.chat_file_mutations TO chat_service;

-- This is the only runtime sequence: request INSERTs need nextval(), while the
-- projector never creates ledger rows and receives no sequence privilege.
GRANT USAGE ON SEQUENCE chat.chat_file_mutations_sequence_seq TO chat_service;

-- The projector's SQL surface is derived from applyPendingChatFileMutationsTx:
-- it validates/advances sessions and messages, resolves send linkage, completes
-- ledger receipts, and inserts the outbox facts coupled to those completions.
GRANT SELECT ON chat.chat_sessions TO chat_projector;
-- Prisma's @updatedAt contract adds updated_at to both watermark writes.
GRANT UPDATE (log_extracted_seq, updated_at)
  ON chat.chat_sessions TO chat_projector;
GRANT SELECT ON chat.messages TO chat_projector;
GRANT UPDATE (memory_extracted_attempt, updated_at)
  ON chat.messages TO chat_projector;
GRANT SELECT ON chat.chat_send_receipts TO chat_projector;
GRANT SELECT ON chat.chat_file_mutations TO chat_projector;
GRANT UPDATE (status, payload, attempts, last_error, applied_at)
  ON chat.chat_file_mutations TO chat_projector;
GRANT SELECT ON chat.chat_outbox_events TO chat_projector;
GRANT INSERT (
  id,
  event_type,
  aggregate_type,
  aggregate_id,
  payload,
  schema_version,
  status,
  attempts,
  next_run_at,
  created_at
) ON chat.chat_outbox_events TO chat_projector;

-- The three-argument redactor is called by readiness and by the immutable
-- mutation trigger. The legacy overload and both trigger functions themselves
-- are never a runtime API and retain no direct EXECUTE grant.
GRANT EXECUTE ON FUNCTION
  chat.redact_file_mutation_payload(text, text, jsonb)
  TO chat_service, chat_projector;
GRANT EXECUTE ON FUNCTION
  chat.purge_file_mutations_for_account(text, text)
  TO chat_service, chat_projector;
GRANT EXECUTE ON FUNCTION
  chat.purge_applied_relationship_sets(text, text, bigint)
  TO chat_projector;
RESET ROLE;

-- ---- explicit deny posture (belt-and-suspenders) -----------------------------
-- Never rewrite PUBLIC here: Main and other database roles may legitimately
-- rely on cluster-level public schema posture. apply-validate performs a
-- read-only preflight and fails before DDL if an inherited PUBLIC grant would
-- make either Chat runtime role too broad.
REVOKE ALL ON ALL TABLES IN SCHEMA public
  FROM chat_service, chat_projector;
REVOKE CREATE ON SCHEMA public, chat, core, billing, compliance
  FROM chat_service, chat_projector;
REVOKE ALL ON SCHEMA core, billing, compliance FROM chat_projector;
GRANT USAGE ON SCHEMA core, billing, compliance TO chat_service;
GRANT USAGE ON SCHEMA chat TO chat_service, chat_projector;

COMMIT;
