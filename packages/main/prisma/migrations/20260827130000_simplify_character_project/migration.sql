-- Character operations are driven by profile, assets, lifecycle state, release,
-- and serving evidence. Project-management metadata never became runtime
-- authority and has no operator workflow, so remove it instead of preserving
-- empty placeholders.
BEGIN;

DROP INDEX IF EXISTS "character_projects_ownerId_phase_idx";

ALTER TABLE "character_projects"
  DROP COLUMN "ownerId",
  DROP COLUMN "audience",
  DROP COLUMN "hypothesis",
  DROP COLUMN "differentiation",
  DROP COLUMN "successCriteria",
  DROP COLUMN "plannedLaunchAt";

COMMIT;
