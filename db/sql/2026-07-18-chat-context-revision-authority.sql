\set ON_ERROR_STOP on

BEGIN;

ALTER TABLE chat.chat_sessions
  ADD COLUMN IF NOT EXISTS context_revision bigint;

UPDATE chat.chat_sessions
SET context_revision = 0
WHERE context_revision IS NULL;

ALTER TABLE chat.chat_sessions
  ALTER COLUMN context_revision SET DEFAULT 0,
  ALTER COLUMN context_revision SET NOT NULL;

COMMIT;
