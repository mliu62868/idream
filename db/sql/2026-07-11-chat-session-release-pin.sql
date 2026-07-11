-- Character Release → Chat Session authority cutover.
-- Additive/idempotent. Run as a database superuser after the main Character
-- Release tables exist and before deploying a chat build that writes Session pins.

SET ROLE core_owner;

CREATE OR REPLACE VIEW core.chat_character_content_version_view AS
SELECT
  ccv.id AS content_version_id,
  ccv."characterId" AS character_id,
  ccv.version,
  ccv."contentHash" AS content_hash,
  ccv."personaSnapshot" AS persona_snapshot,
  ccv."openingSnapshot" AS opening_snapshot,
  ccv."appearanceSnapshot" AS appearance_snapshot
FROM public.character_content_versions ccv;

CREATE OR REPLACE VIEW core.chat_character_release_view AS
SELECT
  cr.id AS release_id,
  cp."characterId" AS character_id,
  cr."characterContentVersionId" AS character_content_version_id,
  cr.status,
  cr.version,
  cr."snapshotHash" AS snapshot_hash
FROM public.character_releases cr
JOIN public.character_projects cp ON cp.id = cr."projectId";

GRANT SELECT ON core.chat_character_content_version_view TO chat_service;
GRANT SELECT ON core.chat_character_release_view TO chat_service;

RESET ROLE;
SET ROLE chat_owner;

ALTER TABLE chat.chat_sessions
  ADD COLUMN IF NOT EXISTS character_content_version_id text,
  ADD COLUMN IF NOT EXISTS character_release_id text,
  ADD COLUMN IF NOT EXISTS release_pinned_at timestamp;

CREATE TABLE IF NOT EXISTS chat.chat_session_release_migrations (
  id                                text PRIMARY KEY,
  command_id                        text NOT NULL UNIQUE,
  session_id                        text NOT NULL REFERENCES chat.chat_sessions(id),
  character_id                      text NOT NULL,
  from_character_content_version_id text,
  from_character_release_id         text,
  to_character_content_version_id   text NOT NULL,
  to_character_release_id           text,
  reason                            text NOT NULL,
  compatibility_qa                  jsonb NOT NULL,
  requested_by_id                   text NOT NULL,
  status                            text NOT NULL DEFAULT 'pending',
  requested_at                      timestamp NOT NULL DEFAULT (timezone('utc', now())),
  applied_at                        timestamp
);
CREATE INDEX IF NOT EXISTS chat_session_release_migrations_pending_idx
  ON chat.chat_session_release_migrations (session_id, status, requested_at);
CREATE UNIQUE INDEX IF NOT EXISTS chat_session_release_migrations_one_pending_idx
  ON chat.chat_session_release_migrations (session_id)
  WHERE status = 'pending';

GRANT SELECT, INSERT, UPDATE, DELETE ON chat.chat_session_release_migrations TO chat_service;

RESET ROLE;
