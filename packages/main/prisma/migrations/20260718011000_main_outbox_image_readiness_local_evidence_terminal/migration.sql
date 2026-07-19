BEGIN;

-- Image-readiness repair is committed in the same Main transaction as its
-- audit and collaboration evidence. It has no external transport sink, so
-- historical rows must be terminal local evidence rather than permanent
-- queue backlog. This is a forward migration because 20260718010000 was
-- already deployed before this event type was audited.
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
      '20260718011000_main_outbox_image_readiness_local_evidence_terminal'
  ),
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "eventType" = 'character.image_readiness.repaired.v1'
  AND status IN ('pending', 'dispatched');

COMMIT;
