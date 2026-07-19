-- The original quarantine migration is immutable after deployment and only
-- accepted PostgreSQL boolean text. Apply the later tolerant predicate as a
-- forward migration so historical rows using "1" or "yes" are quarantined
-- without rewriting the already-applied migration.
WITH synthetic_preview_assets AS (
  SELECT id
  FROM "media_assets"
  WHERE COALESCE("metadata"->>'source', '') = 'character_preview'
    AND LOWER(COALESCE("metadata"->>'synthetic', 'false')) IN ('true', '1', 'yes')
)
UPDATE "character_visual_profiles" profiles
SET "status" = 'archived'
WHERE profiles."status" = 'active'
  AND EXISTS (
    SELECT 1
    FROM synthetic_preview_assets assets
    WHERE profiles."anchorAssetIds" ? assets.id
  );

WITH synthetic_preview_assets AS (
  SELECT id
  FROM "media_assets"
  WHERE COALESCE("metadata"->>'source', '') = 'character_preview'
    AND LOWER(COALESCE("metadata"->>'synthetic', 'false')) IN ('true', '1', 'yes')
)
UPDATE "characters" characters
SET
  "imageAssetId" = NULL,
  "visibility" = 'private',
  "status" = 'draft'
FROM synthetic_preview_assets assets
WHERE characters."imageAssetId" = assets.id;

WITH synthetic_preview_jobs AS (
  SELECT jobs.id, jobs."draftId"
  FROM "character_preview_jobs" jobs
  JOIN "media_assets" assets ON assets.id = jobs."resultAssetId"
  WHERE COALESCE("assets"."metadata"->>'source', '') = 'character_preview'
    AND LOWER(COALESCE("assets"."metadata"->>'synthetic', 'false')) IN ('true', '1', 'yes')
)
UPDATE "character_drafts" drafts
SET "previewJobId" = NULL
FROM synthetic_preview_jobs jobs
WHERE drafts.id = jobs."draftId"
  AND drafts."previewJobId" = jobs.id;

UPDATE "media_assets"
SET
  "characterId" = NULL,
  "visibility" = 'unlisted',
  "metadata" = "metadata" || jsonb_build_object(
    'quarantined', TRUE,
    'quarantineReason', 'synthetic_character_preview'
  )
WHERE COALESCE("metadata"->>'source', '') = 'character_preview'
  AND LOWER(COALESCE("metadata"->>'synthetic', 'false')) IN ('true', '1', 'yes');
