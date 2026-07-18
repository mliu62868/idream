BEGIN;

-- Keep the established live/public sum-type checks as the core authority, then
-- extend their common transaction-final entrypoint with the complete generated
-- Release asset pack. Existing deferred triggers on Character, Serving,
-- Release, Qualification, and MediaAsset continue to call the public wrapper,
-- so changing any one of the three live assets revalidates the whole pack at
-- COMMIT without adding a second trigger graph.
ALTER FUNCTION assert_live_public_character_authority_v2(TEXT)
  RENAME TO assert_live_public_character_core_authority_v2;

CREATE FUNCTION assert_live_public_character_asset_pack_v2(
  checked_character_id TEXT
)
RETURNS void AS $$
DECLARE
  character_row RECORD;
  serving_row RECORD;
  release_row RECORD;
  placement_count INTEGER;
  required_slot_count INTEGER;
  distinct_slot_count INTEGER;
  distinct_asset_count INTEGER;
  invalid_asset_count INTEGER;
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

  IF release_row.status <> 'published'
    OR release_row."publishedAt" IS NULL
    OR release_row.readiness <> 'ready'
    OR release_row."generationProvenance"->>'schemaVersion'
      IS DISTINCT FROM 'character-release-generation-provenance-v2'
    OR release_row."generationProvenance"->>'policyVersion'
      IS DISTINCT FROM 'character-release-policy-v2'
    OR release_row."releasePlacementManifest"->>'schemaVersion'
      IS DISTINCT FROM '2'
    OR jsonb_typeof(
      release_row."releasePlacementManifest"->'placements'
    ) IS DISTINCT FROM 'array'
  THEN
    RAISE EXCEPTION
      'live public generated Character requires strict v2 Release asset authority';
  END IF;

  SELECT
    count(*)::integer,
    count(*) FILTER (
      WHERE placement->>'slotKey' IN (
        'character_avatar',
        'character_hero',
        'character_chat'
      )
      AND NULLIF(placement->>'assetId', '') IS NOT NULL
    )::integer,
    count(DISTINCT placement->>'slotKey') FILTER (
      WHERE placement->>'slotKey' IN (
        'character_avatar',
        'character_hero',
        'character_chat'
      )
    )::integer,
    count(DISTINCT placement->>'assetId') FILTER (
      WHERE placement->>'slotKey' IN (
        'character_avatar',
        'character_hero',
        'character_chat'
      )
      AND NULLIF(placement->>'assetId', '') IS NOT NULL
    )::integer
  INTO
    placement_count,
    required_slot_count,
    distinct_slot_count,
    distinct_asset_count
  FROM jsonb_array_elements(
    release_row."releasePlacementManifest"->'placements'
  ) AS placement;

  IF placement_count <> 3
    OR required_slot_count <> 3
    OR distinct_slot_count <> 3
    OR distinct_asset_count <> 3
  THEN
    RAISE EXCEPTION
      'live public generated Character requires one exact distinct avatar hero chat manifest';
  END IF;

  SELECT count(*)::integer
  INTO invalid_asset_count
  FROM jsonb_array_elements(
    release_row."releasePlacementManifest"->'placements'
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
      OR asset."characterId" IS DISTINCT FROM checked_character_id
      OR asset.type <> 'image'
      OR asset."deletedAt" IS NOT NULL
      OR asset.visibility <> 'public_pack'
      OR asset."safetyStatus" <> 'passed'
      OR NULLIF(asset.url, '') IS NULL
      OR COALESCE(asset.metadata->'synthetic', 'null'::jsonb)
        NOT IN ('false'::jsonb, 'null'::jsonb)
      OR LOWER(COALESCE(
        asset.metadata#>>'{platformAsset,status}',
        ''
      )) IN ('archived', 'rejected', 'blocked')
    );

  IF invalid_asset_count <> 0 THEN
    RAISE EXCEPTION
      'live public generated Character requires three exact publishable Character assets';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION assert_live_public_character_authority_v2(
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
END;
$$ LANGUAGE plpgsql;

-- The prior MediaAsset trigger intentionally covered mutable row state, but a
-- hard DELETE could remove a JSON-manifest hero/chat because those ids are not
-- relational foreign keys. Reuse the same deferred wrapper and resolve DELETE
-- authority from OLD.characterId so the row still exists for the statement and
-- the missing pack is rejected at COMMIT.
CREATE OR REPLACE FUNCTION enforce_live_public_character_authority_v2()
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
  ELSIF TG_OP = 'DELETE' THEN
    checked_character_id := OLD."characterId";
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
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER live_public_authority_v2_from_media_asset
  ON "media_assets";

CREATE CONSTRAINT TRIGGER live_public_authority_v2_from_media_asset
AFTER INSERT OR UPDATE OR DELETE ON "media_assets"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_live_public_character_authority_v2();

-- Refuse to deploy over a latent invalid generated pack. Legacy editorial
-- Releases keep their explicit one-asset semantics in the core authority.
DO $validate_existing_live_public_asset_packs$
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
$validate_existing_live_public_asset_packs$;

COMMIT;
