-- Apply with Generation admission/workers stopped and queues paused/drained.
-- Requires the installed Qwen 2.1 nodes and attested Viggle v0.3 r128 adapter.
-- INVARIANT: publish N+1; retain historical profile, Job/Attempt and price pins.
BEGIN;
LOCK TABLE "generation_model_profiles" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  current_profile record;
  expected_model text;
  previous_workflow integer;
  target_workflow integer;
  next_version integer;
  configuration jsonb;
  encoder_path text := '/Users/kk/ComfyUI-Shared/models/text_encoders/qwen3vl_8b_int8_convrot.safetensors';
  encoder_sha text := '8bfd0f6e12abf2d2d697ecc888e5e90b0d6741d6708f05799f53afa560452e8f';
  lora_sha text := '0c98591700346f9777051d4e6fa29aa94519abec0d85b1f1f672a2a3db8c94b3';
BEGIN
  IF EXISTS (
    SELECT 1 FROM "generation_jobs" job
    WHERE job."status" IN ('queued', 'moderating_input', 'running', 'moderating_output')
      AND (job."profileId" IN (SELECT "id" FROM "generation_model_profiles"
        WHERE "workflowKey" IN ('qwen-image-edit-multi-reference', 'qwen-image-edit-multi-identity'))
        OR job."profileId" IN (SELECT "profileKey" FROM "generation_model_profiles"
          WHERE "workflowKey" IN ('qwen-image-edit-multi-reference', 'qwen-image-edit-multi-identity'))
        OR job."controls"->>'workflowKey' IN ('qwen-image-edit-multi-reference', 'qwen-image-edit-multi-identity')
        OR job."model" IN ('qwen-image-edit-multi-reference', 'qwen-image-edit-multi-identity',
          'redqw21-multi-reference', 'redqw21-multi-identity'))
  ) THEN
    RAISE EXCEPTION 'Pending multi-reference jobs must finish before acceleration publication';
  END IF;

  FOR current_profile IN
    SELECT * FROM "generation_model_profiles"
    WHERE "status" = 'active' AND "workflowKey" IN (
      'qwen-image-edit-multi-reference', 'qwen-image-edit-multi-identity')
  LOOP
    expected_model := CASE current_profile."workflowKey"
      WHEN 'qwen-image-edit-multi-reference' THEN 'redqw21-multi-reference'
      ELSE 'redqw21-multi-identity' END;
    previous_workflow := CASE current_profile."workflowKey"
      WHEN 'qwen-image-edit-multi-reference' THEN 6 ELSE 5 END;
    target_workflow := previous_workflow + 1;
    configuration := coalesce(current_profile."runnerConfig", '{}'::jsonb);
    IF current_profile."mode" <> 'image' OR current_profile."runner" <> 'comfyui'
      OR current_profile."pipelineModel" IS DISTINCT FROM expected_model THEN
      RAISE EXCEPTION 'Unexpected multi-reference profile: %', current_profile."id";
    END IF;
    -- A later publication is authoritative, including on historical SQL replay.
    IF (configuration->>'workflowVersion')::integer > target_workflow THEN
      CONTINUE;
    END IF;
    IF (configuration->>'workflowVersion')::integer = target_workflow
      AND configuration->>'vaeTemporalPadding' = 'torch_cat'
      AND configuration->>'textEncoderPath' = encoder_path
      AND configuration->>'textEncoderSha256' = encoder_sha
      AND configuration->>'textEncoderDevice' = 'mps'
      AND configuration->>'conditioningPasses' = '1'
      AND configuration->'turboLora'->>'sha256' = lora_sha
      AND configuration->'turboLora'->>'rank' = '128'
      AND configuration->'turboLora'->>'alpha' = '128'
      AND configuration->'turboLora'->>'strength' = '1'
      AND configuration->'turboLora'->>'unmerged' = 'true'
      AND configuration->'capabilities'->>'lora' = 'true'
      AND current_profile."steps" = 6 AND current_profile."cfgScale" = 1
      AND current_profile."sampler" = 'euler' AND current_profile."scheduler" = 'viggle_turbo' THEN
      CONTINUE;
    END IF;
    IF (configuration->>'workflowVersion')::integer IS DISTINCT FROM previous_workflow
      OR configuration->>'textEncoderPath' IS DISTINCT FROM encoder_path
      OR configuration->>'textEncoderSha256' IS DISTINCT FROM encoder_sha
      OR configuration->>'civitaiVersionId' IS DISTINCT FROM '3370753'
      OR configuration->>'vaeTemporalPadding' IS DISTINCT FROM 'torch_cat' THEN
      RAISE EXCEPTION 'Publish verified REDQW21 V2 and corrected INT8/VAE configuration before multi-reference acceleration: %', current_profile."id";
    END IF;

    configuration := configuration || jsonb_build_object(
      'workflowVersion', target_workflow, 'textEncoderDevice', 'mps', 'conditioningPasses', 1,
      'capabilities', coalesce(configuration->'capabilities', '{}'::jsonb) || '{"lora":true}'::jsonb,
      'turboLora', jsonb_build_object(
        'path', '/Users/kk/ComfyUI-Shared/models/loras/Qwen-Image-2.1-viggle-turbo-v0.3-6step-lora-r128.safetensors',
        'sha256', lora_sha, 'repository', 'Viggle/Qwen-Image-2.1-viggle-turbo',
        'revision', '009a44a895ef85f7e643c80fdca9543795248867',
        'rank', 128, 'alpha', 128, 'strength', 1, 'unmerged', true
      )
    );
    SELECT max("version") + 1 INTO next_version FROM "generation_model_profiles"
      WHERE "profileKey" = current_profile."profileKey";

    INSERT INTO "generation_model_profiles" (
      "id", "profileKey", "label", "mode", "runner", "pipelineModel", "workflowKey",
      "sourceModelPath", "convertedModelPath", "modelFormat", "runnerConfig",
      "defaultWidth", "defaultHeight", "allowedOrientations", "steps", "sampler",
      "scheduler", "cfgScale", "costMultiplier", "requiredEntitlement", "maxCount",
      "concurrencyLimit", "enabled", "rolloutPercent", "version", "status",
      "dryRunSummary", "publishedAt", "archivedAt", "createdAt", "updatedAt"
    ) VALUES (
      current_profile."profileKey" || '-turbo-v' || next_version,
      current_profile."profileKey", current_profile."label", current_profile."mode",
      current_profile."runner", current_profile."pipelineModel", current_profile."workflowKey",
      current_profile."sourceModelPath", current_profile."convertedModelPath", current_profile."modelFormat",
      configuration, current_profile."defaultWidth", current_profile."defaultHeight", current_profile."allowedOrientations",
      6, 'euler', 'viggle_turbo', 1,
      current_profile."costMultiplier", current_profile."requiredEntitlement", current_profile."maxCount",
      current_profile."concurrencyLimit", current_profile."enabled", current_profile."rolloutPercent", next_version, 'active',
      jsonb_build_object('status', 'configuration_cutover_requires_live_probe',
        'source', '2026-10-03-qwen21-multi-reference-acceleration', 'previousProfileId', current_profile."id"),
      CURRENT_TIMESTAMP, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
    UPDATE "generation_model_profiles" SET "status" = 'archived',
      "archivedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = current_profile."id";
  END LOOP;
END $$;
COMMIT;
