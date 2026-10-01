-- SPEC: apply the model-scoped VAE temporal-padding correction to all Qwen 2.1
-- routes. Publish the qualified native six-step Viggle recipe for single-source
-- edits only; multi-reference routes retain their sixteen-step CFG=2 contract.
-- Requires the verified REDQW21 V2, community INT8 encoder and Viggle v0.3
-- adapter installed with idream_qwen21 nodes. Quiesce admission/workers and
-- pause/drain Generation queues before running against a development database.
-- INVARIANT: publish N+1, preserve historical Job/Attempt/profile and price pins.
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
  single_edit boolean;
  encoder_path text := '/Users/kk/ComfyUI-Shared/models/text_encoders/qwen3vl_8b_int8_convrot.safetensors';
  encoder_sha text := '8bfd0f6e12abf2d2d697ecc888e5e90b0d6741d6708f05799f53afa560452e8f';
  lora_sha text := '0c98591700346f9777051d4e6fa29aa94519abec0d85b1f1f672a2a3db8c94b3';
BEGIN
  IF EXISTS (
    SELECT 1 FROM "generation_jobs" job
    WHERE job."status" IN ('queued', 'moderating_input', 'running', 'moderating_output')
      AND (job."profileId" IN (SELECT "id" FROM "generation_model_profiles"
        WHERE "workflowKey" IN ('redqw21', 'qwen-image-edit-img2img',
          'qwen-image-edit-multi-reference', 'qwen-image-edit-multi-identity'))
        OR job."profileId" IN (SELECT "profileKey" FROM "generation_model_profiles"
          WHERE "workflowKey" IN ('redqw21', 'qwen-image-edit-img2img',
            'qwen-image-edit-multi-reference', 'qwen-image-edit-multi-identity'))
        OR job."controls"->>'workflowKey' IN ('redqw21', 'qwen-image-edit-img2img',
          'qwen-image-edit-multi-reference', 'qwen-image-edit-multi-identity')
        OR job."model" IN ('redqw21', 'qwen-image-edit-img2img', 'qwen-image-edit-multi-reference',
          'qwen-image-edit-multi-identity', 'redqw21-image-edit', 'redqw21-multi-reference', 'redqw21-multi-identity'))
  ) THEN
    RAISE EXCEPTION 'Pending Qwen-Image jobs must finish before Mac acceleration publication';
  END IF;

  FOR current_profile IN
    SELECT * FROM "generation_model_profiles"
    WHERE "status" = 'active' AND "workflowKey" IN ('redqw21',
      'qwen-image-edit-img2img', 'qwen-image-edit-multi-reference', 'qwen-image-edit-multi-identity')
  LOOP
    single_edit := current_profile."workflowKey" = 'qwen-image-edit-img2img';
    expected_model := CASE current_profile."workflowKey"
      WHEN 'redqw21' THEN 'redqw21'
      WHEN 'qwen-image-edit-img2img' THEN 'redqw21-image-edit'
      WHEN 'qwen-image-edit-multi-reference' THEN 'redqw21-multi-reference'
      ELSE 'redqw21-multi-identity' END;
    previous_workflow := CASE current_profile."workflowKey"
      WHEN 'redqw21' THEN 2
      WHEN 'qwen-image-edit-multi-reference' THEN 5
      ELSE 4 END;
    target_workflow := previous_workflow + 1;
    configuration := coalesce(current_profile."runnerConfig", '{}'::jsonb);
    IF current_profile."mode" <> 'image' OR current_profile."runner" <> 'comfyui'
      OR current_profile."pipelineModel" IS DISTINCT FROM expected_model THEN
      RAISE EXCEPTION 'Unexpected Qwen-Image profile: %', current_profile."id";
    END IF;
    -- A future publication is authoritative. Never rewrite or downgrade it.
    IF (configuration->>'workflowVersion')::integer > target_workflow THEN
      CONTINUE;
    END IF;
    IF (configuration->>'workflowVersion')::integer = target_workflow
      AND configuration->>'vaeTemporalPadding' = 'torch_cat'
      AND configuration->>'textEncoderPath' = encoder_path
      AND configuration->>'textEncoderSha256' = encoder_sha
      AND (NOT single_edit OR (
        configuration->>'textEncoderDevice' = 'mps'
        AND configuration->>'conditioningPasses' = '1'
        AND configuration->'turboLora'->>'sha256' = lora_sha
        AND current_profile."steps" = 6 AND current_profile."cfgScale" = 1
        AND current_profile."sampler" = 'euler' AND current_profile."scheduler" = 'viggle_turbo'
      )) THEN
      CONTINUE;
    END IF;
    IF (configuration->>'workflowVersion')::integer IS DISTINCT FROM previous_workflow
      OR configuration->>'textEncoderPath' IS DISTINCT FROM encoder_path
      OR configuration->>'textEncoderSha256' IS DISTINCT FROM encoder_sha
      OR (current_profile."workflowKey" <> 'redqw21'
        AND configuration->>'civitaiVersionId' IS DISTINCT FROM '3370753') THEN
      RAISE EXCEPTION 'Publish verified REDQW21/community INT8 before Mac acceleration: %', current_profile."id";
    END IF;

    configuration := configuration || jsonb_build_object(
      'workflowVersion', target_workflow, 'vaeTemporalPadding', 'torch_cat'
    );
    IF single_edit THEN
      configuration := configuration || jsonb_build_object(
        'textEncoderDevice', 'mps', 'conditioningPasses', 1,
        'capabilities', coalesce(configuration->'capabilities', '{}'::jsonb) || '{"lora":true}'::jsonb,
        'turboLora', jsonb_build_object(
          'path', '/Users/kk/ComfyUI-Shared/models/loras/Qwen-Image-2.1-viggle-turbo-v0.3-6step-lora-r128.safetensors',
          'sha256', lora_sha, 'repository', 'Viggle/Qwen-Image-2.1-viggle-turbo',
          'revision', '009a44a895ef85f7e643c80fdca9543795248867',
          'rank', 128, 'alpha', 128, 'strength', 1, 'unmerged', true
        )
      );
    END IF;
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
      current_profile."profileKey" || '-mac-v' || next_version,
      current_profile."profileKey", current_profile."label", current_profile."mode",
      current_profile."runner", current_profile."pipelineModel", current_profile."workflowKey",
      current_profile."sourceModelPath", current_profile."convertedModelPath", current_profile."modelFormat",
      configuration, current_profile."defaultWidth", current_profile."defaultHeight", current_profile."allowedOrientations",
      CASE WHEN single_edit THEN 6 ELSE current_profile."steps" END,
      CASE WHEN single_edit THEN 'euler' ELSE current_profile."sampler" END,
      CASE WHEN single_edit THEN 'viggle_turbo' ELSE current_profile."scheduler" END,
      CASE WHEN single_edit THEN 1 ELSE current_profile."cfgScale" END,
      current_profile."costMultiplier", current_profile."requiredEntitlement", current_profile."maxCount",
      current_profile."concurrencyLimit", current_profile."enabled", current_profile."rolloutPercent", next_version, 'active',
      jsonb_build_object('status', 'configuration_cutover_requires_live_probe',
        'source', '2026-10-01-qwen21-mac-acceleration', 'previousProfileId', current_profile."id"),
      CURRENT_TIMESTAMP, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
    UPDATE "generation_model_profiles" SET "status" = 'archived',
      "archivedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = current_profile."id";
  END LOOP;
END $$;
COMMIT;
