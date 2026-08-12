-- P0-1 boundary · grants (design §2). The teeth of the boundary.
-- RUN order: core_owner grants on views; chat_owner grants on chat.* tables.
\set ON_ERROR_STOP on

-- Broad grants and their deliberate reductions are one authority transition.
-- A runtime role must never observe the intermediate broad posture.
BEGIN;

-- ---- core_owner: expose the 4 read-only views to chat_service -----------------
-- (run as core_owner)
SET LOCAL ROLE core_owner;
GRANT SELECT ON core.chat_user_view              TO chat_service;
GRANT SELECT ON core.chat_character_view         TO chat_service;
GRANT SELECT ON core.chat_character_content_version_view TO chat_service;
GRANT SELECT ON core.chat_character_release_view TO chat_service;
GRANT SELECT ON core.chat_character_tags_view    TO chat_service;
GRANT SELECT ON billing.chat_entitlement_view    TO chat_service;
GRANT SELECT ON compliance.chat_user_eligibility_view TO chat_service;
RESET ROLE;

-- ---- chat_owner: chat runtime read/write on chat.* ---------------------------
-- (run as chat_owner)
SET LOCAL ROLE chat_owner;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA chat TO chat_service;
ALTER DEFAULT PRIVILEGES FOR ROLE chat_owner IN SCHEMA chat
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO chat_service;
-- cuids are app-generated, but grant sequence usage in case future tables use serial.
GRANT USAGE ON ALL SEQUENCES IN SCHEMA chat TO chat_service;
ALTER DEFAULT PRIVILEGES FOR ROLE chat_owner IN SCHEMA chat
  GRANT USAGE ON SEQUENCES TO chat_service;

-- The file projector is a separate capability. It may complete durable file
-- intents and atomically write their chat-domain receipts/outbox effects, while
-- the request role cannot claim a side effect it did not perform.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON ALL TABLES IN SCHEMA chat TO chat_projector;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA chat TO chat_projector;
ALTER DEFAULT PRIVILEGES FOR ROLE chat_owner IN SCHEMA chat
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO chat_projector;
ALTER DEFAULT PRIVILEGES FOR ROLE chat_owner IN SCHEMA chat
  GRANT USAGE ON SEQUENCES TO chat_projector;

-- Scene revisions are append-only request authority. The file projector has no
-- Scene responsibility and therefore receives no capability on this table.
REVOKE UPDATE, DELETE ON chat.chat_scene_revisions FROM chat_service;
GRANT SELECT, INSERT ON chat.chat_scene_revisions TO chat_service;
REVOKE ALL ON chat.chat_scene_revisions FROM chat_projector;

-- File intents are an immutable runtime ledger. Account/relationship erasure
-- uses narrow SECURITY DEFINER functions; the service role cannot drop a
-- pending intent or forge completion by deleting the row.
REVOKE DELETE ON chat.chat_file_mutations FROM chat_service;
REVOKE INSERT ON chat.chat_file_mutations FROM chat_service;
REVOKE UPDATE ON chat.chat_file_mutations FROM chat_service;
GRANT SELECT ON chat.chat_file_mutations TO chat_service;
GRANT INSERT (id, user_id, kind, payload)
  ON chat.chat_file_mutations TO chat_service;
GRANT EXECUTE ON FUNCTION
  chat.purge_file_mutations_for_account(text, text)
  TO chat_service, chat_projector;
REVOKE EXECUTE ON FUNCTION
  chat.purge_applied_relationship_sets(text, text, bigint)
  FROM chat_service;
GRANT EXECUTE ON FUNCTION
  chat.purge_applied_relationship_sets(text, text, bigint)
  TO chat_projector;
GRANT SELECT, UPDATE ON chat.chat_file_mutations TO chat_projector;
REVOKE INSERT, DELETE ON chat.chat_file_mutations FROM chat_projector;
RESET ROLE;

-- ---- explicit deny posture (belt-and-suspenders) -----------------------------
-- chat_service is NOT granted anything on public.* base tables, so it cannot read
-- or write users/characters/entitlements directly. Revoke any inherited PUBLIC
-- grants on the sensitive base tables to be safe.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM chat_service, chat_projector;
REVOKE USAGE ON SCHEMA public FROM chat_service, chat_projector;

COMMIT;
