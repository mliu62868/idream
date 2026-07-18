BEGIN;

-- A generated public qualification must pin the same complete authority shape
-- consumed by the release executor and Admin response contract. SchemaVersion
-- alone is not sufficient: without an exact policy and nested required route,
-- a row could be qualified by the database and then fail at the response
-- boundary.
CREATE FUNCTION enforce_generated_public_qualification_policy_route_authority()
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

  required_route :=
    pinned_release."generationProvenance"->'requiredReleaseRoute';

  IF NOT FOUND
    OR pinned_release.legacy
    OR pinned_release."generationProvenance"->>'schemaVersion'
      IS DISTINCT FROM 'character-release-generation-provenance-v2'
    OR pinned_release."generationProvenance"->>'policyVersion'
      IS DISTINCT FROM 'character-release-policy-v2'
    OR jsonb_typeof(required_route) IS DISTINCT FROM 'object'
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

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER
  public_catalog_qualification_policy_route_authority
AFTER INSERT ON "public_catalog_qualifications"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION
  enforce_generated_public_qualification_policy_route_authority();

COMMIT;
