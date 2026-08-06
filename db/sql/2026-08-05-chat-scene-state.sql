-- Typed per-session Scene State authority. RUN AS: database superuser.
-- Additive and idempotent; application deploy follows this migration.

\set ON_ERROR_STOP on

SET ROLE chat_owner;

ALTER TABLE chat.messages
  ADD COLUMN IF NOT EXISTS scene_version integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS runtime_trace jsonb;

ALTER TABLE chat.message_versions
  ADD COLUMN IF NOT EXISTS runtime_trace jsonb;

CREATE TABLE IF NOT EXISTS chat.chat_scene_revisions (
  id                          text PRIMARY KEY,
  session_id                  text NOT NULL REFERENCES chat.chat_sessions(id) ON DELETE CASCADE,
  version                     integer NOT NULL,
  source_assistant_message_id text NOT NULL,
  source_attempt              integer NOT NULL,
  snapshot                    jsonb NOT NULL,
  created_at                  timestamp NOT NULL DEFAULT (timezone('utc', now())),
  CONSTRAINT chat_scene_revisions_version_check CHECK (version > 0),
  CONSTRAINT chat_scene_revisions_source_attempt_check CHECK (source_attempt > 0),
  CONSTRAINT chat_scene_revisions_snapshot_schema_check CHECK (
    snapshot @> '{"schemaVersion": 1}'::jsonb
    AND (snapshot->>'version')::integer = version
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS chat_scene_revisions_session_version_key
  ON chat.chat_scene_revisions (session_id, version);
CREATE UNIQUE INDEX IF NOT EXISTS chat_scene_revisions_source_attempt_key
  ON chat.chat_scene_revisions (source_assistant_message_id, source_attempt);
CREATE INDEX IF NOT EXISTS chat_scene_revisions_session_created_idx
  ON chat.chat_scene_revisions (session_id, created_at);

GRANT SELECT, INSERT ON chat.chat_scene_revisions TO chat_service;

RESET ROLE;
