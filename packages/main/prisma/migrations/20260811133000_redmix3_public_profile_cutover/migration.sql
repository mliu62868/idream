BEGIN;

-- SPEC: retire the broken Premium v1 route by publishing a new v2. Never
-- rewrite v1: completed Jobs and Attempts immutably pin profile version 1.
LOCK TABLE "generation_model_profiles" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  premium_total_count integer;
  active_premium_count integer;
  version_one_count integer;
  version_two_count integer;
  legacy_id_count integer;
  legacy_active_count integer;
  legacy_archived_count integer;
  fresh_canonical_count integer;
  replacement_count integer;
  replacement_id_count integer;
  source_count integer;
BEGIN
  SELECT count(*) INTO premium_total_count
  FROM "generation_model_profiles"
  WHERE "profileKey" = 'profile_image_premium_v1';

  SELECT count(*) INTO active_premium_count
  FROM "generation_model_profiles"
  WHERE "profileKey" = 'profile_image_premium_v1'
    AND "status" = 'active';

  SELECT count(*) INTO version_one_count
  FROM "generation_model_profiles"
  WHERE "profileKey" = 'profile_image_premium_v1'
    AND "version" = 1;

  SELECT count(*) INTO version_two_count
  FROM "generation_model_profiles"
  WHERE "profileKey" = 'profile_image_premium_v1'
    AND "version" = 2;

  SELECT count(*) INTO legacy_id_count
  FROM "generation_model_profiles"
  WHERE "id" = 'seed-profile-image-premium-v1';

  SELECT count(*) INTO legacy_active_count
  FROM "generation_model_profiles"
  WHERE "id" = 'seed-profile-image-premium-v1'
    AND "profileKey" = 'profile_image_premium_v1'
    AND "version" = 1
    AND "mode" = 'image'
    AND "runner" = 'comfyui'
    AND "pipelineModel" = 'redcraft-krea2-comfyui'
    AND "workflowKey" = 'redcraft-krea2-txt2img'
    AND "status" = 'active'
    AND "archivedAt" IS NULL
    AND "enabled" = true
    AND "rolloutPercent" = 100
    AND "requiredEntitlement" = 'premium_models';

  SELECT count(*) INTO legacy_archived_count
  FROM "generation_model_profiles"
  WHERE "id" = 'seed-profile-image-premium-v1'
    AND "profileKey" = 'profile_image_premium_v1'
    AND "version" = 1
    AND "mode" = 'image'
    AND "runner" = 'comfyui'
    AND "pipelineModel" = 'redcraft-krea2-comfyui'
    AND "workflowKey" = 'redcraft-krea2-txt2img'
    AND "status" = 'archived'
    AND "archivedAt" IS NOT NULL
    AND "enabled" = true
    AND "rolloutPercent" = 100
    AND "requiredEntitlement" = 'premium_models';

  SELECT count(*) INTO fresh_canonical_count
  FROM "generation_model_profiles"
  WHERE "id" = 'seed-profile-image-premium-v1'
    AND "profileKey" = 'profile_image_premium_v1'
    AND "version" = 1
    AND "mode" = 'image'
    AND "status" = 'active'
    AND "publishedAt" IS NOT NULL
    AND "archivedAt" IS NULL
    AND "enabled" = true
    AND "rolloutPercent" = 100
    AND "requiredEntitlement" = 'premium_models'
    AND "runner" = 'comfyui'
    AND "pipelineModel" = 'redcraft-krea2-redmix3-fp8'
    AND "workflowKey" = 'redcraft-krea2-redmix3-txt2img'
    AND "sourceModelPath" IS NOT NULL
    AND "modelFormat" = 'safetensors'
    AND "runnerConfig" IS NOT NULL
    AND "runnerConfig" ->> 'apiModelId' = 'redcraft-krea2-redmix3-fp8'
    AND (
      "runnerConfig" ->> 'modelPath' = "sourceModelPath"
      OR "runnerConfig" ->> 'diffusionModelPath' = "sourceModelPath"
    )
    AND "runnerConfig" #>> '{capabilities,textToImage}' = 'true'
    AND (
      "runnerConfig" ->> 'workflowPath' = 'redcraft-krea2-redmix3-txt2img.json'
      OR "runnerConfig" ->> 'workflowPath' LIKE '%/redcraft-krea2-redmix3-txt2img.json'
    );

  SELECT count(*) INTO replacement_count
  FROM "generation_model_profiles"
  WHERE "id" = 'seed-profile-image-premium-v2'
    AND "profileKey" = 'profile_image_premium_v1'
    AND "version" = 2
    AND "status" = 'active'
    AND "publishedAt" IS NOT NULL
    AND "archivedAt" IS NULL
    AND "mode" = 'image'
    AND "enabled" = true
    AND "rolloutPercent" = 100
    AND "requiredEntitlement" = 'premium_models'
    AND "runner" = 'comfyui'
    AND "pipelineModel" = 'redcraft-krea2-redmix3-fp8'
    AND "workflowKey" = 'redcraft-krea2-redmix3-txt2img'
    AND "sourceModelPath" IS NOT NULL
    AND "modelFormat" = 'safetensors'
    AND "runnerConfig" IS NOT NULL
    AND "runnerConfig" ->> 'apiModelId' = 'redcraft-krea2-redmix3-fp8'
    AND (
      "runnerConfig" ->> 'modelPath' = "sourceModelPath"
      OR "runnerConfig" ->> 'diffusionModelPath' = "sourceModelPath"
    )
    AND "runnerConfig" #>> '{capabilities,textToImage}' = 'true'
    AND (
      "runnerConfig" ->> 'workflowPath' = 'redcraft-krea2-redmix3-txt2img.json'
      OR "runnerConfig" ->> 'workflowPath' LIKE '%/redcraft-krea2-redmix3-txt2img.json'
    );

  SELECT count(*) INTO replacement_id_count
  FROM "generation_model_profiles"
  WHERE "id" = 'seed-profile-image-premium-v2';

  IF premium_total_count = 0 THEN
    IF legacy_id_count = 0 AND replacement_id_count = 0 THEN
      RETURN;
    END IF;
    RAISE EXCEPTION 'Reserved Premium profile id collides with another profile';
  END IF;

  IF premium_total_count = 1
    AND active_premium_count = 1
    AND version_one_count = 1
    AND version_two_count = 0
    AND legacy_id_count = 1
    AND replacement_id_count = 0
    AND fresh_canonical_count = 1
  THEN
    RETURN;
  END IF;

  IF premium_total_count = 2
    AND active_premium_count = 1
    AND version_one_count = 1
    AND version_two_count = 1
    AND legacy_id_count = 1
    AND replacement_id_count = 1
    AND legacy_archived_count = 1
    AND replacement_count = 1
  THEN
    RETURN;
  END IF;

  IF NOT (
    premium_total_count = 1
    AND active_premium_count = 1
    AND version_one_count = 1
    AND version_two_count = 0
    AND legacy_id_count = 1
    AND replacement_id_count = 0
    AND legacy_active_count = 1
  ) AND NOT (
    premium_total_count = 2
    AND active_premium_count = 2
    AND version_one_count = 1
    AND version_two_count = 1
    AND legacy_id_count = 1
    AND replacement_id_count = 1
    AND legacy_active_count = 1
    AND replacement_count = 1
  ) THEN
    RAISE EXCEPTION 'Premium image profile state is not an exact supported RedMix3 cutover state';
  END IF;

  -- A previously inserted exact v2 already carries the canonical execution
  -- fields. The remaining recovery action is only to archive legacy v1.
  IF premium_total_count = 2
    AND active_premium_count = 2
    AND version_one_count = 1
    AND version_two_count = 1
    AND legacy_id_count = 1
    AND replacement_id_count = 1
    AND legacy_active_count = 1
    AND replacement_count = 1
  THEN
    RETURN;
  END IF;

  SELECT count(*) INTO source_count
  FROM "generation_model_profiles"
  WHERE "profileKey" = 'profile_image_default_v1'
    AND "status" = 'active'
    AND "publishedAt" IS NOT NULL
    AND "archivedAt" IS NULL
    AND "mode" = 'image'
    AND "enabled" = true
    AND "rolloutPercent" = 100
    AND "requiredEntitlement" IS NULL
    AND "runner" = 'comfyui'
    AND "pipelineModel" = 'redcraft-krea2-redmix3-fp8'
    AND "workflowKey" = 'redcraft-krea2-redmix3-txt2img'
    AND "sourceModelPath" IS NOT NULL
    AND "modelFormat" = 'safetensors'
    AND "runnerConfig" IS NOT NULL
    AND "runnerConfig" ->> 'apiModelId' = 'redcraft-krea2-redmix3-fp8'
    AND (
      "runnerConfig" ->> 'modelPath' = "sourceModelPath"
      OR "runnerConfig" ->> 'diffusionModelPath' = "sourceModelPath"
    )
    AND "runnerConfig" #>> '{capabilities,textToImage}' = 'true'
    AND (
      "runnerConfig" ->> 'workflowPath' = 'redcraft-krea2-redmix3-txt2img.json'
      OR "runnerConfig" ->> 'workflowPath' LIKE '%/redcraft-krea2-redmix3-txt2img.json'
    );
  IF source_count <> 1 THEN
    RAISE EXCEPTION
      'Premium RedMix3 cutover requires exactly one active canonical Default execution profile';
  END IF;
END
$$;

INSERT INTO "generation_model_profiles" (
  "id",
  "profileKey",
  "label",
  "mode",
  "runner",
  "pipelineModel",
  "workflowKey",
  "sourceModelPath",
  "convertedModelPath",
  "modelFormat",
  "runnerConfig",
  "defaultWidth",
  "defaultHeight",
  "allowedOrientations",
  "steps",
  "sampler",
  "scheduler",
  "cfgScale",
  "costMultiplier",
  "requiredEntitlement",
  "maxCount",
  "concurrencyLimit",
  "enabled",
  "rolloutPercent",
  "version",
  "status",
  "dryRunSummary",
  "publishedAt",
  "archivedAt",
  "createdAt",
  "updatedAt"
)
SELECT
  'seed-profile-image-premium-v2',
  legacy."profileKey",
  legacy."label",
  legacy."mode",
  source."runner",
  source."pipelineModel",
  source."workflowKey",
  source."sourceModelPath",
  source."convertedModelPath",
  source."modelFormat",
  source."runnerConfig",
  legacy."defaultWidth",
  legacy."defaultHeight",
  legacy."allowedOrientations",
  legacy."steps",
  legacy."sampler",
  legacy."scheduler",
  legacy."cfgScale",
  legacy."costMultiplier",
  legacy."requiredEntitlement",
  legacy."maxCount",
  legacy."concurrencyLimit",
  legacy."enabled",
  legacy."rolloutPercent",
  2,
  'active',
  jsonb_build_object(
    'status', 'configuration_cutover_requires_live_probe',
    'source', '20260811133000_redmix3_public_profile_cutover',
    'legacyProfileId', legacy."id",
    'executionProfileId', source."id"
  ),
  CURRENT_TIMESTAMP,
  NULL,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "generation_model_profiles" AS legacy
CROSS JOIN "generation_model_profiles" AS source
WHERE legacy."id" = 'seed-profile-image-premium-v1'
  AND legacy."profileKey" = 'profile_image_premium_v1'
  AND legacy."version" = 1
  AND legacy."status" = 'active'
  AND legacy."archivedAt" IS NULL
  AND legacy."enabled" = true
  AND legacy."rolloutPercent" = 100
  AND legacy."requiredEntitlement" = 'premium_models'
  AND legacy."runner" = 'comfyui'
  AND legacy."pipelineModel" = 'redcraft-krea2-comfyui'
  AND legacy."workflowKey" = 'redcraft-krea2-txt2img'
  AND source."profileKey" = 'profile_image_default_v1'
  AND source."status" = 'active'
  AND source."publishedAt" IS NOT NULL
  AND source."archivedAt" IS NULL
  AND source."mode" = 'image'
  AND source."enabled" = true
  AND source."rolloutPercent" = 100
  AND source."requiredEntitlement" IS NULL
  AND source."runner" = 'comfyui'
  AND source."pipelineModel" = 'redcraft-krea2-redmix3-fp8'
  AND source."workflowKey" = 'redcraft-krea2-redmix3-txt2img'
  AND source."sourceModelPath" IS NOT NULL
  AND source."modelFormat" = 'safetensors'
  AND source."runnerConfig" IS NOT NULL
  AND source."runnerConfig" ->> 'apiModelId' = 'redcraft-krea2-redmix3-fp8'
  AND (
    source."runnerConfig" ->> 'modelPath' = source."sourceModelPath"
    OR source."runnerConfig" ->> 'diffusionModelPath' = source."sourceModelPath"
  )
  AND source."runnerConfig" #>> '{capabilities,textToImage}' = 'true'
  AND (
    source."runnerConfig" ->> 'workflowPath' = 'redcraft-krea2-redmix3-txt2img.json'
    OR source."runnerConfig" ->> 'workflowPath' LIKE '%/redcraft-krea2-redmix3-txt2img.json'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "generation_model_profiles" AS replacement
    WHERE replacement."id" = 'seed-profile-image-premium-v2'
      AND replacement."status" = 'active'
  );

-- Archive through the same state transition used by Admin publish. The old
-- execution fields and version remain intact for historical Attempt pins.
UPDATE "generation_model_profiles" AS legacy
SET
  "status" = 'archived',
  "archivedAt" = CURRENT_TIMESTAMP,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE legacy."id" = 'seed-profile-image-premium-v1'
  AND legacy."profileKey" = 'profile_image_premium_v1'
  AND legacy."version" = 1
  AND legacy."status" = 'active'
  AND legacy."archivedAt" IS NULL
  AND legacy."mode" = 'image'
  AND legacy."runner" = 'comfyui'
  AND legacy."pipelineModel" = 'redcraft-krea2-comfyui'
  AND legacy."workflowKey" = 'redcraft-krea2-txt2img'
  AND legacy."enabled" = true
  AND legacy."rolloutPercent" = 100
  AND legacy."requiredEntitlement" = 'premium_models'
  AND EXISTS (
    SELECT 1
    FROM "generation_model_profiles" AS replacement
    WHERE replacement."id" = 'seed-profile-image-premium-v2'
      AND replacement."profileKey" = legacy."profileKey"
      AND replacement."version" = 2
      AND replacement."status" = 'active'
      AND replacement."publishedAt" IS NOT NULL
      AND replacement."archivedAt" IS NULL
      AND replacement."mode" = 'image'
      AND replacement."enabled" = true
      AND replacement."rolloutPercent" = 100
      AND replacement."requiredEntitlement" = 'premium_models'
      AND replacement."runner" = 'comfyui'
      AND replacement."pipelineModel" = 'redcraft-krea2-redmix3-fp8'
      AND replacement."workflowKey" = 'redcraft-krea2-redmix3-txt2img'
      AND replacement."sourceModelPath" IS NOT NULL
      AND replacement."modelFormat" = 'safetensors'
      AND replacement."runnerConfig" IS NOT NULL
      AND replacement."runnerConfig" ->> 'apiModelId' = 'redcraft-krea2-redmix3-fp8'
      AND (
        replacement."runnerConfig" ->> 'modelPath' = replacement."sourceModelPath"
        OR replacement."runnerConfig" ->> 'diffusionModelPath' = replacement."sourceModelPath"
      )
      AND replacement."runnerConfig" #>> '{capabilities,textToImage}' = 'true'
      AND (
        replacement."runnerConfig" ->> 'workflowPath' = 'redcraft-krea2-redmix3-txt2img.json'
        OR replacement."runnerConfig" ->> 'workflowPath' LIKE '%/redcraft-krea2-redmix3-txt2img.json'
      )
  );

-- INVARIANT: leave either a genuinely fresh database, one canonical fresh-seed
-- v1, or one archived legacy v1 plus exactly one executable Premium v2.
DO $$
DECLARE
  premium_total_count integer;
  active_premium_count integer;
  version_one_count integer;
  version_two_count integer;
  legacy_id_count integer;
  replacement_id_count integer;
  fresh_canonical_count integer;
  legacy_archived_count integer;
  replacement_count integer;
BEGIN
  SELECT count(*) INTO premium_total_count
  FROM "generation_model_profiles"
  WHERE "profileKey" = 'profile_image_premium_v1';

  SELECT count(*) INTO active_premium_count
  FROM "generation_model_profiles"
  WHERE "profileKey" = 'profile_image_premium_v1'
    AND "status" = 'active';

  SELECT count(*) INTO version_one_count
  FROM "generation_model_profiles"
  WHERE "profileKey" = 'profile_image_premium_v1'
    AND "version" = 1;

  SELECT count(*) INTO version_two_count
  FROM "generation_model_profiles"
  WHERE "profileKey" = 'profile_image_premium_v1'
    AND "version" = 2;

  SELECT count(*) INTO legacy_id_count
  FROM "generation_model_profiles"
  WHERE "id" = 'seed-profile-image-premium-v1';

  SELECT count(*) INTO replacement_id_count
  FROM "generation_model_profiles"
  WHERE "id" = 'seed-profile-image-premium-v2';

  SELECT count(*) INTO fresh_canonical_count
  FROM "generation_model_profiles"
  WHERE "id" = 'seed-profile-image-premium-v1'
    AND "profileKey" = 'profile_image_premium_v1'
    AND "version" = 1
    AND "mode" = 'image'
    AND "status" = 'active'
    AND "publishedAt" IS NOT NULL
    AND "archivedAt" IS NULL
    AND "enabled" = true
    AND "rolloutPercent" = 100
    AND "requiredEntitlement" = 'premium_models'
    AND "runner" = 'comfyui'
    AND "pipelineModel" = 'redcraft-krea2-redmix3-fp8'
    AND "workflowKey" = 'redcraft-krea2-redmix3-txt2img'
    AND "sourceModelPath" IS NOT NULL
    AND "modelFormat" = 'safetensors'
    AND "runnerConfig" IS NOT NULL
    AND "runnerConfig" ->> 'apiModelId' = 'redcraft-krea2-redmix3-fp8'
    AND (
      "runnerConfig" ->> 'modelPath' = "sourceModelPath"
      OR "runnerConfig" ->> 'diffusionModelPath' = "sourceModelPath"
    )
    AND "runnerConfig" #>> '{capabilities,textToImage}' = 'true'
    AND (
      "runnerConfig" ->> 'workflowPath' = 'redcraft-krea2-redmix3-txt2img.json'
      OR "runnerConfig" ->> 'workflowPath' LIKE '%/redcraft-krea2-redmix3-txt2img.json'
    );

  SELECT count(*) INTO legacy_archived_count
  FROM "generation_model_profiles"
  WHERE "id" = 'seed-profile-image-premium-v1'
    AND "profileKey" = 'profile_image_premium_v1'
    AND "version" = 1
    AND "mode" = 'image'
    AND "runner" = 'comfyui'
    AND "pipelineModel" = 'redcraft-krea2-comfyui'
    AND "workflowKey" = 'redcraft-krea2-txt2img'
    AND "status" = 'archived'
    AND "archivedAt" IS NOT NULL
    AND "enabled" = true
    AND "rolloutPercent" = 100
    AND "requiredEntitlement" = 'premium_models';

  SELECT count(*) INTO replacement_count
  FROM "generation_model_profiles"
  WHERE "id" = 'seed-profile-image-premium-v2'
    AND "profileKey" = 'profile_image_premium_v1'
    AND "version" = 2
    AND "mode" = 'image'
    AND "status" = 'active'
    AND "publishedAt" IS NOT NULL
    AND "archivedAt" IS NULL
    AND "enabled" = true
    AND "rolloutPercent" = 100
    AND "requiredEntitlement" = 'premium_models'
    AND "runner" = 'comfyui'
    AND "pipelineModel" = 'redcraft-krea2-redmix3-fp8'
    AND "workflowKey" = 'redcraft-krea2-redmix3-txt2img'
    AND "sourceModelPath" IS NOT NULL
    AND "modelFormat" = 'safetensors'
    AND "runnerConfig" IS NOT NULL
    AND "runnerConfig" ->> 'apiModelId' = 'redcraft-krea2-redmix3-fp8'
    AND (
      "runnerConfig" ->> 'modelPath' = "sourceModelPath"
      OR "runnerConfig" ->> 'diffusionModelPath' = "sourceModelPath"
    )
    AND "runnerConfig" #>> '{capabilities,textToImage}' = 'true'
    AND (
      "runnerConfig" ->> 'workflowPath' = 'redcraft-krea2-redmix3-txt2img.json'
      OR "runnerConfig" ->> 'workflowPath' LIKE '%/redcraft-krea2-redmix3-txt2img.json'
    );

  IF premium_total_count = 0
    AND legacy_id_count = 0
    AND replacement_id_count = 0
  THEN
    RETURN;
  END IF;

  IF premium_total_count = 1
    AND active_premium_count = 1
    AND version_one_count = 1
    AND version_two_count = 0
    AND legacy_id_count = 1
    AND replacement_id_count = 0
    AND fresh_canonical_count = 1
  THEN
    RETURN;
  END IF;

  IF premium_total_count = 2
    AND active_premium_count = 1
    AND version_one_count = 1
    AND version_two_count = 1
    AND legacy_id_count = 1
    AND replacement_id_count = 1
    AND legacy_archived_count = 1
    AND replacement_count = 1
  THEN
    RETURN;
  END IF;

  RAISE EXCEPTION 'Premium RedMix3 cutover postcondition failed';
END
$$;

COMMIT;
