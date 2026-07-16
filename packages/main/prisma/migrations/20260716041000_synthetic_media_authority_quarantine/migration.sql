-- Synthetic/mock media remains available to its owner and to audit history, but
-- it must never remain a public, identity, release, or merchandising authority.
-- This migration is intentionally non-destructive: it only withdraws serving
-- links and annotates the preserved media rows.

WITH synthetic_assets AS (
  SELECT id
  FROM "media_assets"
  WHERE LOWER(COALESCE("metadata"->>'synthetic', 'false')) IN ('true', '1', 'yes')
)
UPDATE "media_collections" collections
SET "visibility" = 'unlisted'
WHERE collections."visibility" = 'public'
  AND EXISTS (
    SELECT 1
    FROM "media_collection_items" items
    JOIN synthetic_assets assets ON assets.id = items."mediaAssetId"
    WHERE items."collectionId" = collections.id
  );

WITH synthetic_assets AS (
  SELECT id
  FROM "media_assets"
  WHERE LOWER(COALESCE("metadata"->>'synthetic', 'false')) IN ('true', '1', 'yes')
)
UPDATE "characters" characters
SET
  "imageAssetId" = NULL,
  "visibility" = 'private',
  "status" = 'draft'
FROM synthetic_assets assets
WHERE characters."imageAssetId" = assets.id;

WITH synthetic_assets AS (
  SELECT id
  FROM "media_assets"
  WHERE LOWER(COALESCE("metadata"->>'synthetic', 'false')) IN ('true', '1', 'yes')
)
UPDATE "character_visual_profiles" profiles
SET "status" = 'archived'
WHERE profiles."status" = 'active'
  AND EXISTS (
    SELECT 1
    FROM synthetic_assets assets
    WHERE profiles."anchorAssetIds" ? assets.id
       OR profiles."referenceAssetIds" ? assets.id
  );

WITH synthetic_assets AS (
  SELECT id
  FROM "media_assets"
  WHERE LOWER(COALESCE("metadata"->>'synthetic', 'false')) IN ('true', '1', 'yes')
)
UPDATE "character_looks" looks
SET
  "referenceAssetId" = NULL,
  "status" = CASE
    WHEN looks."status" = 'active' THEN 'needs_rebase'
    ELSE looks."status"
  END,
  "activeKey" = NULL
FROM synthetic_assets assets
WHERE looks."referenceAssetId" = assets.id;

WITH synthetic_assets AS (
  SELECT id
  FROM "media_assets"
  WHERE LOWER(COALESCE("metadata"->>'synthetic', 'false')) IN ('true', '1', 'yes')
)
UPDATE "reference_candidates" candidates
SET
  "status" = 'rejected',
  "rejectionReason" = 'synthetic_media_not_authoritative',
  "promotedRevisionId" = NULL
FROM synthetic_assets assets
WHERE candidates."mediaAssetId" = assets.id
  AND candidates."status" <> 'rejected';

WITH synthetic_assets AS (
  SELECT id
  FROM "media_assets"
  WHERE LOWER(COALESCE("metadata"->>'synthetic', 'false')) IN ('true', '1', 'yes')
)
UPDATE "reference_set_revisions" revisions
SET "status" = 'superseded'
WHERE revisions."status" = 'active'
  AND EXISTS (
    SELECT 1
    FROM "character_visual_reference_snapshots" snapshots
    JOIN synthetic_assets assets ON assets.id = snapshots."mediaAssetId"
    WHERE snapshots."referenceSetRevisionId" = revisions.id
  );

WITH synthetic_assets AS (
  SELECT id
  FROM "media_assets"
  WHERE LOWER(COALESCE("metadata"->>'synthetic', 'false')) IN ('true', '1', 'yes')
)
UPDATE "media_asset_placements" placements
SET
  "status" = 'archived',
  "archivedAt" = COALESCE(placements."archivedAt", NOW())
FROM synthetic_assets assets
WHERE placements."mediaAssetId" = assets.id
  AND placements."status" <> 'archived';

WITH synthetic_assets AS (
  SELECT id
  FROM "media_assets"
  WHERE LOWER(COALESCE("metadata"->>'synthetic', 'false')) IN ('true', '1', 'yes')
)
UPDATE "character_projects" projects
SET "draftImageAssetId" = NULL
FROM synthetic_assets assets
WHERE projects."draftImageAssetId" = assets.id;

WITH synthetic_assets AS (
  SELECT id
  FROM "media_assets"
  WHERE LOWER(COALESCE("metadata"->>'synthetic', 'false')) IN ('true', '1', 'yes')
)
UPDATE "character_templates" templates
SET "coverAssetId" = NULL
FROM synthetic_assets assets
WHERE templates."coverAssetId" = assets.id;

WITH synthetic_preview_jobs AS (
  SELECT jobs.id, jobs."draftId"
  FROM "character_preview_jobs" jobs
  JOIN "media_assets" assets ON assets.id = jobs."resultAssetId"
  WHERE LOWER(COALESCE(assets."metadata"->>'synthetic', 'false')) IN ('true', '1', 'yes')
)
UPDATE "character_drafts" drafts
SET "previewJobId" = NULL
FROM synthetic_preview_jobs jobs
WHERE drafts.id = jobs."draftId"
  AND drafts."previewJobId" = jobs.id;

WITH synthetic_assets AS (
  SELECT id
  FROM "media_assets"
  WHERE LOWER(COALESCE("metadata"->>'synthetic', 'false')) IN ('true', '1', 'yes')
),
synthetic_releases AS (
  SELECT DISTINCT releases.id
  FROM "character_releases" releases
  JOIN synthetic_assets assets
    ON jsonb_path_exists(
      releases."releasePlacementManifest",
      '$.placements[*] ? (@.assetId == $assetId)',
      jsonb_build_object('assetId', to_jsonb(assets.id))
    )
)
UPDATE "character_serving" serving
SET
  "currentReleaseId" = CASE
    WHEN serving."currentReleaseId" IN (SELECT id FROM synthetic_releases) THEN NULL
    ELSE serving."currentReleaseId"
  END,
  "scheduledReleaseId" = CASE
    WHEN serving."scheduledReleaseId" IN (SELECT id FROM synthetic_releases) THEN NULL
    ELSE serving."scheduledReleaseId"
  END,
  "scheduledAt" = CASE
    WHEN serving."scheduledReleaseId" IN (SELECT id FROM synthetic_releases) THEN NULL
    ELSE serving."scheduledAt"
  END,
  "state" = CASE
    WHEN serving."currentReleaseId" IN (SELECT id FROM synthetic_releases) THEN 'inactive'
    ELSE serving."state"
  END
WHERE serving."currentReleaseId" IN (SELECT id FROM synthetic_releases)
   OR serving."scheduledReleaseId" IN (SELECT id FROM synthetic_releases);

WITH synthetic_assets AS (
  SELECT id
  FROM "media_assets"
  WHERE LOWER(COALESCE("metadata"->>'synthetic', 'false')) IN ('true', '1', 'yes')
),
synthetic_releases AS (
  SELECT DISTINCT releases.id
  FROM "character_releases" releases
  JOIN synthetic_assets assets
    ON jsonb_path_exists(
      releases."releasePlacementManifest",
      '$.placements[*] ? (@.assetId == $assetId)',
      jsonb_build_object('assetId', to_jsonb(assets.id))
    )
)
UPDATE "character_releases" releases
SET
  "status" = CASE
    WHEN releases."status" = 'published' THEN 'superseded'
    ELSE 'failed'
  END,
  "readiness" = 'blocked'
WHERE releases.id IN (SELECT id FROM synthetic_releases)
  AND releases."status" NOT IN ('superseded', 'failed', 'withdrawn');

UPDATE "media_assets"
SET
  "visibility" = 'unlisted',
  "metadata" = "metadata" || jsonb_build_object(
    'quarantined', TRUE,
    'quarantineReason', 'synthetic_media_not_authoritative'
  )
WHERE LOWER(COALESCE("metadata"->>'synthetic', 'false')) IN ('true', '1', 'yes');
