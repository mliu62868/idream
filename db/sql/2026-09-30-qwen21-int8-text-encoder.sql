-- SPEC: switch every Qwen-Image-2.1 route to the verified Comfy-Org INT8
-- ConvRot Qwen3-VL-8B encoder. Install and SHA256-verify the file first.
-- Run with admission/workers quiesced and Generation queues paused/drained.
-- INVARIANT: publish N+1; retain every historical profile/Job/Attempt pin.
BEGIN;
LOCK TABLE "generation_model_profiles" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  current_profile record;
  expected_model text;
  workflow_version integer;
  next_version integer;
  encoder_path text := '/Users/kk/ComfyUI-Shared/models/text_encoders/qwen3vl_8b_int8_convrot.safetensors';
  encoder_sha text := '8bfd0f6e12abf2d2d697ecc888e5e90b0d6741d6708f05799f53afa560452e8f';
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
    RAISE EXCEPTION 'Pending Qwen-Image jobs must finish before their workflow pin changes';
  END IF;

  FOR current_profile IN
    SELECT * FROM "generation_model_profiles"
    WHERE "status" = 'active' AND "workflowKey" IN ('redqw21',
      'qwen-image-edit-img2img', 'qwen-image-edit-multi-reference', 'qwen-image-edit-multi-identity')
  LOOP
    expected_model := CASE current_profile."workflowKey"
      WHEN 'redqw21' THEN 'redqw21'
      WHEN 'qwen-image-edit-img2img' THEN 'redqw21-image-edit'
      WHEN 'qwen-image-edit-multi-reference' THEN 'redqw21-multi-reference'
      ELSE 'redqw21-multi-identity' END;
    workflow_version := CASE current_profile."workflowKey"
      WHEN 'redqw21' THEN 2
      WHEN 'qwen-image-edit-multi-reference' THEN 5
      ELSE 4 END;
    IF current_profile."mode" <> 'image' OR current_profile."runner" <> 'comfyui'
      OR current_profile."pipelineModel" IS DISTINCT FROM expected_model THEN
      RAISE EXCEPTION 'Unexpected Qwen-Image profile: %', current_profile."id";
    END IF;
    IF current_profile."runnerConfig"->>'textEncoderPath' = encoder_path
      AND current_profile."runnerConfig"->>'textEncoderSha256' = encoder_sha
      AND (
        (current_profile."runnerConfig"->>'workflowVersion')::integer > workflow_version
        OR ((current_profile."runnerConfig"->>'workflowVersion')::integer = workflow_version
          AND current_profile."runnerConfig"->>'textEncoderDevice' = 'cpu')
      ) THEN
      -- A later qualified MPS recipe owns its device/schedule. Replaying this
      -- historical CPU-encoder publication must not downgrade that workflow.
      CONTINUE;
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
      current_profile."profileKey" || '-int8-v' || next_version,
      current_profile."profileKey", current_profile."label", current_profile."mode",
      current_profile."runner", current_profile."pipelineModel", current_profile."workflowKey",
      current_profile."sourceModelPath", current_profile."convertedModelPath", current_profile."modelFormat",
      coalesce(current_profile."runnerConfig", '{}'::jsonb) || jsonb_build_object(
        'textEncoderPath', encoder_path, 'textEncoderSha256', encoder_sha,
        'textEncoderPrecision', 'int8_convrot', 'textEncoderDevice', 'cpu',
        'textEncoderRepository', 'Comfy-Org/Qwen-Image-2.1',
        'textEncoderRevision', 'cb504a4090723e43f17ad01cec0359490e2de613',
        'workflowVersion', workflow_version
      ),
      current_profile."defaultWidth", current_profile."defaultHeight", current_profile."allowedOrientations",
      current_profile."steps", current_profile."sampler", current_profile."scheduler", current_profile."cfgScale",
      current_profile."costMultiplier", current_profile."requiredEntitlement", current_profile."maxCount",
      current_profile."concurrencyLimit", current_profile."enabled", current_profile."rolloutPercent", next_version, 'active',
      jsonb_build_object('status', 'configuration_cutover_requires_live_probe',
        'source', '2026-09-30-qwen21-int8-text-encoder', 'previousProfileId', current_profile."id"),
      CURRENT_TIMESTAMP, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
    UPDATE "generation_model_profiles" SET "status" = 'archived',
      "archivedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = current_profile."id";
  END LOOP;
END $$;
COMMIT;
