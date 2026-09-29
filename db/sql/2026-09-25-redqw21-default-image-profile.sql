-- SPEC: publish REDQW21 (Qwen-Image-2.1 finetune) as the next version of the
-- default image profile. One profile serves text-to-image and single-anchor
-- Character generation: the redqw21 workflow's image slot is optional
-- (onAbsent remove_target_node), so zero references = text-to-image.
-- INTENT: publish like Admin does — insert version N+1 and archive N. The old
-- row stays intact because completed Jobs and Attempts pin profile versions.
-- INVARIANT: idempotent; a default already on redqw21 is left alone. Premium
-- stays on RedMix3 (readiness migration-authority pins it).
-- Models: /Users/kk/ComfyUI-Shared/models/{diffusion_models/redqw21_bf16,
-- text_encoders/qwen3vl_8b_bf16, vae/qwen_image_2.1_vae_bf16}.safetensors,
-- served by the image ComfyUI runner (needs TextEncodeQwenImage21).

BEGIN;
LOCK TABLE "generation_model_profiles" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  current_profile record;
  active_count integer;
BEGIN
  SELECT count(*) INTO active_count FROM "generation_model_profiles"
  WHERE "profileKey" = 'profile_image_default_v1' AND "status" = 'active';
  IF active_count <> 1 THEN
    RAISE EXCEPTION 'Expected one active profile_image_default_v1, found %', active_count;
  END IF;

  SELECT * INTO STRICT current_profile FROM "generation_model_profiles"
  WHERE "profileKey" = 'profile_image_default_v1' AND "status" = 'active';
  IF current_profile."workflowKey" = 'redqw21' THEN
    RETURN;
  END IF;
  IF current_profile."mode" <> 'image'
    OR current_profile."runner" <> 'comfyui'
    OR current_profile."workflowKey" IS DISTINCT FROM 'redcraft-krea2-redmix3-txt2img'
    OR current_profile."requiredEntitlement" IS NOT NULL THEN
    RAISE EXCEPTION 'Active default image profile % has an unexpected route', current_profile."id";
  END IF;

  INSERT INTO "generation_model_profiles" (
    "id", "profileKey", "label", "mode", "runner", "pipelineModel", "workflowKey",
    "sourceModelPath", "convertedModelPath", "modelFormat", "runnerConfig",
    "defaultWidth", "defaultHeight", "allowedOrientations", "steps", "sampler",
    "scheduler", "cfgScale", "costMultiplier", "requiredEntitlement", "maxCount",
    "concurrencyLimit", "enabled", "rolloutPercent", "version", "status",
    "dryRunSummary", "publishedAt", "archivedAt", "createdAt", "updatedAt"
  ) VALUES (
    'profile-image-default-redqw21-v' || (current_profile."version" + 1),
    'profile_image_default_v1',
    'Default image · REDQW21 (Qwen-Image 2.1)',
    'image', 'comfyui', 'redqw21', 'redqw21',
    '/Users/kk/ComfyUI-Shared/models/diffusion_models/redqw21_bf16.safetensors',
    NULL, 'safetensors',
    jsonb_build_object(
      'apiModelId', 'redqw21',
      'baseModel', 'Qwen-Image 2.1',
      'workflowPath', '/Users/kk/code/idream/packages/gen/workflows/redqw21.json',
      'workflowVersion', 1,
      'diffusionModelPath', '/Users/kk/ComfyUI-Shared/models/diffusion_models/redqw21_bf16.safetensors',
      'diffusionModelSha256', '9830a9925759a4b69ea1346133d08917ec2390b8495ea7f0eb613f37e7c46647',
      'textEncoderPath', '/Users/kk/ComfyUI-Shared/models/text_encoders/qwen3vl_8b_bf16.safetensors',
      'vaePath', '/Users/kk/ComfyUI-Shared/models/vae/qwen_image_2.1_vae_bf16.safetensors',
      'civitaiModelId', 452459,
      'civitaiVersionId', 3353689,
      'precisionPolicy', 'bf16_resident_mps',
      'capabilities', jsonb_build_object(
        'textToImage', true,
        'referenceImages', true,
        'initImage', false,
        'stableSeed', true,
        'lora', false
      )
    ),
    current_profile."defaultWidth", current_profile."defaultHeight",
    current_profile."allowedOrientations",
    10, 'euler', 'simple', 1,
    current_profile."costMultiplier", NULL,
    current_profile."maxCount", current_profile."concurrencyLimit",
    true, 100, current_profile."version" + 1, 'active',
    jsonb_build_object(
      'status', 'configuration_cutover_requires_live_probe',
      'source', '2026-09-25-redqw21-default-image-profile',
      'previousProfileId', current_profile."id"
    ),
    CURRENT_TIMESTAMP, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  );

  UPDATE "generation_model_profiles"
  SET "status" = 'archived', "archivedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
  WHERE "id" = current_profile."id";
END $$;

COMMIT;
