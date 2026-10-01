-- SPEC: retire Rapid-AIO v19 from every image-edit profile. The existing
-- workflow keys remain caller contracts; their new versions load only V2.
-- Execute after installing and verifying 452459@3370753/file3258921 and its
-- BF16 conversion, with Generation queues paused and drained.
-- INVARIANT: completed Jobs/Attempts retain their immutable historical profile
-- rows. Publish N+1 and archive N; never silently rewrite a pinned model.
BEGIN;
LOCK TABLE "generation_model_profiles" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  current_profile record;
  model_id text;
  workflow_version integer;
  next_version integer;
  model_root text := '/Users/kk/ComfyUI-Shared/models';
BEGIN
  FOR current_profile IN
    SELECT * FROM "generation_model_profiles"
    WHERE "status" = 'active' AND "workflowKey" IN (
      'qwen-image-edit-img2img',
      'qwen-image-edit-multi-reference',
      'qwen-image-edit-multi-identity'
    )
  LOOP
    model_id := CASE current_profile."workflowKey"
      WHEN 'qwen-image-edit-img2img' THEN 'redqw21-image-edit'
      WHEN 'qwen-image-edit-multi-reference' THEN 'redqw21-multi-reference'
      ELSE 'redqw21-multi-identity'
    END;
    workflow_version := CASE current_profile."workflowKey"
      WHEN 'qwen-image-edit-multi-reference' THEN 4 ELSE 3 END;

    IF current_profile."pipelineModel" = model_id
      AND current_profile."runnerConfig"->>'civitaiVersionId' = '3370753'
      -- A later encoder/workflow publication must never be downgraded on replay.
      AND (current_profile."runnerConfig"->>'workflowVersion')::integer >= workflow_version THEN
      CONTINUE;
    END IF;
    IF current_profile."mode" <> 'image' OR current_profile."runner" <> 'comfyui'
      OR current_profile."pipelineModel" <> 'qwen-image-edit' THEN
      RAISE EXCEPTION 'Unexpected image-edit profile route: %', current_profile."id";
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
      current_profile."profileKey" || '-redqw21-v' || next_version,
      current_profile."profileKey", replace(current_profile."label", 'Qwen-Edit', 'REDQW21 V2'),
      'image', 'comfyui', model_id, current_profile."workflowKey",
      model_root || '/diffusion_models/redqw21_unlocked_v2_fp8.safetensors',
      model_root || '/diffusion_models/redqw21_unlocked_v2_bf16.safetensors', 'safetensors',
      coalesce(current_profile."runnerConfig", '{}'::jsonb) || jsonb_build_object(
        'apiModelId', model_id, 'baseModel', 'Qwen-Image 2.1',
        'civitaiModelId', 452459, 'civitaiVersionId', 3370753, 'civitaiFileId', 3258921,
        'sourceModelSha256', '0efb5aeb2b372025042e320c2e35c66ec6681ef54ad5de88a652ab19cc63ad92',
        'diffusionModelPath', model_root || '/diffusion_models/redqw21_unlocked_v2_bf16.safetensors',
        'textEncoderPath', model_root || '/text_encoders/qwen3vl_8b_bf16.safetensors',
        'vaePath', model_root || '/vae/qwen_image_2.1_vae_bf16.safetensors',
        'workflowPath', '/Users/kk/code/idream/packages/gen/workflows/' || current_profile."workflowKey" || '.json',
        'workflowVersion', workflow_version, 'precisionPolicy', 'bf16_resident_mps'
      ),
      current_profile."defaultWidth", current_profile."defaultHeight", current_profile."allowedOrientations",
      CASE WHEN current_profile."workflowKey" = 'qwen-image-edit-img2img' THEN 10 ELSE 16 END,
      'euler', 'simple',
      CASE WHEN current_profile."workflowKey" = 'qwen-image-edit-img2img' THEN 1 ELSE 2 END,
      current_profile."costMultiplier", current_profile."requiredEntitlement",
      current_profile."maxCount", current_profile."concurrencyLimit",
      current_profile."enabled", current_profile."rolloutPercent", next_version, 'active',
      jsonb_build_object('status', 'configuration_cutover_requires_live_probe',
        'source', '2026-09-30-redqw21-v2-image-edit-retire-rapid-aio', 'previousProfileId', current_profile."id"),
      CURRENT_TIMESTAMP, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
    UPDATE "generation_model_profiles" SET "status" = 'archived',
      "archivedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = current_profile."id";
  END LOOP;

  IF EXISTS (SELECT 1 FROM "generation_model_profiles" WHERE "status" = 'active'
    AND ("pipelineModel" = 'qwen-image-edit'
      OR coalesce("sourceModelPath", '') LIKE '%Qwen-Rapid-AIO-NSFW-v19%'
      OR coalesce("convertedModelPath", '') LIKE '%Qwen-Rapid-AIO-NSFW-v19%')) THEN
    RAISE EXCEPTION 'An active profile still references retired Rapid-AIO v19';
  END IF;
END $$;
COMMIT;
