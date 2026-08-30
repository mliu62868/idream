-- SPEC: LTX 2.3 GTAnimation is no longer executable; RedGraft LTX 2.5 is the
-- default Character I2V route. Historical Jobs and Attempts remain intact.

BEGIN;

LOCK TABLE "generation_model_profiles" IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "generation_jobs"
    WHERE "mode" = 'video'
      AND (
        "model" = 'ltx23-gtanimation-i2v'
        OR "profileId" = 'profile_video_beta_v1'
      )
      AND "status" IN (
        'queued',
        'moderating_input',
        'running',
        'moderating_output'
      )
  ) OR EXISTS (
    SELECT 1
    FROM "generation_attempts"
    WHERE "workflowKey" = 'ltx23-gtanimation-i2v'
      AND "status" IN ('queued', 'running')
  ) THEN
    RAISE EXCEPTION 'LTX 2.3 still has active generation work';
  END IF;
END $$;

UPDATE "generation_model_profiles"
SET
  "enabled" = false,
  "rolloutPercent" = 0,
  "status" = 'archived',
  "archivedAt" = COALESCE("archivedAt", CURRENT_TIMESTAMP),
  "updatedAt" = CURRENT_TIMESTAMP
WHERE
  "id" = 'seed-profile-video-beta-v1'
  OR "profileKey" = 'profile_video_beta_v1'
  OR "pipelineModel" = 'ltx23-gtanimation-int4-convrot'
  OR "workflowKey" = 'ltx23-gtanimation-i2v';

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
VALUES (
  'seed-profile-video-redgraft-ltx25-v1',
  'profile_video_redgraft_ltx25_v1',
  'RedGraft LTX 2.5 Fast 2K',
  'video',
  'comfyui',
  'redgraft-ltx25-fast2k-int8-convrot',
  'redgraft-ltx25-i2v',
  'diffusion_models/redgraftLTX25Fast2K_ltx25RedgraftNSFW.safetensors',
  NULL,
  'safetensors',
  '{
    "workflowVersion": 1,
    "capabilities": {
      "textToImage": false,
      "stableSeed": true,
      "referenceImages": false,
      "initImage": true,
      "imageToVideo": true,
      "audio": true,
      "fps": 24,
      "maxDurationSeconds": 5
    }
  }'::jsonb,
  768,
  1152,
  '["2:3"]'::jsonb,
  13,
  'euler',
  'manual_sigmas',
  1,
  1,
  'video_generation',
  1,
  1,
  true,
  100,
  1,
  'active',
  '{
    "status": "passed",
    "source": "local_mps_multi_seed_and_cutover_probe",
    "testedAt": "2026-08-29",
    "resolution": "768x1152",
    "frames": 121,
    "seconds": 5.041666666666667,
    "fps": 24,
    "wallTimeSeconds": 893.807,
    "notes": "Exact RedGraft LTX 2.5 route completed product generation and full MP4 decode on the isolated Apple Silicon MPS video runner."
  }'::jsonb,
  CURRENT_TIMESTAMP,
  NULL,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("id") DO UPDATE
SET
  "profileKey" = EXCLUDED."profileKey",
  "label" = EXCLUDED."label",
  "mode" = EXCLUDED."mode",
  "runner" = EXCLUDED."runner",
  "pipelineModel" = EXCLUDED."pipelineModel",
  "workflowKey" = EXCLUDED."workflowKey",
  "sourceModelPath" = EXCLUDED."sourceModelPath",
  "convertedModelPath" = EXCLUDED."convertedModelPath",
  "modelFormat" = EXCLUDED."modelFormat",
  "runnerConfig" = EXCLUDED."runnerConfig",
  "defaultWidth" = EXCLUDED."defaultWidth",
  "defaultHeight" = EXCLUDED."defaultHeight",
  "allowedOrientations" = EXCLUDED."allowedOrientations",
  "steps" = EXCLUDED."steps",
  "sampler" = EXCLUDED."sampler",
  "scheduler" = EXCLUDED."scheduler",
  "cfgScale" = EXCLUDED."cfgScale",
  "costMultiplier" = EXCLUDED."costMultiplier",
  "requiredEntitlement" = EXCLUDED."requiredEntitlement",
  "maxCount" = EXCLUDED."maxCount",
  "concurrencyLimit" = EXCLUDED."concurrencyLimit",
  "enabled" = EXCLUDED."enabled",
  "rolloutPercent" = EXCLUDED."rolloutPercent",
  "version" = EXCLUDED."version",
  "status" = EXCLUDED."status",
  "dryRunSummary" = EXCLUDED."dryRunSummary",
  "publishedAt" = EXCLUDED."publishedAt",
  "archivedAt" = NULL,
  "updatedAt" = CURRENT_TIMESTAMP;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "generation_model_profiles"
    WHERE (
      "id" = 'seed-profile-video-beta-v1'
      OR "profileKey" = 'profile_video_beta_v1'
      OR "pipelineModel" = 'ltx23-gtanimation-int4-convrot'
      OR "workflowKey" = 'ltx23-gtanimation-i2v'
    )
    AND (
      "enabled" <> false
      OR "rolloutPercent" <> 0
      OR "status" <> 'archived'
      OR "archivedAt" IS NULL
    )
  ) THEN
    RAISE EXCEPTION 'LTX 2.3 profile remains executable';
  END IF;

  IF (
    SELECT count(*)
    FROM "generation_model_profiles"
    WHERE "profileKey" = 'profile_video_redgraft_ltx25_v1'
      AND "pipelineModel" = 'redgraft-ltx25-fast2k-int8-convrot'
      AND "workflowKey" = 'redgraft-ltx25-i2v'
      AND "runnerConfig" ->> 'workflowVersion' = '1'
      AND "enabled" = true
      AND "rolloutPercent" = 100
      AND "status" = 'active'
      AND "archivedAt" IS NULL
  ) <> 1 THEN
    RAISE EXCEPTION 'RedGraft LTX 2.5 profile did not converge to one active row';
  END IF;
END $$;

COMMIT;
