-- Additive main -> chat durable receipt identity. RUN AS chat_owner after the
-- existing chat boundary tables. Existing rows are retained and backfilled from
-- their embedded durable metadata when present; legacy direct-queue rows use
-- main/id compatibility identity.
ALTER TABLE chat.chat_inbox_events
  ADD COLUMN IF NOT EXISTS source_service text,
  ADD COLUMN IF NOT EXISTS source_event_id text,
  ADD COLUMN IF NOT EXISTS payload_hash text,
  ADD COLUMN IF NOT EXISTS processed_at timestamp;

UPDATE chat.chat_inbox_events
SET source_service = COALESCE(source_service, payload #>> '{__durable,sourceService}', 'main'),
    source_event_id = COALESCE(source_event_id, id),
    payload_hash = COALESCE(payload_hash, payload #>> '{__durable,payloadHash}', 'legacy:' || id),
    processed_at = COALESCE(processed_at, consumed_at)
WHERE source_service IS NULL
   OR source_event_id IS NULL
   OR payload_hash IS NULL
   OR (processed_at IS NULL AND consumed_at IS NOT NULL);

ALTER TABLE chat.chat_inbox_events
  ALTER COLUMN source_service SET DEFAULT 'main',
  ALTER COLUMN source_service SET NOT NULL,
  ALTER COLUMN source_event_id SET NOT NULL,
  ALTER COLUMN payload_hash SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS chat_inbox_source_key
  ON chat.chat_inbox_events (source_service, source_event_id);
