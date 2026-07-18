BEGIN;

-- Public visibility is a projection of one of two disjoint Release authority
-- kinds. Keep the database guard aligned with the runtime audience predicate:
-- a legacy editorial import or a validation-backed generated Release.
CREATE FUNCTION assert_live_public_character_authority_v2(
  checked_character_id TEXT
)
RETURNS void AS $$
DECLARE
  character_row RECORD;
  serving_row RECORD;
  release_row RECORD;
  project_character_id TEXT;
  qualification_row RECORD;
  validation_row RECORD;
  avatar_asset_id TEXT;
  avatar_count INTEGER;
  placement_count INTEGER;
  asset_row RECORD;
BEGIN
  IF checked_character_id IS NULL THEN
    RETURN;
  END IF;

  SELECT *
  INTO character_row
  FROM "characters"
  WHERE id = checked_character_id;

  IF NOT FOUND
    OR character_row.visibility <> 'public'
    OR character_row.status <> 'approved'
    OR character_row."deletedAt" IS NOT NULL
  THEN
    RETURN;
  END IF;

  SELECT *
  INTO serving_row
  FROM "character_serving"
  WHERE "characterId" = checked_character_id;

  IF NOT FOUND OR serving_row.state <> 'live' THEN
    RETURN;
  END IF;

  SELECT *
  INTO release_row
  FROM "character_releases"
  WHERE id = serving_row."currentReleaseId";

  IF NOT FOUND
    OR release_row.status <> 'published'
    OR release_row."publishedAt" IS NULL
    OR release_row.readiness <> 'ready'
  THEN
    RAISE EXCEPTION
      'live public Character requires one ready published current Release';
  END IF;

  SELECT "characterId"
  INTO project_character_id
  FROM "character_projects"
  WHERE id = release_row."projectId";

  SELECT
    count(*)::integer,
    min(placement->>'assetId'),
    (
      SELECT count(*)::integer
      FROM jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(
            release_row."releasePlacementManifest"->'placements'
          ) = 'array'
          THEN release_row."releasePlacementManifest"->'placements'
          ELSE '[]'::jsonb
        END
      )
    )
  INTO avatar_count, avatar_asset_id, placement_count
  FROM jsonb_array_elements(
    CASE
      WHEN jsonb_typeof(
        release_row."releasePlacementManifest"->'placements'
      ) = 'array'
      THEN release_row."releasePlacementManifest"->'placements'
      ELSE '[]'::jsonb
    END
  ) placement
  WHERE placement->>'slotKey' = 'character_avatar'
    AND NULLIF(placement->>'assetId', '') IS NOT NULL;

  IF project_character_id IS DISTINCT FROM checked_character_id
    OR avatar_count <> 1
    OR avatar_asset_id IS DISTINCT FROM character_row."imageAssetId"
  THEN
    RAISE EXCEPTION
      'live public Character projection must match its exact Release avatar';
  END IF;

  SELECT *
  INTO asset_row
  FROM "media_assets"
  WHERE id = avatar_asset_id;

  IF NOT FOUND
    OR asset_row."characterId" IS DISTINCT FROM checked_character_id
    OR asset_row.type <> 'image'
    OR asset_row."deletedAt" IS NOT NULL
    OR asset_row.visibility <> 'public_pack'
    OR asset_row."safetyStatus" <> 'passed'
    OR NULLIF(asset_row.url, '') IS NULL
    OR COALESCE(asset_row.metadata->'synthetic', 'null'::jsonb)
      NOT IN ('false'::jsonb, 'null'::jsonb)
    OR LOWER(COALESCE(
      asset_row.metadata#>>'{platformAsset,status}',
      ''
    )) IN ('archived', 'rejected', 'blocked')
  THEN
    RAISE EXCEPTION
      'live public Character requires its exact publishable Character asset';
  END IF;

  SELECT *
  INTO qualification_row
  FROM "public_catalog_qualifications"
  WHERE "releaseId" = release_row.id
    AND "releaseSnapshotHash" = release_row."snapshotHash"
    AND "revokedAt" IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'live public Character requires one exact non-revoked qualification';
  END IF;

  IF release_row.legacy THEN
    IF qualification_row.kind <> 'editorial_import'
      OR qualification_row."validationRunId" IS NOT NULL
      OR release_row."visualProfileId" IS NOT NULL
      OR release_row."visualProfileVersion" IS NOT NULL
      OR release_row."referenceSetRevisionId" IS NOT NULL
      OR release_row."generationProvenance"->>'schemaVersion'
        <> 'character-release-editorial-import-v1'
      OR release_row."generationProvenance"->>'recordId'
        IS DISTINCT FROM checked_character_id
      OR release_row."generationProvenance"->>'sourceAssetId'
        IS DISTINCT FROM avatar_asset_id
      OR NULLIF(
        release_row."generationProvenance"->>'dataset',
        ''
      ) IS NULL
      OR release_row."releasePlacementManifest"->>'schemaVersion' <> '1'
      OR release_row."releasePlacementManifest"->>'kind'
        <> 'editorial_import'
      OR placement_count <> 1
      OR qualification_row.evidence->>'schemaVersion'
        <> 'public-catalog-qualification-v1'
      OR qualification_row.evidence->>'policyVersion'
        <> 'public-catalog-editorial-import-v1'
      OR qualification_row.evidence->>'characterId'
        IS DISTINCT FROM checked_character_id
      OR qualification_row.evidence->>'sourceAssetId'
        IS DISTINCT FROM avatar_asset_id
      OR qualification_row.evidence#>>'{checks,exactSeedRecord}'
        IS DISTINCT FROM 'true'
      OR qualification_row.evidence#>>'{checks,nonSynthetic}'
        IS DISTINCT FROM 'true'
      OR qualification_row.evidence#>>'{checks,safetyPassed}'
        IS DISTINCT FROM 'true'
      OR qualification_row.evidence#>>'{checks,publicPack}'
        IS DISTINCT FROM 'true'
      OR qualification_row.evidence#>>'{checks,imageAvailable}'
        IS DISTINCT FROM 'true'
      OR asset_row.metadata->>'seedSource'
        IS DISTINCT FROM release_row."generationProvenance"->>'dataset'
    THEN
      RAISE EXCEPTION
        'live public editorial Character requires exact import authority';
    END IF;
  ELSE
    SELECT *
    INTO validation_row
    FROM "release_validation_runs"
    WHERE id = qualification_row."validationRunId"
      AND "releaseId" = release_row.id
      AND "snapshotHash" = release_row."snapshotHash"
      AND "policyVersion" = 'character-release-policy-v2'
      AND result = 'passed'
      AND "finishedAt" IS NOT NULL;

    IF qualification_row.kind <> 'generated_release'
      OR release_row."generationProvenance"->>'schemaVersion'
        <> 'character-release-generation-provenance-v2'
      OR NOT FOUND
    THEN
      RAISE EXCEPTION
        'live public generated Character requires exact validation authority';
    END IF;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION enforce_live_public_character_authority_v2()
RETURNS trigger AS $$
DECLARE
  checked_character_id TEXT;
  previous_character_id TEXT;
BEGIN
  IF TG_TABLE_NAME = 'characters' THEN
    checked_character_id := NEW.id;
  ELSIF TG_TABLE_NAME = 'character_serving' THEN
    checked_character_id := NEW."characterId";
  ELSIF TG_TABLE_NAME = 'character_releases' THEN
    SELECT "characterId"
    INTO checked_character_id
    FROM "character_projects"
    WHERE id = NEW."projectId";
  ELSIF TG_TABLE_NAME = 'public_catalog_qualifications' THEN
    SELECT projects."characterId"
    INTO checked_character_id
    FROM "character_releases" releases
    JOIN "character_projects" projects
      ON projects.id = releases."projectId"
    WHERE releases.id = NEW."releaseId";
  ELSE
    checked_character_id := NEW."characterId";
    previous_character_id := OLD."characterId";
  END IF;

  PERFORM assert_live_public_character_authority_v2(
    checked_character_id
  );
  IF previous_character_id IS DISTINCT FROM checked_character_id THEN
    PERFORM assert_live_public_character_authority_v2(
      previous_character_id
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER live_public_authority_v2_from_character
AFTER INSERT OR UPDATE ON "characters"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_live_public_character_authority_v2();

CREATE CONSTRAINT TRIGGER live_public_authority_v2_from_serving
AFTER INSERT OR UPDATE ON "character_serving"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_live_public_character_authority_v2();

CREATE CONSTRAINT TRIGGER live_public_authority_v2_from_release
AFTER INSERT OR UPDATE ON "character_releases"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_live_public_character_authority_v2();

CREATE CONSTRAINT TRIGGER live_public_authority_v2_from_qualification
AFTER INSERT OR UPDATE ON "public_catalog_qualifications"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_live_public_character_authority_v2();

CREATE CONSTRAINT TRIGGER live_public_authority_v2_from_media_asset
AFTER INSERT OR UPDATE ON "media_assets"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_live_public_character_authority_v2();

-- Refuse to certify a deployment that already contains a half-authoritative
-- live/public projection. Historical content must be repaired first.
DO $validate_existing_public_authority$
DECLARE
  character_id TEXT;
BEGIN
  FOR character_id IN
    SELECT characters.id
    FROM "characters" characters
    JOIN "character_serving" serving
      ON serving."characterId" = characters.id
    WHERE characters.visibility = 'public'
      AND characters.status = 'approved'
      AND characters."deletedAt" IS NULL
      AND serving.state = 'live'
  LOOP
    PERFORM assert_live_public_character_authority_v2(character_id);
  END LOOP;
END;
$validate_existing_public_authority$;

COMMIT;
