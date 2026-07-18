BEGIN;

-- Keep generated Release publication authority identical to the shared strict
-- manifest contract. This validator is intentionally independent of Serving
-- state so qualification cannot bless a shape that Admin/runtime later rejects.
CREATE FUNCTION assert_character_release_asset_manifest_v2(
  manifest JSONB
)
RETURNS void AS $$
DECLARE
  placement JSONB;
  slot_version NUMERIC;
  distinct_slot_count INTEGER;
  distinct_asset_count INTEGER;
BEGIN
  IF jsonb_typeof(manifest) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION
      'live public generated Character requires strict v2 Release manifest contract';
  END IF;

  IF NOT (
      manifest ?& ARRAY['schemaVersion', 'placements']::TEXT[]
    )
    OR (
      manifest - ARRAY['schemaVersion', 'placements']::TEXT[]
    ) IS DISTINCT FROM '{}'::JSONB
    OR jsonb_typeof(manifest->'schemaVersion') IS DISTINCT FROM 'number'
    OR manifest->'schemaVersion' IS DISTINCT FROM '2'::JSONB
    OR jsonb_typeof(manifest->'placements') IS DISTINCT FROM 'array'
    OR jsonb_array_length(manifest->'placements') <> 3
  THEN
    RAISE EXCEPTION
      'live public generated Character requires strict v2 Release manifest contract';
  END IF;

  FOR placement IN
    SELECT value
    FROM jsonb_array_elements(manifest->'placements') AS entry(value)
  LOOP
    IF jsonb_typeof(placement) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION
        'live public generated Character requires strict v2 Release manifest contract';
    END IF;

    IF NOT (
        placement ?& ARRAY[
          'slotKey',
          'assetId',
          'slotVersion',
          'runId',
          'itemId',
          'reviewDecisionId',
          'generationJobId'
        ]::TEXT[]
      )
      OR (
        placement - ARRAY[
          'slotKey',
          'assetId',
          'slotVersion',
          'runId',
          'itemId',
          'reviewDecisionId',
          'generationJobId',
          'bootstrapIdentity'
        ]::TEXT[]
      ) IS DISTINCT FROM '{}'::JSONB
      OR jsonb_typeof(placement->'slotKey') IS DISTINCT FROM 'string'
      OR placement->>'slotKey' NOT IN (
        'character_avatar',
        'character_hero',
        'character_chat'
      )
      OR jsonb_typeof(placement->'assetId') IS DISTINCT FROM 'string'
      OR NULLIF(BTRIM(placement->>'assetId'), '') IS NULL
      OR placement->>'assetId' IS DISTINCT FROM
        BTRIM(placement->>'assetId')
      OR jsonb_typeof(placement->'runId') IS DISTINCT FROM 'string'
      OR NULLIF(BTRIM(placement->>'runId'), '') IS NULL
      OR jsonb_typeof(placement->'itemId') IS DISTINCT FROM 'string'
      OR NULLIF(BTRIM(placement->>'itemId'), '') IS NULL
      OR jsonb_typeof(placement->'reviewDecisionId') IS DISTINCT FROM 'string'
      OR NULLIF(BTRIM(placement->>'reviewDecisionId'), '') IS NULL
      OR jsonb_typeof(placement->'generationJobId') IS DISTINCT FROM 'string'
      OR NULLIF(BTRIM(placement->>'generationJobId'), '') IS NULL
      OR (
        placement ? 'bootstrapIdentity'
        AND jsonb_typeof(placement->'bootstrapIdentity')
          IS DISTINCT FROM 'boolean'
      )
    THEN
      RAISE EXCEPTION
        'live public generated Character requires strict v2 Release manifest contract';
    END IF;

    IF jsonb_typeof(placement->'slotVersion') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION
        'live public generated Character requires strict v2 Release manifest contract';
    END IF;
    slot_version := (placement->>'slotVersion')::NUMERIC;
    IF slot_version <= 0 OR slot_version <> TRUNC(slot_version) THEN
      RAISE EXCEPTION
        'live public generated Character requires strict v2 Release manifest contract';
    END IF;
  END LOOP;

  SELECT
    count(DISTINCT value->>'slotKey')::INTEGER,
    count(DISTINCT BTRIM(value->>'assetId'))::INTEGER
  INTO distinct_slot_count, distinct_asset_count
  FROM jsonb_array_elements(manifest->'placements')
    AS manifest_placement(value);

  IF distinct_slot_count <> 3 OR distinct_asset_count <> 3 THEN
    RAISE EXCEPTION
      'live public generated Character requires strict v2 Release manifest contract';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION assert_live_public_character_manifest_contract_v2(
  checked_character_id TEXT
)
RETURNS void AS $$
DECLARE
  release_manifest JSONB;
  release_legacy BOOLEAN;
BEGIN
  IF checked_character_id IS NULL THEN
    RETURN;
  END IF;

  SELECT
    release."releasePlacementManifest",
    release.legacy
  INTO release_manifest, release_legacy
  FROM "characters" character
  JOIN "character_serving" serving
    ON serving."characterId" = character.id
  JOIN "character_releases" release
    ON release.id = serving."currentReleaseId"
  WHERE character.id = checked_character_id
    AND character.visibility = 'public'
    AND character.status = 'approved'
    AND character."deletedAt" IS NULL
    AND serving.state = 'live';

  IF NOT FOUND OR release_legacy THEN
    RETURN;
  END IF;

  PERFORM assert_character_release_asset_manifest_v2(release_manifest);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION assert_live_public_character_authority_v2(
  checked_character_id TEXT
)
RETURNS void AS $$
BEGIN
  PERFORM assert_live_public_character_core_authority_v2(
    checked_character_id
  );
  PERFORM assert_live_public_character_manifest_contract_v2(
    checked_character_id
  );
  PERFORM assert_live_public_character_asset_pack_v2(
    checked_character_id
  );
  PERFORM assert_live_public_character_blob_authority_v2(
    checked_character_id
  );
END;
$$ LANGUAGE plpgsql;

-- The existing deferred INSERT trigger keeps its identity and transaction
-- semantics. Extend its function so a generated qualification pins an exact
-- strict manifest even before that Release becomes the live projection.
CREATE OR REPLACE FUNCTION
  enforce_generated_public_qualification_policy_route_authority()
RETURNS trigger AS $$
DECLARE
  pinned_release "character_releases"%ROWTYPE;
  required_route JSONB;
BEGIN
  IF NEW.kind <> 'generated_release' THEN
    RETURN NEW;
  END IF;

  SELECT *
  INTO pinned_release
  FROM "character_releases"
  WHERE id = NEW."releaseId"
    AND "snapshotHash" = NEW."releaseSnapshotHash";

  IF NOT FOUND
    OR pinned_release.legacy
    OR pinned_release."generationProvenance"->>'schemaVersion'
      IS DISTINCT FROM 'character-release-generation-provenance-v2'
    OR pinned_release."generationProvenance"->>'policyVersion'
      IS DISTINCT FROM 'character-release-policy-v2'
  THEN
    RAISE EXCEPTION
      'generated public qualification requires exact policy and required route authority';
  END IF;

  required_route :=
    pinned_release."generationProvenance"->'requiredReleaseRoute';

  IF jsonb_typeof(required_route) IS DISTINCT FROM 'object'
    OR NULLIF(required_route->>'routeFingerprint', '') IS NULL
    OR NULLIF(required_route->>'matrixKey', '') IS NULL
    OR NULLIF(required_route->>'generationProfileKey', '') IS NULL
    OR NULLIF(required_route->>'generationProfileVersion', '') IS NULL
    OR NULLIF(required_route->>'workflowKey', '') IS NULL
    OR NULLIF(required_route->>'workflowVersion', '') IS NULL
  THEN
    RAISE EXCEPTION
      'generated public qualification requires exact policy and required route authority';
  END IF;

  PERFORM assert_character_release_asset_manifest_v2(
    pinned_release."releasePlacementManifest"
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Refuse to deploy over already-qualified malformed generated Releases,
-- including inactive/scheduled rows, then recheck every live/public Character.
DO $validate_existing_generated_manifest_authority$
DECLARE
  qualified_manifest JSONB;
  character_id TEXT;
BEGIN
  FOR qualified_manifest IN
    SELECT release."releasePlacementManifest"
    FROM "public_catalog_qualifications" qualification
    JOIN "character_releases" release
      ON release.id = qualification."releaseId"
      AND release."snapshotHash" = qualification."releaseSnapshotHash"
    WHERE qualification.kind = 'generated_release'
      AND qualification."revokedAt" IS NULL
  LOOP
    PERFORM assert_character_release_asset_manifest_v2(qualified_manifest);
  END LOOP;

  FOR character_id IN
    SELECT character.id
    FROM "characters" character
    JOIN "character_serving" serving
      ON serving."characterId" = character.id
    WHERE character.visibility = 'public'
      AND character.status = 'approved'
      AND character."deletedAt" IS NULL
      AND serving.state = 'live'
  LOOP
    PERFORM assert_live_public_character_authority_v2(character_id);
  END LOOP;
END;
$validate_existing_generated_manifest_authority$;

COMMIT;
