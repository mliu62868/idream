-- Run after quiescing Generation admission and finishing all H3 work.
-- Publish a new immutable version; historical REDMix rows keep their pins.
BEGIN;
LOCK TABLE "generation_model_profiles" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  previous record;
BEGIN
  SELECT * INTO STRICT previous FROM "generation_model_profiles"
    WHERE "profileKey" = 'profile_video_h3_v1' AND "status" = 'active';
  IF previous."runner" <> 'comfyui' OR previous."mode" <> 'video'
    OR previous."modelFormat" <> 'safetensors' OR previous."convertedModelPath" IS NOT NULL
    OR previous."runnerConfig" - 'workflowVersion' IS DISTINCT FROM
      '{"capabilities":{"textToImage":false,"stableSeed":true,"referenceImages":false,"initImage":true,"imageToVideo":true,"audio":true,"fps":24,"maxDurationSeconds":5},"publicSelection":{"explicitOnly":true}}'::jsonb
    OR previous."defaultWidth" <> 512 OR previous."defaultHeight" <> 512
    OR previous."allowedOrientations" IS DISTINCT FROM '["1:1"]'::jsonb
    OR previous."steps" <> 8 OR previous."sampler" <> 'euler'
    OR previous."scheduler" <> 'simple' OR previous."cfgScale" <> 1
    OR previous."requiredEntitlement" IS DISTINCT FROM 'video_generation'
    OR previous."maxCount" <> 1 OR previous."concurrencyLimit" <> 1
    OR previous."rolloutPercent" <> 100
  THEN
    RAISE EXCEPTION 'H3 execution contract has drifted; reconcile before publishing';
  END IF;
  -- Idempotent only for this exact publication; unexpected state fails closed.
  IF previous."version" = 5
    AND previous."workflowKey" = 'minimax-h3-mystic-i2v'
    AND previous."pipelineModel" = 'minimax-h3-mystic-v5-int8-convrot'
    AND previous."sourceModelPath" = 'diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors'
    AND previous."runnerConfig"->>'workflowVersion' = '5'
  THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM "generation_jobs" job
    WHERE job."status" IN ('queued','moderating_input','running','moderating_output')
      AND (job."model" IN ('minimax-h3-redcraft-a2a-int8-convrot','minimax-h3-redcraft-i2v','minimax-h3-mystic-i2v','minimax-h3-mystic-v5-int8-convrot')
        OR job."controls"->>'workflowKey' IN ('minimax-h3-redcraft-i2v','minimax-h3-mystic-i2v')
        OR job."profileId" = 'profile_video_h3_v1'
        OR job."profileId" IN (SELECT "id" FROM "generation_model_profiles"
          WHERE "profileKey" = 'profile_video_h3_v1'))
  ) OR EXISTS (
    SELECT 1 FROM "generation_attempts"
    WHERE ("profileKey" = 'profile_video_h3_v1'
      OR "workflowKey" IN ('minimax-h3-redcraft-i2v','minimax-h3-mystic-i2v'))
      AND "status" IN ('queued','running','unknown')
  ) THEN
    RAISE EXCEPTION 'Pending H3 work must finish before Mystic V5 publication';
  END IF;
  IF previous."version" <> 4
    OR previous."workflowKey" IS DISTINCT FROM 'minimax-h3-redcraft-i2v'
    OR previous."pipelineModel" IS DISTINCT FROM 'minimax-h3-redcraft-a2a-int8-convrot'
    OR previous."sourceModelPath" IS DISTINCT FROM 'diffusion_models/REDMix-MiniMaxH3-A2Ab1-pruned-int8-convrot-ComfyMCP.safetensors'
    OR previous."runnerConfig"->>'workflowVersion' IS DISTINCT FROM '4'
    OR EXISTS (SELECT 1 FROM "generation_model_profiles"
      WHERE "profileKey" = previous."profileKey" AND "version" >= 5)
  THEN
    RAISE EXCEPTION 'Expected the published H3 REDMix v4; reconcile before publishing';
  END IF;

  INSERT INTO "generation_model_profiles" (
    "id","profileKey","label","mode","runner","pipelineModel","workflowKey",
    "sourceModelPath","convertedModelPath","modelFormat","runnerConfig",
    "defaultWidth","defaultHeight","allowedOrientations","steps","sampler","scheduler",
    "cfgScale","costMultiplier","requiredEntitlement","maxCount","concurrencyLimit",
    "enabled","rolloutPercent","version","status","dryRunSummary","publishedAt",
    "archivedAt","createdAt","updatedAt"
  ) VALUES (
    'profile_video_h3_v1-mystic-v5',previous."profileKey",'MiniMax H3 Mystic V5',
    previous."mode",previous."runner",'minimax-h3-mystic-v5-int8-convrot','minimax-h3-mystic-i2v',
    'diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors',NULL,previous."modelFormat",
    previous."runnerConfig" || '{"workflowVersion":5}'::jsonb,
    previous."defaultWidth",previous."defaultHeight",previous."allowedOrientations",previous."steps",previous."sampler",previous."scheduler",
    previous."cfgScale",previous."costMultiplier",previous."requiredEntitlement",previous."maxCount",previous."concurrencyLimit",
    previous."enabled",previous."rolloutPercent",5,'active',
    jsonb_build_object('status','configuration_cutover_requires_live_probe',
      'source','2026-11-02-h3-mystic-v5','previousProfileId',previous."id"),
    CURRENT_TIMESTAMP,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
  );
  UPDATE "generation_model_profiles" SET "status" = 'archived',
    "archivedAt" = CURRENT_TIMESTAMP,"updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = previous."id";
END $$;
COMMIT;
