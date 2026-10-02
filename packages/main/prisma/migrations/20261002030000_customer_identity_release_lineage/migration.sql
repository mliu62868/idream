BEGIN;

-- SPEC: v2 placements accept one of three sources: complete Creative lineage,
--       an imported image without generation lineage, or a customer-selected
--       identity preview referencing an immutable revision and its real job.
-- INVARIANT: customer previews never invent Run/Item/review/bootstrap lineage;
--            the existing canonical asset IDs, exact slots, distinct assets
--            and closed key set remain required for persisted manifests.
CREATE OR REPLACE FUNCTION assert_character_release_asset_manifest_v2(
  manifest JSONB
)
RETURNS void AS $$
DECLARE
  placement JSONB;
  slot_version NUMERIC;
  distinct_slot_count INTEGER;
  distinct_asset_count INTEGER;
  lineage_present INTEGER;
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
        placement ?& ARRAY['slotKey', 'assetId', 'slotVersion']::TEXT[]
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
          'customerIdentityRevisionId',
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
      OR (
        placement ? 'reviewDecisionId'
        AND (
          jsonb_typeof(placement->'reviewDecisionId') IS DISTINCT FROM 'string'
          OR NULLIF(
            trim_ecmascript_whitespace(placement->>'reviewDecisionId'),
            ''
          ) IS NULL
        )
      )
      OR (
        placement ? 'customerIdentityRevisionId'
        AND (
          jsonb_typeof(placement->'customerIdentityRevisionId') IS DISTINCT FROM 'string'
          OR NULLIF(
            trim_ecmascript_whitespace(placement->>'customerIdentityRevisionId'),
            ''
          ) IS NULL
        )
      )
      OR (
        placement ? 'bootstrapIdentity'
        AND jsonb_typeof(placement->'bootstrapIdentity')
          IS DISTINCT FROM 'boolean'
      )
    THEN
      RAISE EXCEPTION
        'live public generated Character requires strict v2 Release manifest contract';
    END IF;

    IF placement ? 'customerIdentityRevisionId' THEN
      -- A preview job predates Creative production and identity creation. Its
      -- immutable customer revision is the source, never a fabricated Run.
      IF NOT (placement ? 'generationJobId')
        OR jsonb_typeof(placement->'generationJobId') IS DISTINCT FROM 'string'
        OR NULLIF(
          trim_ecmascript_whitespace(placement->>'generationJobId'),
          ''
        ) IS NULL
        OR placement ?| ARRAY['runId', 'itemId', 'reviewDecisionId']::TEXT[]
        OR placement->'bootstrapIdentity' = 'true'::JSONB
      THEN
        RAISE EXCEPTION
          'live public generated Character requires strict v2 Release manifest contract';
      END IF;
    ELSE
      -- Existing imports carry no generation lineage; Creative placements
      -- still require Run, Item and generation Job together.
      lineage_present := (
        (CASE WHEN placement ? 'runId' THEN 1 ELSE 0 END)
        + (CASE WHEN placement ? 'itemId' THEN 1 ELSE 0 END)
        + (CASE WHEN placement ? 'generationJobId' THEN 1 ELSE 0 END)
      );

      IF lineage_present NOT IN (0, 3) THEN
        RAISE EXCEPTION
          'live public generated Character requires strict v2 Release manifest contract';
      END IF;

      IF lineage_present = 3 AND (
          jsonb_typeof(placement->'runId') IS DISTINCT FROM 'string'
          OR NULLIF(
            trim_ecmascript_whitespace(placement->>'runId'),
            ''
          ) IS NULL
          OR jsonb_typeof(placement->'itemId') IS DISTINCT FROM 'string'
          OR NULLIF(
            trim_ecmascript_whitespace(placement->>'itemId'),
            ''
          ) IS NULL
          OR jsonb_typeof(placement->'generationJobId') IS DISTINCT FROM 'string'
          OR NULLIF(
            trim_ecmascript_whitespace(placement->>'generationJobId'),
            ''
          ) IS NULL
        )
      THEN
        RAISE EXCEPTION
          'live public generated Character requires strict v2 Release manifest contract';
      END IF;
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

COMMIT;
