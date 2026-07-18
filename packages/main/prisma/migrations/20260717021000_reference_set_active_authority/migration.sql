-- A Visual Identity has one generation Reference Set authority at a time.
-- Repair historical ambiguity deterministically before enforcing it in the DB.
WITH ranked_active_reference_sets AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "visualProfileId"
      ORDER BY
        "revision" DESC,
        "createdAt" DESC,
        "id" DESC
    ) AS authority_rank
  FROM "reference_set_revisions"
  WHERE "status" = 'active'
)
UPDATE "reference_set_revisions" revisions
SET "status" = 'superseded'
FROM ranked_active_reference_sets ranked
WHERE revisions."id" = ranked."id"
  AND ranked.authority_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS "reference_set_revisions_one_active_per_visual_profile_key"
  ON "reference_set_revisions"("visualProfileId")
  WHERE "status" = 'active';
