-- Immutable per-turn memory authority.
-- RUN AS: chat_owner. Idempotent and rollback-compatible: an older application
-- may omit the column, in which case the safe legacy_unknown default is used.

ALTER TABLE chat.messages
  ADD COLUMN IF NOT EXISTS memory_authority text NOT NULL DEFAULT 'legacy_unknown';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'chat.messages'::regclass
      AND conname = 'messages_memory_authority_check'
  ) THEN
    ALTER TABLE chat.messages
      ADD CONSTRAINT messages_memory_authority_check
      CHECK (memory_authority IN ('enabled', 'disabled', 'legacy_unknown'));
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION chat.reject_message_memory_authority_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.memory_authority IS DISTINCT FROM OLD.memory_authority THEN
    RAISE EXCEPTION
      'message memory_authority is immutable (message id=%)',
      OLD.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS message_memory_authority_immutable ON chat.messages;
CREATE TRIGGER message_memory_authority_immutable
  BEFORE UPDATE OF memory_authority ON chat.messages
  FOR EACH ROW
  EXECUTE FUNCTION chat.reject_message_memory_authority_mutation();

CREATE INDEX IF NOT EXISTS messages_memory_reconcile_eligible_idx
  ON chat.messages (updated_at DESC)
  WHERE role = 'assistant'
    AND status = 'sent'
    AND deleted_at IS NULL
    AND memory_authority = 'enabled'
    AND memory_extracted_attempt < attempt
    AND reply_to_message_id IS NOT NULL;
