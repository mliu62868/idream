BEGIN;

-- Runtime serving requires physical bytes authority, not merely a non-empty
-- display URL. Keep the already-deployed asset-pack migration immutable and
-- add this forward-only check to the same transaction-final wrapper.
CREATE FUNCTION assert_live_public_character_blob_authority_v2(
  checked_character_id TEXT
)
RETURNS void AS $$
DECLARE
  character_row RECORD;
  serving_row RECORD;
  release_row RECORD;
  invalid_blob_count INTEGER;
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

  IF NOT FOUND OR release_row.legacy THEN
    RETURN;
  END IF;

  SELECT count(*)::integer
  INTO invalid_blob_count
  FROM jsonb_array_elements(
    CASE
      WHEN jsonb_typeof(
        release_row."releasePlacementManifest"->'placements'
      ) = 'array'
      THEN release_row."releasePlacementManifest"->'placements'
      ELSE '[]'::jsonb
    END
  ) AS placement
  LEFT JOIN "media_assets" asset
    ON asset.id = placement->>'assetId'
  WHERE placement->>'slotKey' IN (
      'character_avatar',
      'character_hero',
      'character_chat'
    )
    AND (
      asset.id IS NULL
      OR NOT (
        NULLIF(BTRIM(asset."storageKey"), '') IS NOT NULL
        OR BTRIM(asset.url) ~* '^https?://'
        OR (
          asset.metadata#>>'{blobLocator,schemaVersion}'
            = 'media-asset-blob-locator-v1'
          AND asset.metadata#>>'{blobLocator,kind}'
            = 'shared_immutable'
          AND NULLIF(
            BTRIM(asset.metadata#>>'{blobLocator,key}'),
            ''
          ) IS NOT NULL
          AND NULLIF(
            BTRIM(asset.metadata#>>'{blobLocator,sourceAssetId}'),
            ''
          ) IS NOT NULL
          AND asset.metadata#>>'{duplicateLineage,sourceAssetId}'
            IS NOT DISTINCT FROM
              asset.metadata#>>'{blobLocator,sourceAssetId}'
        )
      )
    );

  IF invalid_blob_count <> 0 THEN
    RAISE EXCEPTION
      'live public generated Character requires three exact hydratable Character assets';
  END IF;
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
  PERFORM assert_live_public_character_asset_pack_v2(
    checked_character_id
  );
  PERFORM assert_live_public_character_blob_authority_v2(
    checked_character_id
  );
END;
$$ LANGUAGE plpgsql;

DO $validate_existing_live_public_blob_authority$
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
$validate_existing_live_public_blob_authority$;

COMMIT;
