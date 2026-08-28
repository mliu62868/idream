BEGIN;

-- SPEC: Dark Beast FLUX.2 Klein 9B is no longer an executable iDream model.
-- INTENT: Archive its profiles instead of deleting them so historical Jobs and
-- Attempts keep their pinned profile evidence.
LOCK TABLE "generation_model_profiles" IN SHARE ROW EXCLUSIVE MODE;

UPDATE "generation_model_profiles"
SET
  "enabled" = false,
  "rolloutPercent" = 0,
  "status" = 'archived',
  "archivedAt" = COALESCE("archivedAt", CURRENT_TIMESTAMP),
  "updatedAt" = CURRENT_TIMESTAMP
WHERE
  "id" IN (
    'seed-profile-sdcpp-darkbeast-krea2-img2img-v1',
    'seed-profile-darkbeast-user-image-edit-v1'
  )
  OR "profileKey" IN (
    'darkbeast-flux2-klein-bfs-comparison',
    'character-image-variation-darkbeast'
  )
  OR "pipelineModel" = 'darkbeast-flux2-klein-9b-bfs'
  OR "workflowKey" = 'darkbeast-flux2-klein-9b-multi-reference';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "generation_model_profiles"
    WHERE (
      "id" IN (
        'seed-profile-sdcpp-darkbeast-krea2-img2img-v1',
        'seed-profile-darkbeast-user-image-edit-v1'
      )
      OR "profileKey" IN (
        'darkbeast-flux2-klein-bfs-comparison',
        'character-image-variation-darkbeast'
      )
      OR "pipelineModel" = 'darkbeast-flux2-klein-9b-bfs'
      OR "workflowKey" = 'darkbeast-flux2-klein-9b-multi-reference'
    )
    AND (
      "enabled" <> false
      OR "rolloutPercent" <> 0
      OR "status" <> 'archived'
      OR "archivedAt" IS NULL
    )
  ) THEN
    RAISE EXCEPTION 'Dark Beast FLUX.2 Klein 9B profile remains executable';
  END IF;
END
$$;

COMMIT;
