-- Public catalog eligibility is a durable authority, not an inference from
-- presentation state. Generated Releases point to exact validation evidence;
-- curated editorial imports use a separate, explicit provenance kind.
ALTER TABLE "product_feedback_items"
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'user';

UPDATE "product_feedback_items"
SET "source" = 'official'
WHERE "id" IN (
  'seed-feedback-generator-recipes',
  'seed-feedback-creator-collections',
  'seed-feedback-chat-memory-review'
);

ALTER TABLE "product_feedback_items"
  ADD CONSTRAINT "product_feedback_items_source_check"
  CHECK ("source" IN ('official', 'user'));

CREATE INDEX "product_feedback_items_source_visibility_status_idx"
  ON "product_feedback_items"("source", "visibility", "status");

CREATE UNIQUE INDEX "character_releases_id_snapshotHash_key"
  ON "character_releases"("id", "snapshotHash");

CREATE TABLE "public_catalog_qualifications" (
  "id" TEXT NOT NULL,
  "releaseId" TEXT NOT NULL,
  "releaseSnapshotHash" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "validationRunId" TEXT,
  "evidence" JSONB NOT NULL,
  "qualifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMP(3),
  CONSTRAINT "public_catalog_qualifications_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "public_catalog_qualifications_releaseId_key"
  ON "public_catalog_qualifications"("releaseId");
CREATE UNIQUE INDEX "public_catalog_qualifications_validationRunId_key"
  ON "public_catalog_qualifications"("validationRunId");
CREATE UNIQUE INDEX "public_catalog_qualifications_releaseId_releaseSnapshotHash_key"
  ON "public_catalog_qualifications"("releaseId", "releaseSnapshotHash");
CREATE INDEX "public_catalog_qualifications_kind_revokedAt_qualifiedAt_idx"
  ON "public_catalog_qualifications"("kind", "revokedAt", "qualifiedAt");

ALTER TABLE "public_catalog_qualifications"
  ADD CONSTRAINT "public_catalog_qualifications_kind_check"
  CHECK ("kind" IN ('generated_release', 'editorial_import')),
  ADD CONSTRAINT "public_catalog_qualifications_evidence_kind_check"
  CHECK (
    ("kind" = 'generated_release' AND "validationRunId" IS NOT NULL)
    OR ("kind" = 'editorial_import' AND "validationRunId" IS NULL)
  ),
  ADD CONSTRAINT "public_catalog_qualifications_release_fkey"
  FOREIGN KEY ("releaseId", "releaseSnapshotHash")
  REFERENCES "character_releases"("id", "snapshotHash")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "public_catalog_qualifications_validationRunId_fkey"
  FOREIGN KEY ("validationRunId")
  REFERENCES "release_validation_runs"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "public_content_repair_items" (
  "id" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "reasonCodes" JSONB NOT NULL,
  "evidence" JSONB NOT NULL,
  "repairPath" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open',
  "activeKey" TEXT,
  "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "public_content_repair_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "public_content_repair_items_status_check"
    CHECK ("status" IN ('open', 'resolved', 'waived'))
);

CREATE UNIQUE INDEX "public_content_repair_items_activeKey_key"
  ON "public_content_repair_items"("activeKey");
CREATE INDEX "public_content_repair_items_status_entityType_detectedAt_idx"
  ON "public_content_repair_items"("status", "entityType", "detectedAt");
CREATE INDEX "public_content_repair_items_entityType_entityId_idx"
  ON "public_content_repair_items"("entityType", "entityId");

CREATE TRIGGER release_validation_runs_immutable
BEFORE UPDATE ON "release_validation_runs"
FOR EACH ROW EXECUTE FUNCTION reject_admin_evidence_update();

CREATE TRIGGER release_check_results_immutable
BEFORE UPDATE ON "release_check_results"
FOR EACH ROW EXECUTE FUNCTION reject_admin_evidence_update();

-- Do not promote historical validation rows into public authority. Databases
-- that previously lacked immutable evidence triggers cannot prove that those
-- rows were never rewritten. Existing generated releases must be revalidated
-- under the current policy after this migration; the repair queue below keeps
-- their content without pretending the old evidence is canonical.

CREATE FUNCTION enforce_public_catalog_qualification_authority()
RETURNS trigger AS $$
DECLARE
  pinned_release "character_releases"%ROWTYPE;
  pinned_validation "release_validation_runs"%ROWTYPE;
  release_character_id TEXT;
  projected_character_asset_id TEXT;
  manifest_avatar_asset_id TEXT;
  avatar_placement_count INTEGER;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
      OR NEW."releaseId" IS DISTINCT FROM OLD."releaseId"
      OR NEW."releaseSnapshotHash" IS DISTINCT FROM OLD."releaseSnapshotHash"
      OR NEW.kind IS DISTINCT FROM OLD.kind
      OR NEW."validationRunId" IS DISTINCT FROM OLD."validationRunId"
      OR NEW.evidence IS DISTINCT FROM OLD.evidence
      OR NEW."qualifiedAt" IS DISTINCT FROM OLD."qualifiedAt"
      OR OLD."revokedAt" IS NOT NULL
      OR NEW."revokedAt" IS NULL
    THEN
      RAISE EXCEPTION 'public catalog qualification is immutable except for one-way revocation';
    END IF;
    RETURN NEW;
  END IF;

  SELECT *
  INTO pinned_release
  FROM "character_releases"
  WHERE id = NEW."releaseId"
    AND "snapshotHash" = NEW."releaseSnapshotHash";

  IF NOT FOUND
    OR pinned_release.status <> 'published'
    OR pinned_release."publishedAt" IS NULL
  THEN
    RAISE EXCEPTION 'public catalog qualification requires an exact published Release';
  END IF;

  SELECT projects."characterId", characters."imageAssetId"
  INTO release_character_id, projected_character_asset_id
  FROM "character_projects" projects
  JOIN "characters" characters
    ON characters.id = projects."characterId"
  WHERE projects.id = pinned_release."projectId";

  SELECT count(*)::integer, min(placement->>'assetId')
  INTO avatar_placement_count, manifest_avatar_asset_id
  FROM jsonb_array_elements(
    CASE
      WHEN jsonb_typeof(pinned_release."releasePlacementManifest"->'placements') = 'array'
        THEN pinned_release."releasePlacementManifest"->'placements'
      ELSE '[]'::jsonb
    END
  ) AS placement
  WHERE placement->>'slotKey' = 'character_avatar'
    AND NULLIF(placement->>'assetId', '') IS NOT NULL;

  IF release_character_id IS NULL
    OR projected_character_asset_id IS NULL
    OR avatar_placement_count <> 1
    OR manifest_avatar_asset_id IS DISTINCT FROM projected_character_asset_id
  THEN
    RAISE EXCEPTION 'public catalog qualification requires the exact Character avatar projection';
  END IF;

  IF NEW.kind = 'generated_release' THEN
    SELECT *
    INTO pinned_validation
    FROM "release_validation_runs"
    WHERE id = NEW."validationRunId"
      AND "releaseId" = NEW."releaseId"
      AND "snapshotHash" = NEW."releaseSnapshotHash"
      AND "policyVersion" = 'character-release-policy-v2'
      AND result = 'passed'
      AND "finishedAt" IS NOT NULL;

    IF NOT FOUND
      OR pinned_release.legacy
      OR pinned_release.readiness <> 'ready'
      OR pinned_release."generationProvenance"->>'schemaVersion'
        <> 'character-release-generation-provenance-v2'
    THEN
      RAISE EXCEPTION 'generated public qualification requires current strict validation evidence';
    END IF;
  ELSE
    IF NOT pinned_release.legacy
      OR pinned_release."generationProvenance"->>'schemaVersion'
        <> 'character-release-editorial-import-v1'
      OR NEW.evidence->>'policyVersion' <> 'public-catalog-editorial-import-v1'
    THEN
      RAISE EXCEPTION 'editorial public qualification requires explicit import provenance';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER public_catalog_qualification_authority
BEFORE INSERT OR UPDATE ON "public_catalog_qualifications"
FOR EACH ROW EXECUTE FUNCTION enforce_public_catalog_qualification_authority();

-- Rows that cannot prove public eligibility are preserved and routed to an
-- explicit repair queue. Curated seed Characters are exempt here because the
-- idempotent seed step immediately creates their truthful editorial Releases.
INSERT INTO "public_content_repair_items" (
  "id",
  "entityType",
  "entityId",
  "reasonCodes",
  "evidence",
  "repairPath",
  "activeKey"
)
SELECT
  'public-repair:character:' || characters.id,
  'character',
  characters.id,
  '["missing_exact_public_qualification"]'::jsonb,
  jsonb_build_object(
    'before', jsonb_build_object(
      'visibility', characters.visibility,
      'status', characters.status,
      'imageAssetId', characters."imageAssetId"
    ),
    'currentReleaseId', serving."currentReleaseId"
  ),
  '/admin/characters/' || characters.id || '?tab=assets',
  'public-catalog:character:' || characters.id
FROM "characters" characters
LEFT JOIN "character_serving" serving
  ON serving."characterId" = characters.id
LEFT JOIN "media_assets" image_asset
  ON image_asset.id = characters."imageAssetId"
LEFT JOIN "users" creator
  ON creator.id = characters."creatorId"
WHERE characters.visibility = 'public'
  AND characters.status = 'approved'
  AND characters."deletedAt" IS NULL
  AND characters.id NOT IN (
    'melissa-burke',
    'summoned-world',
    'sarah-mercer',
    'alexa-reeves',
    'tamsin-jacobs',
    'truth-confessional',
    'truth-stepmother',
    'stephanie',
    'kennedy-graham',
    'eleanor-dawn',
    'bailey-price',
    'sophie',
    'raya-reyes',
    'emily-coming-home',
    'diana-weird-girl',
    'lola-moonstruck'
  )
  AND NOT (
    (
      characters.source = 'official'
      OR (
        characters.source = 'user'
        AND creator."dataClass" = 'customer'
        AND creator.role = 'user'
        AND creator.status = 'active'
        AND creator."deletedAt" IS NULL
      )
    )
    AND image_asset.id IS NOT NULL
    AND image_asset.type = 'image'
    AND image_asset."deletedAt" IS NULL
    AND image_asset.visibility = 'public_pack'
    AND image_asset."safetyStatus" = 'passed'
    AND COALESCE(
      image_asset.metadata->'synthetic',
      'null'::jsonb
    ) IN ('false'::jsonb, 'null'::jsonb)
    AND LOWER(COALESCE(image_asset.metadata#>>'{platformAsset,status}', ''))
      NOT IN ('archived', 'rejected', 'blocked')
    AND serving.state = 'live'
    AND EXISTS (
      SELECT 1
      FROM "character_releases" releases
      JOIN "character_projects" projects
        ON projects.id = releases."projectId"
        AND projects."characterId" = characters.id
      JOIN "public_catalog_qualifications" qualifications
        ON qualifications."releaseId" = releases.id
        AND qualifications."releaseSnapshotHash" = releases."snapshotHash"
        AND qualifications."revokedAt" IS NULL
      WHERE releases.id = serving."currentReleaseId"
        AND releases.status = 'published'
        AND releases."publishedAt" IS NOT NULL
        AND characters."imageAssetId" IS NOT DISTINCT FROM (
          SELECT placement->>'assetId'
          FROM jsonb_array_elements(
            CASE
              WHEN jsonb_typeof(releases."releasePlacementManifest"->'placements') = 'array'
                THEN releases."releasePlacementManifest"->'placements'
              ELSE '[]'::jsonb
            END
          ) AS placement
          WHERE placement->>'slotKey' = 'character_avatar'
          LIMIT 1
        )
        AND 1 = (
          SELECT count(*)
          FROM jsonb_array_elements(
            CASE
              WHEN jsonb_typeof(releases."releasePlacementManifest"->'placements') = 'array'
                THEN releases."releasePlacementManifest"->'placements'
              ELSE '[]'::jsonb
            END
          ) AS placement
          WHERE placement->>'slotKey' = 'character_avatar'
            AND NULLIF(placement->>'assetId', '') IS NOT NULL
        )
        AND (
          (
            releases.legacy = TRUE
            AND qualifications.kind = 'editorial_import'
          )
          OR (
            releases.legacy = FALSE
            AND releases.readiness = 'ready'
            AND qualifications.kind = 'generated_release'
            AND qualifications."validationRunId" IS NOT NULL
          )
        )
    )
  )
ON CONFLICT ("activeKey") DO NOTHING;

UPDATE "characters" characters
SET
  visibility = 'unlisted',
  "updatedAt" = CURRENT_TIMESTAMP
WHERE EXISTS (
  SELECT 1
  FROM "public_content_repair_items" repairs
  WHERE repairs."activeKey" = 'public-catalog:character:' || characters.id
    AND repairs.status = 'open'
);

INSERT INTO "public_content_repair_items" (
  "id",
  "entityType",
  "entityId",
  "reasonCodes",
  "evidence",
  "repairPath",
  "activeKey"
)
SELECT
  'public-repair:collection:' || collections.id,
  'collection',
  collections.id,
  CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM "media_collection_items" items
      WHERE items."collectionId" = collections.id
    ) THEN '["empty_collection"]'::jsonb
    ELSE '["contains_unpublishable_media"]'::jsonb
  END,
  jsonb_build_object(
    'before', jsonb_build_object(
      'visibility', collections.visibility,
      'source', collections.source
    )
  ),
  '/community?collection=' || collections.id,
  'public-catalog:collection:' || collections.id
FROM "media_collections" collections
LEFT JOIN "users" owner ON owner.id = collections."ownerId"
WHERE collections.visibility = 'public'
  AND NOT (
    (
      collections.source = 'official'
      OR (
        collections.source = 'user'
        AND owner."dataClass" = 'customer'
        AND owner.role = 'user'
        AND owner.status = 'active'
        AND owner."deletedAt" IS NULL
      )
    )
    AND EXISTS (
      SELECT 1 FROM "media_collection_items" items
      WHERE items."collectionId" = collections.id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM "media_collection_items" items
      JOIN "media_assets" assets ON assets.id = items."mediaAssetId"
      WHERE items."collectionId" = collections.id
        AND (
          assets."deletedAt" IS NOT NULL
          OR assets.visibility <> 'public_pack'
          OR assets."safetyStatus" <> 'passed'
          OR COALESCE(
            assets.metadata->'synthetic',
            'null'::jsonb
          ) NOT IN ('false'::jsonb, 'null'::jsonb)
          OR LOWER(COALESCE(assets.metadata#>>'{platformAsset,status}', ''))
            IN ('archived', 'rejected', 'blocked')
        )
    )
  )
ON CONFLICT ("activeKey") DO NOTHING;

UPDATE "media_collections" collections
SET visibility = 'unlisted'
WHERE EXISTS (
  SELECT 1
  FROM "public_content_repair_items" repairs
  WHERE repairs."activeKey" = 'public-catalog:collection:' || collections.id
    AND repairs.status = 'open'
);

INSERT INTO "public_content_repair_items" (
  "id",
  "entityType",
  "entityId",
  "reasonCodes",
  "evidence",
  "repairPath",
  "activeKey"
)
SELECT
  'public-repair:feedback:' || feedback.id,
  'feedback',
  feedback.id,
  '["invalid_public_feedback_provenance"]'::jsonb,
  jsonb_build_object(
    'before', jsonb_build_object(
      'visibility', feedback.visibility,
      'source', feedback.source,
      'createdById', feedback."createdById"
    )
  ),
  '/helpdesk',
  'public-catalog:feedback:' || feedback.id
FROM "product_feedback_items" feedback
LEFT JOIN "users" creator ON creator.id = feedback."createdById"
WHERE feedback.visibility = 'public'
  AND NOT (
    feedback.source = 'official'
    OR (
      feedback.source = 'user'
      AND creator."dataClass" = 'customer'
      AND creator.role = 'user'
      AND creator.status = 'active'
      AND creator."deletedAt" IS NULL
    )
  )
ON CONFLICT ("activeKey") DO NOTHING;

UPDATE "product_feedback_items" feedback
SET
  visibility = 'unlisted',
  "updatedAt" = CURRENT_TIMESTAMP
WHERE EXISTS (
  SELECT 1
  FROM "public_content_repair_items" repairs
  WHERE repairs."activeKey" = 'public-catalog:feedback:' || feedback.id
    AND repairs.status = 'open'
);

-- Once repair has removed invalid legacy rows from the public audience, keep
-- CharacterServing, Character.imageAssetId, and the Release manifest aligned.
-- Constraint triggers are deferred so the publish transaction may update the
-- three projections in any order while still validating the final state.
CREATE FUNCTION enforce_live_public_character_projection()
RETURNS trigger AS $$
DECLARE
  checked_character_id TEXT;
  projected_asset_id TEXT;
  manifest_asset_id TEXT;
  manifest_asset_count INTEGER;
  release_character_id TEXT;
  character_visibility TEXT;
  character_status TEXT;
  character_deleted_at TIMESTAMP(3);
  serving_state TEXT;
  serving_release_id TEXT;
BEGIN
  IF TG_TABLE_NAME = 'characters' THEN
    checked_character_id := NEW.id;
  ELSIF TG_TABLE_NAME = 'character_serving' THEN
    checked_character_id := NEW."characterId";
  ELSE
    SELECT projects."characterId"
    INTO checked_character_id
    FROM "character_projects" projects
    WHERE projects.id = NEW."projectId";
  END IF;

  SELECT
    characters."imageAssetId",
    characters.visibility,
    characters.status,
    characters."deletedAt",
    serving.state,
    serving."currentReleaseId"
  INTO
    projected_asset_id,
    character_visibility,
    character_status,
    character_deleted_at,
    serving_state,
    serving_release_id
  FROM "characters" characters
  LEFT JOIN "character_serving" serving
    ON serving."characterId" = characters.id
  WHERE characters.id = checked_character_id;

  IF character_visibility <> 'public'
    OR character_status <> 'approved'
    OR character_deleted_at IS NOT NULL
    OR serving_state IS DISTINCT FROM 'live'
  THEN
    RETURN NEW;
  END IF;

  SELECT
    projects."characterId",
    count(*)::integer,
    min(placement->>'assetId')
  INTO
    release_character_id,
    manifest_asset_count,
    manifest_asset_id
  FROM "character_releases" releases
  JOIN "character_projects" projects
    ON projects.id = releases."projectId"
  LEFT JOIN LATERAL jsonb_array_elements(
    CASE
      WHEN jsonb_typeof(releases."releasePlacementManifest"->'placements') = 'array'
        THEN releases."releasePlacementManifest"->'placements'
      ELSE '[]'::jsonb
    END
  ) AS placement
    ON placement->>'slotKey' = 'character_avatar'
    AND NULLIF(placement->>'assetId', '') IS NOT NULL
  WHERE releases.id = serving_release_id
  GROUP BY projects."characterId";

  IF serving_release_id IS NULL
    OR release_character_id IS DISTINCT FROM checked_character_id
    OR projected_asset_id IS NULL
    OR manifest_asset_count <> 1
    OR manifest_asset_id IS DISTINCT FROM projected_asset_id
  THEN
    RAISE EXCEPTION 'live public Character projection must match its exact current Release avatar';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER live_public_character_projection_from_character
AFTER INSERT OR UPDATE ON "characters"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_live_public_character_projection();

CREATE CONSTRAINT TRIGGER live_public_character_projection_from_serving
AFTER INSERT OR UPDATE ON "character_serving"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_live_public_character_projection();

CREATE CONSTRAINT TRIGGER live_public_character_projection_from_release
AFTER INSERT OR UPDATE ON "character_releases"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_live_public_character_projection();
