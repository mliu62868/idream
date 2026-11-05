-- Apply with Generation admission quiesced and all H3 work settled.
-- Selection policy gets a new immutable profile publication; the tested v5
-- workflow and model bytes, pricing, and historical attempts stay pinned.
BEGIN;
LOCK TABLE "generation_model_profiles" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  previous record;
BEGIN
  SELECT * INTO STRICT previous FROM "generation_model_profiles"
    WHERE "profileKey" = 'profile_video_h3_v1' AND "status" = 'active';
  IF previous."mode" <> 'video' OR previous."runner" <> 'comfyui'
    OR previous."pipelineModel" <> 'minimax-h3-mystic-v5-int8-convrot'
    OR previous."workflowKey" IS DISTINCT FROM 'minimax-h3-mystic-i2v'
    OR previous."sourceModelPath" IS DISTINCT FROM 'diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors'
    OR previous."convertedModelPath" IS NOT NULL OR previous."modelFormat" <> 'safetensors'
    OR previous."runnerConfig" - 'publicSelection' IS DISTINCT FROM
      '{"workflowVersion":5,"capabilities":{"textToImage":false,"stableSeed":true,"referenceImages":false,"initImage":true,"imageToVideo":true,"audio":true,"fps":24,"maxDurationSeconds":5}}'::jsonb
    OR previous."defaultWidth" <> 512 OR previous."defaultHeight" <> 512
    OR previous."allowedOrientations" IS DISTINCT FROM '["1:1"]'::jsonb
    OR previous."steps" <> 8 OR previous."sampler" <> 'euler'
    OR previous."scheduler" <> 'simple' OR previous."cfgScale" <> 1
    OR previous."requiredEntitlement" IS DISTINCT FROM 'video_generation'
    OR previous."maxCount" <> 1 OR previous."concurrencyLimit" <> 1
    OR previous."rolloutPercent" <> 100 OR previous."enabled" IS DISTINCT FROM true
  THEN
    RAISE EXCEPTION 'Enabled Mystic V5 execution contract required before default publication';
  END IF;
  IF previous."version" = 6 AND NOT (previous."runnerConfig" ? 'publicSelection') THEN
    RETURN;
  END IF;
  IF previous."version" <> 5
    OR previous."runnerConfig"->'publicSelection' IS DISTINCT FROM '{"explicitOnly":true}'::jsonb
    OR EXISTS (SELECT 1 FROM "generation_model_profiles"
      WHERE "profileKey" = previous."profileKey" AND "version" >= 6)
  THEN
    RAISE EXCEPTION 'Expected the enabled H3 Mystic v5 manual publication';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "generation_jobs" job
    WHERE job."status" IN ('queued','moderating_input','running','moderating_output')
      AND (job."profileId" = previous."profileKey"
        OR job."profileId" IN (SELECT "id" FROM "generation_model_profiles" WHERE "profileKey" = previous."profileKey")
        OR job."model" LIKE 'minimax-h3-%'
        OR job."controls"->>'workflowKey' LIKE 'minimax-h3-%')
  ) OR EXISTS (
    SELECT 1 FROM "generation_attempts"
    WHERE ("profileKey" = previous."profileKey" OR "workflowKey" LIKE 'minimax-h3-%')
      AND "status" IN ('queued','running','unknown')
  ) THEN
    RAISE EXCEPTION 'Pending H3 work must finish before default publication';
  END IF;

  INSERT INTO "generation_model_profiles"
    SELECT (jsonb_populate_record(NULL::"generation_model_profiles",
      to_jsonb(previous) || jsonb_build_object(
        'id', 'profile_video_h3_v1-mystic-default-v6',
        'version', 6,
        'runnerConfig', previous."runnerConfig" - 'publicSelection',
        'dryRunSummary', previous."dryRunSummary" || jsonb_build_object(
          'selectionPolicy', 'default_video', 'previousProfileId', previous."id",
          'selectionPublishedBy', '2026-11-02-h3-default-video'),
        'publishedAt', CURRENT_TIMESTAMP, 'archivedAt', NULL,
        'createdAt', CURRENT_TIMESTAMP, 'updatedAt', CURRENT_TIMESTAMP
      ))).*;
  UPDATE "generation_model_profiles" SET "status" = 'archived',
    "archivedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = previous."id";
END $$;
COMMIT;
