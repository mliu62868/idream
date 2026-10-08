ALTER TABLE "video_sequences"
  ADD COLUMN "activeCompositionOwners" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "artifactKeys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Existing composing owners are unresolved I/O, even when their lease expired.
-- Drain old Main composers before deploying the new writer. A retained crashed
-- owner requires confirmation that its invocation stopped before reconciliation.
UPDATE "video_sequences"
SET "activeCompositionOwners" = ARRAY["compositionOwner"]
WHERE "status" = 'composing' AND "compositionOwner" IS NOT NULL;
