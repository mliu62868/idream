BEGIN;

-- PostgreSQL BTRIM(text) removes only ASCII space, while JavaScript String.trim
-- removes the complete ECMAScript WhiteSpace + LineTerminator set. Keep the
-- database validator aligned with the Shared Zod contract.
CREATE FUNCTION trim_ecmascript_whitespace(value TEXT)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT BTRIM(
    value,
    CHR(9)
      || CHR(10)
      || CHR(11)
      || CHR(12)
      || CHR(13)
      || CHR(32)
      || CHR(160)
      || CHR(5760)
      || CHR(8192)
      || CHR(8193)
      || CHR(8194)
      || CHR(8195)
      || CHR(8196)
      || CHR(8197)
      || CHR(8198)
      || CHR(8199)
      || CHR(8200)
      || CHR(8201)
      || CHR(8202)
      || CHR(8232)
      || CHR(8233)
      || CHR(8239)
      || CHR(8287)
      || CHR(12288)
      || CHR(65279)
  );
$$;

CREATE OR REPLACE FUNCTION assert_character_release_asset_manifest_v2(
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
      OR NULLIF(
        trim_ecmascript_whitespace(placement->>'assetId'),
        ''
      ) IS NULL
      OR placement->>'assetId' IS DISTINCT FROM
        trim_ecmascript_whitespace(placement->>'assetId')
      OR jsonb_typeof(placement->'runId') IS DISTINCT FROM 'string'
      OR NULLIF(
        trim_ecmascript_whitespace(placement->>'runId'),
        ''
      ) IS NULL
      OR jsonb_typeof(placement->'itemId') IS DISTINCT FROM 'string'
      OR NULLIF(
        trim_ecmascript_whitespace(placement->>'itemId'),
        ''
      ) IS NULL
      OR jsonb_typeof(placement->'reviewDecisionId') IS DISTINCT FROM 'string'
      OR NULLIF(
        trim_ecmascript_whitespace(placement->>'reviewDecisionId'),
        ''
      ) IS NULL
      OR jsonb_typeof(placement->'generationJobId') IS DISTINCT FROM 'string'
      OR NULLIF(
        trim_ecmascript_whitespace(placement->>'generationJobId'),
        ''
      ) IS NULL
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
    IF slot_version <= 0
      OR slot_version > 9007199254740991
      OR slot_version <> TRUNC(slot_version)
    THEN
      RAISE EXCEPTION
        'live public generated Character requires strict v2 Release manifest contract';
    END IF;
  END LOOP;

  SELECT
    count(DISTINCT value->>'slotKey')::INTEGER,
    count(DISTINCT trim_ecmascript_whitespace(value->>'assetId'))::INTEGER
  INTO distinct_slot_count, distinct_asset_count
  FROM jsonb_array_elements(manifest->'placements')
    AS manifest_placement(value);

  IF distinct_slot_count <> 3 OR distinct_asset_count <> 3 THEN
    RAISE EXCEPTION
      'live public generated Character requires strict v2 Release manifest contract';
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Re-evaluate every active generated qualification and every live/public row.
-- No lineage is invented or backfilled.
DO $validate_existing_generated_manifest_exact_parity$
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
$validate_existing_generated_manifest_exact_parity$;

COMMIT;
