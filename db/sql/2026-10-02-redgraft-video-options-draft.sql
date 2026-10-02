-- Import a disabled options draft for the active default recipe. An already
-- published options route is validated and left unchanged, including its proof.
-- Supports the historical Gemma 4/5 and current MPSGraph 6/7 publications.
BEGIN;
LOCK TABLE "generation_model_profiles" IN SHARE ROW EXCLUSIVE MODE;
DO $$
DECLARE
  base record;
  target_version integer;
  target_workflow integer;
  options jsonb := '{"version":"redgraft-video-options-v1","seconds":[3,5],"orientations":["2:3","1:1"],"qualities":["preview","standard"]}';
BEGIN
  SELECT * INTO STRICT base FROM "generation_model_profiles"
    WHERE "profileKey" = 'profile_video_redgraft_ltx25_v1' AND "status" = 'active';
  target_workflow := (base."runnerConfig"->>'workflowVersion')::integer;
  IF target_workflow > 4 THEN RETURN; END IF;
  IF target_workflow IS NULL OR NOT ((base."version" IN (4,5) AND target_workflow = 3)
    OR (base."version" IN (6,7) AND target_workflow = 4))
    OR base."workflowKey" IS DISTINCT FROM 'redgraft-ltx25-i2v'
    OR base."pipelineModel" IS DISTINCT FROM 'redgraft-ltx25-fast2k-int8-convrot'
    OR base."runner" <> 'comfyui' OR NOT base."enabled"
    OR base."defaultWidth" <> 768 OR base."defaultHeight" <> 1152
  THEN RAISE EXCEPTION 'Unsupported active RedGraft route for video-options import'; END IF;

  IF base."version" IN (5,7) THEN
    target_version := base."version";
  ELSE
    target_version := base."version" + 1;
    IF base."allowedOrientations" IS DISTINCT FROM '["2:3"]'::jsonb OR base."runnerConfig" ? 'videoOptions' THEN
      RAISE EXCEPTION 'RedGraft default route has drifted before video-options import';
    END IF;
    INSERT INTO "generation_model_profiles" (
      "id", "profileKey", "label", "mode", "runner", "pipelineModel", "workflowKey",
      "sourceModelPath", "convertedModelPath", "modelFormat", "runnerConfig",
      "defaultWidth", "defaultHeight", "allowedOrientations", "steps", "sampler", "scheduler",
      "cfgScale", "costMultiplier", "requiredEntitlement", "maxCount", "concurrencyLimit",
      "enabled", "rolloutPercent", "version", "status", "dryRunSummary", "createdAt", "updatedAt"
    )
    SELECT
      'seed-profile-video-redgraft-ltx25-options-v' || target_version, base."profileKey", 'Character video', base."mode", base."runner", base."pipelineModel", base."workflowKey",
      base."sourceModelPath", base."convertedModelPath", base."modelFormat",
      base."runnerConfig" || jsonb_build_object('videoOptions', options),
      base."defaultWidth", base."defaultHeight", '["2:3","1:1"]'::jsonb, base."steps", base."sampler", base."scheduler",
      base."cfgScale", base."costMultiplier", base."requiredEntitlement", base."maxCount", base."concurrencyLimit",
      false, base."rolloutPercent", target_version, 'draft', '{}'::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    WHERE NOT EXISTS (SELECT 1 FROM "generation_model_profiles" WHERE "profileKey" = base."profileKey" AND "version" = target_version);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM "generation_model_profiles"
    WHERE "profileKey" = base."profileKey" AND "version" = target_version
      AND "workflowKey" = base."workflowKey" AND "pipelineModel" = base."pipelineModel" AND "runner" = base."runner"
      AND "runnerConfig" = ((base."runnerConfig" - 'videoOptions') || jsonb_build_object('videoOptions', options))
      AND "allowedOrientations" = '["2:3","1:1"]'::jsonb
      AND ((base."version" = target_version AND "status" = 'active' AND "enabled")
        OR (base."version" <> target_version AND "status" = 'draft' AND NOT "enabled")))
  THEN RAISE EXCEPTION 'RedGraft video-options v% did not converge; inspect its execution and publication state', target_version; END IF;
END $$;
COMMIT;
