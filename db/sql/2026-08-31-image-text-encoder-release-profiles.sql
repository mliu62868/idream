-- SPEC: Image workflow releases advance the immutable profile and workflow
-- pins together after positive, negative, and reference conditioning finish.
-- INTENT: Existing databases do not rerun create-only seed branches, so this
-- exact-target script is the sole data rollout for the graph lifecycle change.

BEGIN;

UPDATE "generation_model_profiles"
SET
  "runnerConfig" = jsonb_set(
    COALESCE("runnerConfig", '{}'::jsonb),
    '{workflowVersion}',
    '2'::jsonb,
    true
  ),
  "version" = 2,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" IN (
    'seed-profile-image-default-v1',
    'seed-profile-image-premium-v1'
  )
  AND "profileKey" IN (
    'profile_image_default_v1',
    'profile_image_premium_v1'
  )
  AND "workflowKey" = 'redcraft-krea2-redmix3-txt2img'
  AND "version" = 1
  AND "runnerConfig" ->> 'workflowVersion' = '1';

UPDATE "generation_model_profiles"
SET
  "runnerConfig" = jsonb_set(
    COALESCE("runnerConfig", '{}'::jsonb),
    '{workflowVersion}',
    '5'::jsonb,
    true
  ),
  "version" = 5,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" = 'seed-profile-character-image-single-identity-redcraft-v1'
  AND "profileKey" = 'character-image-single-identity-redcraft'
  AND "workflowKey" = 'redcraft-krea2-identity-edit'
  AND "version" = 4
  AND "runnerConfig" ->> 'workflowVersion' = '4';

UPDATE "generation_model_profiles"
SET
  "runnerConfig" = jsonb_set(
    COALESCE("runnerConfig", '{}'::jsonb),
    '{workflowVersion}',
    '2'::jsonb,
    true
  ),
  "version" = 2,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" = 'seed-profile-chat-image-edit-v1'
  AND "profileKey" = 'chat-image-edit'
  AND "workflowKey" = 'qwen-image-edit-img2img'
  AND "version" = 1
  AND (
    "runnerConfig" ->> 'workflowVersion' IS NULL
    OR "runnerConfig" ->> 'workflowVersion' = '1'
  );

UPDATE "generation_model_profiles"
SET
  "runnerConfig" = jsonb_set(
    COALESCE("runnerConfig", '{}'::jsonb),
    '{workflowVersion}',
    '2'::jsonb,
    true
  ),
  "version" = 2,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" = 'seed-profile-character-image-variation-v1'
  AND "profileKey" = 'character-image-variation'
  AND "workflowKey" = 'qwen-image-edit-multi-reference'
  AND "version" = 1
  AND (
    "runnerConfig" ->> 'workflowVersion' IS NULL
    OR "runnerConfig" ->> 'workflowVersion' = '1'
  );

UPDATE "generation_model_profiles"
SET
  "runnerConfig" = jsonb_set(
    COALESCE("runnerConfig", '{}'::jsonb),
    '{workflowVersion}',
    '2'::jsonb,
    true
  ),
  "version" = 2,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" = 'seed-profile-character-image-multi-identity-v1'
  AND "profileKey" = 'character-image-multi-identity'
  AND "workflowKey" = 'qwen-image-edit-multi-identity'
  AND "version" = 1
  AND (
    "runnerConfig" ->> 'workflowVersion' IS NULL
    OR "runnerConfig" ->> 'workflowVersion' = '1'
  );

DO $$
BEGIN
  IF (
    SELECT count(*)
    FROM "generation_model_profiles"
    WHERE "id" IN (
        'seed-profile-image-default-v1',
        'seed-profile-image-premium-v1'
      )
      AND "workflowKey" = 'redcraft-krea2-redmix3-txt2img'
      AND "runnerConfig" ->> 'workflowVersion' = '2'
      AND "version" = 2
      AND "enabled" = true
      AND "status" = 'active'
      AND "rolloutPercent" = 100
  ) <> 2 THEN
    RAISE EXCEPTION 'RedMix3 image profiles did not converge to workflow/profile v2';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "generation_model_profiles"
    WHERE "id" = 'seed-profile-character-image-single-identity-redcraft-v1'
      AND "workflowKey" = 'redcraft-krea2-identity-edit'
      AND "runnerConfig" ->> 'workflowVersion' = '5'
      AND "version" = 5
      AND "enabled" = true
      AND "status" = 'active'
      AND "rolloutPercent" = 100
  ) THEN
    RAISE EXCEPTION 'RedCraft identity profile did not converge to workflow/profile v5';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "generation_model_profiles"
    WHERE "id" = 'seed-profile-chat-image-edit-v1'
      AND "workflowKey" = 'qwen-image-edit-img2img'
      AND "runnerConfig" ->> 'workflowVersion' = '2'
      AND "version" = 2
      AND "enabled" = true
      AND "status" = 'active'
      AND "rolloutPercent" = 100
  ) OR NOT EXISTS (
    SELECT 1
    FROM "generation_model_profiles"
    WHERE "id" = 'seed-profile-character-image-variation-v1'
      AND "workflowKey" = 'qwen-image-edit-multi-reference'
      AND "runnerConfig" ->> 'workflowVersion' = '2'
      AND "version" = 2
      AND "enabled" = true
      AND "status" = 'active'
      AND "rolloutPercent" = 100
  ) OR NOT EXISTS (
    SELECT 1
    FROM "generation_model_profiles"
    WHERE "id" = 'seed-profile-character-image-multi-identity-v1'
      AND "workflowKey" = 'qwen-image-edit-multi-identity'
      AND "runnerConfig" ->> 'workflowVersion' = '2'
      AND "version" = 2
      AND "enabled" = true
      AND "status" = 'active'
      AND "rolloutPercent" = 100
  ) THEN
    RAISE EXCEPTION 'Qwen image profiles did not converge to workflow/profile v2';
  END IF;
END $$;

COMMIT;
