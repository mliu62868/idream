BEGIN;

-- These Character events are durable local evidence. They have no transport
-- consumer, so leaving historical rows pending/dispatched invents queue lag
-- and makes a completed local transaction look unfinished.
UPDATE "main_outbox_events"
SET
  status = 'delivered',
  "deliveredAt" = COALESCE("deliveredAt", "createdAt"),
  "lastError" = (
    CASE
      WHEN "lastError" IS NULL THEN '{}'::JSONB
      WHEN jsonb_typeof("lastError") = 'object' THEN "lastError"
      ELSE jsonb_build_object('previousLastError', "lastError")
    END
  ) || jsonb_build_object(
    'outcome', 'local_evidence',
    'reason', 'local_evidence_has_no_transport_sink',
    'terminalizedBy',
      '20260718010000_main_outbox_local_evidence_terminal'
  ),
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "eventType" IN (
    'character.release.qualification_stale.v2',
    'character.editorial_authority_repaired.v1'
  )
  AND status IN ('pending', 'dispatched');

COMMIT;
