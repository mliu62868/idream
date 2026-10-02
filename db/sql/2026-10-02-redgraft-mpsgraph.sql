-- Run only after Generation admission and workers are quiesced. Publish the
-- validated MPSGraph workflow without changing prices, options or old job pins.
-- A published options-v5 route becomes active v7; default-v4 becomes v6 and
-- an optional disabled options-v5 draft becomes v7, still disabled.
BEGIN;
LOCK TABLE "generation_model_profiles" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  current_profile record;
  previous record;
  expected_config jsonb := '{"workflowVersion":3,"capabilities":{"textToImage":false,"stableSeed":true,"referenceImages":false,"initImage":true,"imageToVideo":true,"audio":true,"fps":24,"maxDurationSeconds":5}}';
  options_config jsonb := '{"videoOptions":{"version":"redgraft-video-options-v1","seconds":[3,5],"orientations":["2:3","1:1"],"qualities":["preview","standard"]}}';
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
    RAISE EXCEPTION 'Pending RedGraft work must finish before MPSGraph publication';
  END IF;

  SELECT * INTO STRICT current_profile FROM "generation_model_profiles"
    WHERE "profileKey" = 'profile_video_redgraft_ltx25_v1' AND "status" = 'active';
  -- Historical migration replay must never downgrade a later publication.
  IF (current_profile."runnerConfig"->>'workflowVersion')::integer > 4 THEN
    RETURN;
  END IF;
  IF current_profile."version" IN (6,7) AND current_profile."runnerConfig"->>'workflowVersion' = '4' THEN
    RETURN;
  END IF;
  IF current_profile."version" NOT IN (4,5)
    OR EXISTS (SELECT 1 FROM "generation_model_profiles"
      WHERE "profileKey" = current_profile."profileKey" AND "version" >= 6)
    OR EXISTS (SELECT 1 FROM "generation_model_profiles"
      WHERE "profileKey" = current_profile."profileKey" AND "status" <> 'archived'
        AND NOT (("version" = 4 AND "status" = 'active' AND "enabled")
          OR ("version" = 5 AND (("status" = 'active' AND "enabled") OR ("status" = 'draft' AND NOT "enabled")))))
  THEN
    RAISE EXCEPTION 'Expected the published RedGraft v4 or v5, with no occupied v6/v7';
  END IF;

  FOR previous IN SELECT * FROM "generation_model_profiles"
    WHERE "profileKey" = current_profile."profileKey" AND "version" IN (4,5)
      AND "status" IN ('active','draft') ORDER BY "version"
  LOOP
    IF previous."mode" <> 'video' OR previous."runner" <> 'comfyui'
      OR previous."workflowKey" IS DISTINCT FROM 'redgraft-ltx25-i2v'
      OR previous."pipelineModel" IS DISTINCT FROM 'redgraft-ltx25-fast2k-int8-convrot'
      OR previous."sourceModelPath" IS DISTINCT FROM 'diffusion_models/redgraftLTX25Fast2K_ltx25RedgraftNSFW.safetensors'
      OR previous."convertedModelPath" IS NOT NULL OR previous."modelFormat" <> 'safetensors'
      OR previous."runnerConfig" IS DISTINCT FROM (expected_config || CASE WHEN previous."version" = 5 THEN options_config ELSE '{}'::jsonb END)
      OR previous."defaultWidth" <> 768 OR previous."defaultHeight" <> 1152
      OR previous."allowedOrientations" IS DISTINCT FROM (CASE WHEN previous."version" = 5 THEN '["2:3","1:1"]'::jsonb ELSE '["2:3"]'::jsonb END)
      OR previous."steps" <> 13 OR previous."sampler" <> 'euler' OR previous."scheduler" <> 'manual_sigmas'
      OR previous."cfgScale" <> 1 OR previous."requiredEntitlement" IS DISTINCT FROM 'video_generation'
      OR previous."maxCount" <> 1 OR previous."concurrencyLimit" <> 1 OR previous."rolloutPercent" <> 100
    THEN
      RAISE EXCEPTION 'RedGraft v% execution contract drifted; reconcile before MPSGraph publication', previous."version";
    END IF;

    INSERT INTO "generation_model_profiles" (
      "id","profileKey","label","mode","runner","pipelineModel","workflowKey",
      "sourceModelPath","convertedModelPath","modelFormat","runnerConfig",
      "defaultWidth","defaultHeight","allowedOrientations","steps","sampler","scheduler",
      "cfgScale","costMultiplier","requiredEntitlement","maxCount","concurrencyLimit",
      "enabled","rolloutPercent","version","status","dryRunSummary","publishedAt",
      "archivedAt","createdAt","updatedAt"
    ) VALUES (
      previous."profileKey" || '-mpsgraph-v' || (previous."version" + 2),
      previous."profileKey",previous."label",previous."mode",previous."runner",previous."pipelineModel",previous."workflowKey",
      previous."sourceModelPath",previous."convertedModelPath",previous."modelFormat",
      previous."runnerConfig" || '{"workflowVersion":4}'::jsonb,
      previous."defaultWidth",previous."defaultHeight",previous."allowedOrientations",previous."steps",previous."sampler",previous."scheduler",
      previous."cfgScale",previous."costMultiplier",previous."requiredEntitlement",previous."maxCount",previous."concurrencyLimit",
      previous."enabled",previous."rolloutPercent",previous."version" + 2,previous."status",
      jsonb_build_object('status','configuration_cutover_requires_live_probe',
        'source','2026-10-02-redgraft-mpsgraph','previousProfileId',previous."id"),
      CASE WHEN previous."status" = 'active' THEN CURRENT_TIMESTAMP ELSE NULL END,
      NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
    );
    UPDATE "generation_model_profiles" SET "status" = 'archived',
      "archivedAt" = CURRENT_TIMESTAMP,"updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = previous."id";
  END LOOP;
END $$;
COMMIT;
