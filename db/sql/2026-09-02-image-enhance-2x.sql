-- SPEC: Publish the proven native 2× pixel-enhancement route. No historical
-- profile/recipe, Job, Attempt, or source image is rewritten by this rollout.
BEGIN;
LOCK TABLE generation_model_profiles, generation_recipes IN SHARE ROW EXCLUSIVE MODE;
DO $$
DECLARE profile_count integer; recipe_count integer;
BEGIN
  SELECT count(*) INTO profile_count FROM generation_model_profiles WHERE "profileKey" = 'image-enhance-2x';
  IF profile_count = 0 THEN
    INSERT INTO generation_model_profiles
      (id, "profileKey", label, mode, runner, "pipelineModel", "workflowKey", "sourceModelPath", "modelFormat", "runnerConfig", "defaultWidth", "defaultHeight", "allowedOrientations", steps, sampler, scheduler, "cfgScale", "costMultiplier", "maxCount", status, enabled, "rolloutPercent", "publishedAt", "dryRunSummary", "updatedAt")
    VALUES
      ('seed-profile-image-enhance-2x-v1', 'image-enhance-2x', 'Enhance 2×', 'image', 'comfyui', 'realesrgan-x2plus-enhance', 'realesrgan-x2plus-enhance', 'upscale_models/RealESRGAN_x2plus.pth', 'pytorch',
       '{"workflowVersion":1,"publicSelection":{"surface":"gallery_enhance","explicitOnly":true},"capabilities":{"textToImage":false,"initImage":true,"referenceImages":true,"stableSeed":false,"lora":false},"enhancement":{"scale":2},"modelAsset":{"filename":"RealESRGAN_x2plus.pth","sha256":"49fafd45f8fd7aa8d31ab2a22d14d91b536c34494a5cfe31eb5d89c2fa266abb","source":"https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.1/RealESRGAN_x2plus.pth","license":"BSD-3-Clause"}}'::jsonb,
       1024, 1024, '["original"]'::jsonb, 1, 'native', 'native', 1, 1, 1, 'active', true, 100, '2026-09-02T21:37:19.133Z',
       '{"status":"runtime_verified_mps","source":"native_realesrgan_x2plus","sourceWidth":512,"sourceHeight":640,"width":1024,"height":1280,"elapsedMs":3260,"sourceSha256":"f5080a1fb7c9ff5db42fd8ed3fb3c1c3a068090e77e2e395424425133d6bdfe1","outputSha256":"4943ceb81006bfb4986b526578085309eece0f6f2dc38297c2380d2be7d8a18b"}'::jsonb, CURRENT_TIMESTAMP);
  ELSIF profile_count <> 1 OR NOT EXISTS (
    SELECT 1 FROM generation_model_profiles WHERE "profileKey" = 'image-enhance-2x'
      AND version = 1 AND status = 'active' AND enabled AND "rolloutPercent" = 100
      AND mode = 'image' AND runner = 'comfyui' AND "workflowKey" = 'realesrgan-x2plus-enhance'
      AND "pipelineModel" = 'realesrgan-x2plus-enhance' AND "maxCount" = 1 AND "costMultiplier" = 1
      AND "allowedOrientations" = '["original"]'::jsonb
      AND "runnerConfig" @> '{"workflowVersion":1,"publicSelection":{"surface":"gallery_enhance","explicitOnly":true},"enhancement":{"scale":2},"capabilities":{"textToImage":false,"initImage":true,"referenceImages":true},"modelAsset":{"sha256":"49fafd45f8fd7aa8d31ab2a22d14d91b536c34494a5cfe31eb5d89c2fa266abb"}}'::jsonb
      AND "publishedAt" IS NOT NULL AND "archivedAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'Existing Enhance profile differs from the exact released authority; no update performed';
  END IF;
  SELECT count(*) INTO recipe_count FROM generation_recipes WHERE "recipeKey" = 'image-enhance-2x';
  IF recipe_count = 0 THEN
    INSERT INTO generation_recipes (id, "recipeKey", label, mode, "useCase", body, "presetOrder", "safetyHints", "sampleMatrix", status, "publishedAt", "updatedAt")
    VALUES ('seed-recipe-image-enhance-2x-v1', 'image-enhance-2x', 'Enhance 2×', 'image', 'enhance', 'Enhance the source image at its original aspect ratio by exactly 2×.', '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, 'active', '2026-09-02T21:37:19.133Z', CURRENT_TIMESTAMP);
  ELSIF recipe_count <> 1 OR NOT EXISTS (
    SELECT 1 FROM generation_recipes WHERE "recipeKey" = 'image-enhance-2x' AND version = 1 AND status = 'active'
      AND mode = 'image' AND "useCase" = 'enhance' AND body = 'Enhance the source image at its original aspect ratio by exactly 2×.'
      AND "publishedAt" IS NOT NULL AND "archivedAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'Existing Enhance recipe differs from the exact released authority; no update performed';
  END IF;
END $$;
COMMIT;
