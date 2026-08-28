-- Character publishing is one operator action backed by immutable Release,
-- technical validation, and Serving records. Project phases and per-character
-- QA runs duplicated those authorities without serving a distinct product need.
BEGIN;

-- These workflow-only states have no serving meaning. Archive any interrupted
-- candidates before removing the workflow that could advance them.
UPDATE "character_releases"
SET "status" = 'withdrawn',
    "updatedAt" = CURRENT_TIMESTAMP,
    "version" = "version" + 1
WHERE "status" IN ('draft', 'validating', 'in_review');

ALTER TABLE "character_releases"
  ALTER COLUMN "status" SET DEFAULT 'approved';

ALTER TABLE "character_serving"
  DROP COLUMN IF EXISTS "scheduledReleaseId",
  DROP COLUMN IF EXISTS "scheduledAt";

DROP INDEX IF EXISTS "character_projects_characterId_phase_idx";

ALTER TABLE "character_projects"
  DROP COLUMN IF EXISTS "phase";

DROP TABLE IF EXISTS "character_qa_runs";
DROP FUNCTION IF EXISTS "reject_character_qa_run_update"();

CREATE INDEX IF NOT EXISTS "character_projects_characterId_idx"
  ON "character_projects"("characterId");

COMMIT;
