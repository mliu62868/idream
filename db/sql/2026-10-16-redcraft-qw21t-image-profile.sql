-- SPEC: publish the author's eight-step first pass as RedCraft profile/workflow
-- version 2. Archive the exact six-step v1 without rewriting its parameters.
-- Quiesce admission/workers before replacing the descriptor and applying SQL.
-- Existing defaults, other profiles, Jobs and Attempts are left intact.
-- The FineView filename is the exact RedCraft INT8 asset, not another model:
-- Civitai model958009 / version3407259 / file3299030, SHA256 pinned below.
-- Run on the authorized development/test database after installing the assets
-- and packages/gen/workflows/redcraft-qw21t.json on the generation host.
BEGIN;
LOCK TABLE generation_model_profiles IN SHARE ROW EXCLUSIVE MODE;
DO $$
DECLARE
  profile_count integer;
  previous_profile generation_model_profiles%ROWTYPE;
  expected_config jsonb := '{
    "apiModelId":"redcraft-qw21t",
    "baseModel":"Qwen-Image 2.1",
    "civitaiModelId":958009,"civitaiVersionId":3407259,"civitaiFileId":3299030,
    "diffusionModelPath":"/Users/kk/ComfyUI-Shared/models/diffusion_models/fineview_qw21_turbo_fixed_int8.safetensors",
    "diffusionModelSha256":"712b44d2a79b30ed1aa11f19fc4e2cd0f1f46a43dc3bde5d6fe2a07e36b68f0f",
    "textEncoderPath":"/Users/kk/ComfyUI-Shared/models/text_encoders/qwen3vl_8b_int8_convrot.safetensors",
    "textEncoderSha256":"8bfd0f6e12abf2d2d697ecc888e5e90b0d6741d6708f05799f53afa560452e8f",
    "textEncoderRepository":"Comfy-Org/Qwen-Image-2.1",
    "textEncoderRevision":"cb504a4090723e43f17ad01cec0359490e2de613",
    "textEncoderPrecision":"int8_convrot","textEncoderDevice":"mps","conditioningPasses":1,
    "vaePath":"/Users/kk/ComfyUI-Shared/models/vae/texture_fix_vae_for_qwen_image_2.1_bf16.safetensors",
    "vaeSha256":"36f56608b02077a50a08ea3dbcdb88351298ceba49948f41f9f87186378e6908",
    "vaeTemporalPadding":"torch_cat",
    "workflowPath":"/Users/kk/code/idream/packages/gen/workflows/redcraft-qw21t.json",
    "workflowVersion":2,"precisionPolicy":"int8_exact_bf16_resident_mps",
    "publicSelection":{"surface":"generator_image_edit","explicitOnly":true},
    "capabilities":{"textToImage":true,"stableSeed":true,"referenceImages":true,"initImage":true,"lora":false}
  }'::jsonb;
BEGIN
  IF EXISTS (
    SELECT 1 FROM generation_jobs job
    WHERE job.status IN ('queued','moderating_input','running','moderating_output')
      AND (job.model = 'redcraft-qw21t'
        OR job.controls->>'workflowKey' = 'redcraft-qw21t'
        OR job."profileId" = 'image-redcraft-qw21t'
        OR job."profileId" IN (SELECT id FROM generation_model_profiles WHERE "profileKey" = 'image-redcraft-qw21t'))
  ) THEN
    RAISE EXCEPTION 'Pending RedCraft jobs must finish before eight-step publication';
  END IF;

  -- Recognize only the exact previously published v1; an operator's custom
  -- parameters must not silently become the author recipe.
  SELECT * INTO previous_profile FROM generation_model_profiles
    WHERE "profileKey" = 'image-redcraft-qw21t' AND version = 1;
  IF FOUND AND (
    previous_profile."pipelineModel" IS DISTINCT FROM 'redcraft-qw21t'
    OR previous_profile."workflowKey" IS DISTINCT FROM 'redcraft-qw21t'
    OR previous_profile.mode IS DISTINCT FROM 'image'
    OR previous_profile.runner IS DISTINCT FROM 'comfyui'
    OR previous_profile.steps IS DISTINCT FROM 6
    OR previous_profile.sampler IS DISTINCT FROM 'euler'
    OR previous_profile.scheduler IS DISTINCT FROM 'qwen21_six_step_sigmas'
    OR previous_profile."cfgScale" IS DISTINCT FROM 1
    OR previous_profile."sourceModelPath" IS DISTINCT FROM expected_config->>'diffusionModelPath'
    OR previous_profile."convertedModelPath" IS NOT NULL
    OR previous_profile."modelFormat" IS DISTINCT FROM 'safetensors'
    OR previous_profile."defaultWidth" IS DISTINCT FROM 832 OR previous_profile."defaultHeight" IS DISTINCT FROM 1024
    OR previous_profile."allowedOrientations" IS DISTINCT FROM '["4:5"]'::jsonb
    OR previous_profile."costMultiplier" IS DISTINCT FROM 1.5 OR previous_profile."requiredEntitlement" IS NOT NULL
    OR previous_profile."maxCount" IS DISTINCT FROM 1 OR previous_profile."concurrencyLimit" IS DISTINCT FROM 1
    OR NOT previous_profile.enabled OR previous_profile."rolloutPercent" IS DISTINCT FROM 100
    OR previous_profile."runnerConfig" IS DISTINCT FROM (expected_config || '{"workflowVersion":1}'::jsonb)
    OR previous_profile.status NOT IN ('active','archived')
  ) THEN
    RAISE EXCEPTION 'Existing RedCraft QW21T profile differs from the exact released configuration; no update performed';
  END IF;
  IF EXISTS (SELECT 1 FROM generation_model_profiles WHERE "profileKey" = 'image-redcraft-qw21t' AND version NOT IN (1,2))
    OR EXISTS (SELECT version FROM generation_model_profiles WHERE "profileKey" = 'image-redcraft-qw21t' GROUP BY version HAVING count(*) > 1)
  THEN
    RAISE EXCEPTION 'Existing RedCraft QW21T profile differs from the exact released configuration; no update performed';
  END IF;
  SELECT count(*) INTO profile_count FROM generation_model_profiles
    WHERE "profileKey" = 'image-redcraft-qw21t' AND version = 2;
  IF profile_count = 0 THEN
    INSERT INTO generation_model_profiles (
      id,"profileKey",label,mode,runner,"pipelineModel","workflowKey",
      "sourceModelPath","modelFormat","runnerConfig","defaultWidth","defaultHeight",
      "allowedOrientations",steps,sampler,scheduler,"cfgScale","costMultiplier",
      "maxCount","concurrencyLimit",enabled,"rolloutPercent",version,status,
      "dryRunSummary","publishedAt","updatedAt"
    ) VALUES (
      'seed-profile-image-redcraft-qw21t-v2','image-redcraft-qw21t','RedCraft 3.0 · QW21 Fixed',
      'image','comfyui','redcraft-qw21t','redcraft-qw21t',
      expected_config->>'diffusionModelPath','safetensors',expected_config,832,1024,
      '["4:5"]'::jsonb,8,'er_sde','simple',1,1.5,
      1,1,true,100,2,'active',
      '{"status":"not_run","source":"2026-10-16-redcraft-qw21t-image-profile","notes":"Configuration publication; live smoke evidence is recorded separately."}'::jsonb,
      CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
    );
  ELSIF profile_count <> 1 OR NOT EXISTS (
    SELECT 1 FROM generation_model_profiles WHERE "profileKey" = 'image-redcraft-qw21t'
      AND mode = 'image' AND runner = 'comfyui' AND "pipelineModel" = 'redcraft-qw21t'
      AND "workflowKey" = 'redcraft-qw21t' AND version = 2 AND status = 'active'
      AND enabled AND "rolloutPercent" = 100 AND "runnerConfig" = expected_config
      AND "sourceModelPath" = expected_config->>'diffusionModelPath'
      AND "modelFormat" = 'safetensors' AND "convertedModelPath" IS NULL
      AND "defaultWidth" = 832 AND "defaultHeight" = 1024 AND "allowedOrientations" = '["4:5"]'::jsonb
      AND steps = 8 AND sampler = 'er_sde' AND scheduler = 'simple' AND "cfgScale" = 1
      AND "maxCount" = 1 AND "concurrencyLimit" = 1 AND "costMultiplier" = 1.5
      AND "requiredEntitlement" IS NULL AND "publishedAt" IS NOT NULL AND "archivedAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'Existing RedCraft QW21T profile differs from the exact released configuration; no update performed';
  END IF;
  UPDATE generation_model_profiles SET status = 'archived', "archivedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "profileKey" = 'image-redcraft-qw21t' AND version = 1 AND status = 'active';
END $$;
COMMIT;
