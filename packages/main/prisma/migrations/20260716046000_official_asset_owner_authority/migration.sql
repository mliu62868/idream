-- Preserve official cold-start assets while moving ownership away from
-- reference attribution handles that were incorrectly modeled as customers.
DO $official_owner_preflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "characters" character
    WHERE character.source = 'official'
      AND character."creatorId" IS NULL
  ) THEN
    RAISE EXCEPTION
      'official ownership migration requires every official Character to have an explicit current owner';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "characters" character
    JOIN "users" owner ON owner.id = character."creatorId"
    WHERE character.source = 'official'
      AND owner."dataClass" = 'customer'
  ) THEN
    RAISE EXCEPTION
      'customer-owned official Characters require an explicit provenance decision before migration';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "characters" character
    JOIN "users" owner ON owner.id = character."creatorId"
    WHERE character.source = 'official'
      AND character."creatorId" <> 'seed-system-creator'
      AND owner."dataClass" <> 'customer'
      AND (
        jsonb_typeof(character."advancedDetails") IS DISTINCT FROM 'object'
        OR (
          character."advancedDetails" ? 'provenance'
          AND jsonb_typeof(character."advancedDetails"->'provenance')
            IS DISTINCT FROM 'object'
        )
      )
  ) THEN
    RAISE EXCEPTION
      'official Character provenance must be a JSON object before ownership migration';
  END IF;
END;
$official_owner_preflight$;

INSERT INTO "users" (
  "id",
  "email",
  "emailVerified",
  "displayName",
  "role",
  "status",
  "dataClass",
  "createdAt",
  "updatedAt"
)
VALUES (
  'seed-system-creator',
  'system@idream.local',
  true,
  'Official',
  'admin',
  'active',
  'internal',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("id") DO UPDATE
SET
  "displayName" = 'Official',
  "role" = 'admin',
  "status" = 'active',
  "dataClass" = 'internal',
  "deletedAt" = NULL,
  "updatedAt" = CURRENT_TIMESTAMP;

UPDATE "characters" AS character
SET
  "creatorId" = 'seed-system-creator',
  "advancedDetails" = jsonb_set(
    COALESCE(character."advancedDetails", '{}'::jsonb),
    '{provenance}',
    COALESCE(character."advancedDetails"->'provenance', '{}'::jsonb)
      || jsonb_build_object(
        'originalCreator',
        COALESCE(
          character."advancedDetails"->'provenance'->>'originalCreator',
          owner."displayName",
          owner."name",
          owner."id"
        ),
        'legacyCreatorId',
        COALESCE(
          character."advancedDetails"->'provenance'->>'legacyCreatorId',
          owner."id"
        ),
        'ownership',
        'platform_official'
      ),
    true
  ),
  "updatedAt" = CURRENT_TIMESTAMP
FROM "users" AS owner
WHERE
  character."source" = 'official'
  AND character."creatorId" = owner."id"
  AND character."creatorId" <> 'seed-system-creator'
  AND owner."dataClass" <> 'customer';

UPDATE "media_assets"
SET
  "ownerId" = 'seed-system-creator',
  "metadata" = COALESCE("metadata", '{}'::jsonb)
    || jsonb_build_object(
      'originalOwnerId',
      COALESCE("metadata"->>'originalOwnerId', "ownerId"),
      'ownership',
      'platform_official'
    )
WHERE "metadata"->>'seedSource' = 'src/lib/official-cold-start-content.ts'
  AND "ownerId" <> 'seed-system-creator';

UPDATE "media_collections"
SET
  "ownerId" = 'seed-system-creator',
  "source" = 'official'
WHERE "source" = 'official'
  AND "ownerId" <> 'seed-system-creator';
