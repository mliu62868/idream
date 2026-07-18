BEGIN;

-- Public qualification depends on the final Release, Character avatar, and
-- validation rows written by one publication transaction. A statement-time
-- BEFORE trigger made that atomic transaction order-sensitive and rejected a
-- valid first publish or avatar replacement before the Character projection
-- statement ran. Preserve the existing authority function (including
-- immutable fields and one-way revocation), but evaluate its cross-row
-- invariant against the transaction's final state.
DROP TRIGGER IF EXISTS public_catalog_qualification_authority
  ON "public_catalog_qualifications";

CREATE OR REPLACE FUNCTION enforce_public_catalog_qualification_authority()
RETURNS trigger AS $$
DECLARE
  pinned_release "character_releases"%ROWTYPE;
  pinned_validation "release_validation_runs"%ROWTYPE;
  release_character_id TEXT;
  projected_character_asset_id TEXT;
  manifest_avatar_asset_id TEXT;
  avatar_placement_count INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'public catalog qualification cannot be deleted; revoke it instead';
  END IF;

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
      RAISE EXCEPTION
        'public catalog qualification is immutable except for one-way revocation';
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
    RAISE EXCEPTION
      'public catalog qualification requires an exact published Release';
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
      WHEN jsonb_typeof(
        pinned_release."releasePlacementManifest"->'placements'
      ) = 'array'
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
    RAISE EXCEPTION
      'public catalog qualification requires the exact Character avatar projection';
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
      RAISE EXCEPTION
        'generated public qualification requires current strict validation evidence';
    END IF;
  ELSE
    IF NOT pinned_release.legacy
      OR pinned_release."generationProvenance"->>'schemaVersion'
        <> 'character-release-editorial-import-v1'
      OR NEW.evidence->>'policyVersion'
        <> 'public-catalog-editorial-import-v1'
    THEN
      RAISE EXCEPTION
        'editorial public qualification requires explicit import provenance';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER public_catalog_qualification_authority
AFTER INSERT OR UPDATE OR DELETE ON "public_catalog_qualifications"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_public_catalog_qualification_authority();

-- Defense in depth: if the qualification-specific delete guard is ever
-- changed, deleting the row must still re-evaluate the affected live/public
-- Character from OLD.releaseId at transaction commit.
CREATE OR REPLACE FUNCTION enforce_live_public_qualification_delete_v2()
RETURNS trigger AS $$
DECLARE
  checked_character_id TEXT;
BEGIN
  SELECT projects."characterId"
  INTO checked_character_id
  FROM "character_releases" releases
  JOIN "character_projects" projects
    ON projects.id = releases."projectId"
  WHERE releases.id = OLD."releaseId";

  PERFORM assert_live_public_character_authority_v2(
    checked_character_id
  );
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS live_public_authority_v2_from_qualification_delete
  ON "public_catalog_qualifications";

CREATE CONSTRAINT TRIGGER live_public_authority_v2_from_qualification_delete
AFTER DELETE ON "public_catalog_qualifications"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_live_public_qualification_delete_v2();

COMMIT;
