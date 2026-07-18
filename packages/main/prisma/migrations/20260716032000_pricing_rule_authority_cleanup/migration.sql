-- Seed runs historically could reactivate the default rule after an operator
-- had published a replacement. Keep the newest effective authority per mode
-- and archive every duplicate before runtime starts failing closed on ambiguity.
UPDATE "pricing_rules"
SET "effectiveFrom" = COALESCE("effectiveFrom", "publishedAt", "createdAt")
WHERE "status" = 'active'
  AND "effectiveFrom" IS NULL;

-- Scheduled pricing is not a supported runtime state: publishing is immediate.
-- Archive future-dated active rows so they cannot silently charge early.
UPDATE "pricing_rules"
SET
  "status" = 'archived',
  "archivedAt" = COALESCE("archivedAt", CURRENT_TIMESTAMP)
WHERE "status" = 'active'
  AND "effectiveFrom" > CURRENT_TIMESTAMP;

WITH ranked_active_rules AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "mode"
      ORDER BY
        "effectiveFrom" DESC NULLS LAST,
        "publishedAt" DESC NULLS LAST,
        "version" DESC,
        "createdAt" DESC,
        "id" DESC
    ) AS authority_rank
  FROM "pricing_rules"
  WHERE "status" = 'active'
)
UPDATE "pricing_rules" rules
SET
  "status" = 'archived',
  "archivedAt" = COALESCE(rules."archivedAt", CURRENT_TIMESTAMP)
FROM ranked_active_rules ranked
WHERE rules."id" = ranked."id"
  AND ranked.authority_rank > 1;

-- Runtime and admin publishing both require exactly one active authority per
-- mode. The partial unique index closes the concurrent-publish race at the DB.
CREATE UNIQUE INDEX IF NOT EXISTS "pricing_rules_one_active_per_mode_key"
  ON "pricing_rules"("mode")
  WHERE "status" = 'active';
