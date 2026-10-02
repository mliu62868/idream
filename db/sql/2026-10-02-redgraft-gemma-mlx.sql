-- Publish the verified Gemma MLX workflow after quiescing Generation admission
-- and workers. Historical v2 and the disabled options-v3 draft keep their pins.
-- v4 is the default route; v5 carries the same disabled options draft forward.
BEGIN;
LOCK TABLE "generation_model_profiles" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  current_profile record;
  previous record;
  next_version integer;
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
    RAISE EXCEPTION 'Pending RedGraft work must finish before Gemma MLX publication';
  END IF;

  SELECT * INTO STRICT current_profile FROM "generation_model_profiles"
    WHERE "profileKey" = 'profile_video_redgraft_ltx25_v1' AND "status" = 'active';
  -- Replay is inert; a later publication is never downgraded.
  IF (current_profile."runnerConfig"->>'workflowVersion')::integer > 3 THEN
    RETURN;
  END IF;
  IF current_profile."version" = 4 AND current_profile."runnerConfig"->>'workflowVersion' = '3' THEN
    RETURN;
  END IF;
  IF current_profile."version" <> 2
    OR current_profile."workflowKey" IS DISTINCT FROM 'redgraft-ltx25-i2v'
    OR current_profile."pipelineModel" IS DISTINCT FROM 'redgraft-ltx25-fast2k-int8-convrot'
    OR current_profile."runner" <> 'comfyui'
    OR current_profile."runnerConfig"->>'workflowVersion' IS DISTINCT FROM '2'
    OR current_profile."runnerConfig" ? 'videoOptions'
    OR EXISTS (SELECT 1 FROM "generation_model_profiles"
      WHERE "profileKey" = current_profile."profileKey" AND "version" >= 4)
  THEN
    RAISE EXCEPTION 'Expected the published RedGraft v2 and optional disabled v3 draft';
  END IF;
  IF EXISTS (SELECT 1 FROM "generation_model_profiles"
    WHERE "profileKey" = current_profile."profileKey" AND "version" = 3
      AND ("status" <> 'draft' OR "enabled" OR "runnerConfig"->>'workflowVersion' IS DISTINCT FROM '2'))
  THEN
    RAISE EXCEPTION 'RedGraft v3 is no longer a disabled draft; reconcile before publishing';
  END IF;

  FOR previous IN SELECT * FROM "generation_model_profiles"
    WHERE "profileKey" = current_profile."profileKey" AND "version" IN (2,3)
      AND "status" IN ('active','draft') ORDER BY "version"
  LOOP
    next_version := previous."version" + 2;
    INSERT INTO "generation_model_profiles" (
      "id","profileKey","label","mode","runner","pipelineModel","workflowKey",
      "sourceModelPath","convertedModelPath","modelFormat","runnerConfig",
      "defaultWidth","defaultHeight","allowedOrientations","steps","sampler","scheduler",
      "cfgScale","costMultiplier","requiredEntitlement","maxCount","concurrencyLimit",
      "enabled","rolloutPercent","version","status","dryRunSummary","publishedAt",
      "archivedAt","createdAt","updatedAt"
    ) VALUES (
      previous."profileKey" || '-gemma-mlx-v' || next_version,
      previous."profileKey",previous."label",previous."mode",previous."runner",previous."pipelineModel",previous."workflowKey",
      previous."sourceModelPath",previous."convertedModelPath",previous."modelFormat",
      previous."runnerConfig" || '{"workflowVersion":3}'::jsonb,
      previous."defaultWidth",previous."defaultHeight",previous."allowedOrientations",previous."steps",previous."sampler",previous."scheduler",
      previous."cfgScale",previous."costMultiplier",previous."requiredEntitlement",previous."maxCount",previous."concurrencyLimit",
      previous."enabled",previous."rolloutPercent",next_version,previous."status",
      jsonb_build_object('status','configuration_cutover_requires_live_probe',
        'source','2026-10-02-redgraft-gemma-mlx','previousProfileId',previous."id"),
      CASE WHEN previous."status" = 'active' THEN CURRENT_TIMESTAMP ELSE NULL END,
      NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
    );
    UPDATE "generation_model_profiles" SET "status" = 'archived',
      "archivedAt" = CURRENT_TIMESTAMP,"updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = previous."id";
  END LOOP;
END $$;
COMMIT;
