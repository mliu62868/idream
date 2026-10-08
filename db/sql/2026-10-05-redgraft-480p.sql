-- Run after Generation admission and workers are quiesced. Publish the aligned
-- 448x768 portrait default without changing pricing or historical job pins.
-- Published options-v7 becomes v9; default-v6 becomes v8, and its disabled
-- options draft remains disabled. Qualification must be recorded separately.
BEGIN;
LOCK TABLE "generation_model_profiles" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  current_profile record;
  previous record;
  expected_config jsonb := '{"workflowVersion":4,"capabilities":{"textToImage":false,"stableSeed":true,"referenceImages":false,"initImage":true,"imageToVideo":true,"audio":true,"fps":24,"maxDurationSeconds":5}}';
  old_options jsonb := '{"videoOptions":{"version":"redgraft-video-options-v1","seconds":[3,5],"orientations":["2:3","1:1"],"qualities":["preview","standard"]}}';
  next_options jsonb := '{"videoOptions":{"version":"redgraft-video-options-v2","seconds":[3,5],"orientations":["7:12","2:3","1:1"],"qualities":["preview","standard"]}}';
  replay boolean;
BEGIN
  IF EXISTS (
    SELECT 1 FROM "generation_jobs" job
    WHERE job."status" IN ('queued','moderating_input','running','moderating_output')
      AND (job."model" = 'redgraft-ltx25-fast2k-int8-convrot'
        OR job."controls"->>'workflowKey' = 'redgraft-ltx25-i2v'
        OR job."profileId" = 'profile_video_redgraft_ltx25_v1'
        OR job."profileId" IN (SELECT "id" FROM "generation_model_profiles"
          WHERE "profileKey" = 'profile_video_redgraft_ltx25_v1'))
  ) OR EXISTS (
    SELECT 1 FROM "generation_attempts" WHERE "workflowKey" = 'redgraft-ltx25-i2v'
      AND "status" IN ('queued','running')
  ) THEN
    RAISE EXCEPTION 'Pending RedGraft work must finish before 480p publication';
  END IF;

  SELECT * INTO STRICT current_profile FROM "generation_model_profiles"
    WHERE "profileKey" = 'profile_video_redgraft_ltx25_v1' AND "status" = 'active';
  -- Historical replay must not downgrade a later workflow publication.
  IF (current_profile."runnerConfig"->>'workflowVersion')::integer > 5 THEN RETURN; END IF;
  replay := current_profile."version" IN (8,9);
  IF (NOT replay AND current_profile."version" NOT IN (6,7))
    OR EXISTS (SELECT 1 FROM "generation_model_profiles"
      WHERE "profileKey" = current_profile."profileKey"
      GROUP BY "version" HAVING COUNT(*) > 1)
    OR (NOT replay AND EXISTS (SELECT 1 FROM "generation_model_profiles"
      WHERE "profileKey" = current_profile."profileKey" AND "version" >= 8))
    OR EXISTS (SELECT 1 FROM "generation_model_profiles"
      WHERE "profileKey" = current_profile."profileKey" AND "status" <> 'archived'
        AND NOT (("version" = CASE WHEN replay THEN 8 ELSE 6 END AND "status" = 'active' AND "enabled")
          OR ("version" = CASE WHEN replay THEN 9 ELSE 7 END
            AND (("status" = 'active' AND "enabled") OR ("status" = 'draft' AND NOT "enabled")))))
  THEN
    RAISE EXCEPTION 'Expected published RedGraft v6/v7 or exact v8/v9 replay, with no conflicting versions';
  END IF;

  FOR previous IN SELECT * FROM "generation_model_profiles"
    WHERE "profileKey" = current_profile."profileKey"
      AND "version" IN (CASE WHEN replay THEN 8 ELSE 6 END, CASE WHEN replay THEN 9 ELSE 7 END)
      AND "status" IN ('active','draft') ORDER BY "version"
  LOOP
    IF previous."mode" IS DISTINCT FROM 'video' OR previous."runner" IS DISTINCT FROM 'comfyui'
      OR previous."workflowKey" IS DISTINCT FROM 'redgraft-ltx25-i2v'
      OR previous."pipelineModel" IS DISTINCT FROM 'redgraft-ltx25-fast2k-int8-convrot'
      OR previous."sourceModelPath" IS DISTINCT FROM 'diffusion_models/redgraftLTX25Fast2K_ltx25RedgraftNSFW.safetensors'
      OR previous."convertedModelPath" IS NOT NULL OR previous."modelFormat" IS DISTINCT FROM 'safetensors'
      OR previous."runnerConfig" IS DISTINCT FROM (
        expected_config || CASE WHEN replay THEN '{"workflowVersion":5}'::jsonb ELSE '{}'::jsonb END
        || CASE WHEN previous."version" IN (7,9) THEN CASE WHEN replay THEN next_options ELSE old_options END ELSE '{}'::jsonb END)
      OR previous."defaultWidth" IS DISTINCT FROM (CASE WHEN replay THEN 448 ELSE 768 END)
      OR previous."defaultHeight" IS DISTINCT FROM (CASE WHEN replay THEN 768 ELSE 1152 END)
      OR previous."allowedOrientations" IS DISTINCT FROM (
        CASE WHEN replay THEN CASE WHEN previous."version" = 9 THEN '["7:12","2:3","1:1"]'::jsonb ELSE '["7:12"]'::jsonb END
          ELSE CASE WHEN previous."version" = 7 THEN '["2:3","1:1"]'::jsonb ELSE '["2:3"]'::jsonb END END)
      OR previous."steps" IS DISTINCT FROM 13 OR previous."sampler" IS DISTINCT FROM 'euler'
      OR previous."scheduler" IS DISTINCT FROM 'manual_sigmas' OR previous."cfgScale" IS DISTINCT FROM 1::double precision
      OR previous."requiredEntitlement" IS DISTINCT FROM 'video_generation'
      OR previous."maxCount" IS DISTINCT FROM 1 OR previous."concurrencyLimit" IS DISTINCT FROM 1
      OR previous."rolloutPercent" IS DISTINCT FROM 100
    THEN
      RAISE EXCEPTION 'RedGraft v% execution contract drifted; reconcile before 480p publication', previous."version";
    END IF;

    IF replay THEN CONTINUE; END IF;
    INSERT INTO "generation_model_profiles" (
      "id","profileKey","label","mode","runner","pipelineModel","workflowKey",
      "sourceModelPath","convertedModelPath","modelFormat","runnerConfig",
      "defaultWidth","defaultHeight","allowedOrientations","steps","sampler","scheduler",
      "cfgScale","costMultiplier","requiredEntitlement","maxCount","concurrencyLimit",
      "enabled","rolloutPercent","version","status","dryRunSummary","publishedAt",
      "archivedAt","createdAt","updatedAt"
    ) VALUES (
      previous."profileKey" || '-480p-v' || (previous."version" + 2),
      previous."profileKey",previous."label",previous."mode",previous."runner",previous."pipelineModel",previous."workflowKey",
      previous."sourceModelPath",previous."convertedModelPath",previous."modelFormat",
      (previous."runnerConfig" - 'videoOptions') || '{"workflowVersion":5}'::jsonb
        || CASE WHEN previous."version" = 7 THEN next_options ELSE '{}'::jsonb END,
      448,768,CASE WHEN previous."version" = 7 THEN '["7:12","2:3","1:1"]'::jsonb ELSE '["7:12"]'::jsonb END,
      previous."steps",previous."sampler",previous."scheduler",previous."cfgScale",previous."costMultiplier",
      previous."requiredEntitlement",previous."maxCount",previous."concurrencyLimit",previous."enabled",previous."rolloutPercent",
      previous."version" + 2,previous."status",
      jsonb_build_object('status','configuration_cutover_requires_live_probe',
        'source','2026-10-05-redgraft-480p','previousProfileId',previous."id",'resolution','448x768'),
      CASE WHEN previous."status" = 'active' THEN CURRENT_TIMESTAMP ELSE NULL END,
      NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
    );
    UPDATE "generation_model_profiles" SET "status" = 'archived',
      "archivedAt" = CURRENT_TIMESTAMP,"updatedAt" = CURRENT_TIMESTAMP WHERE "id" = previous."id";
  END LOOP;
END $$;
COMMIT;
