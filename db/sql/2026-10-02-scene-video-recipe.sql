-- Populate the missing source-only video recipe in an existing Main database.
-- Run only after verifying the target. Existing active Freeplay recipes retain
-- their authority. This configuration is not a pixel-quality qualification.
BEGIN;

INSERT INTO generation_recipes (
  id, "recipeKey", label, mode, "useCase", body, "negativeBase",
  "presetOrder", "safetyHints", "sampleMatrix", "dryRunSummary",
  version, status, "publishedAt", "createdAt", "updatedAt"
)
SELECT
  'seed-template-video-freeplay-v1', 'template_video_freeplay_default',
  'Source image video', 'video', 'freeplay',
  'Animate the supplied source image according to the requested motion. Preserve its subjects, objects, setting and framing unless the request changes them. Do not introduce a person unless requested.',
  'low quality, flicker, watermark, text',
  '["pose","mode"]'::jsonb, '{"disabledUntilFlag":"video_gen"}'::jsonb,
  '[{"freeplay":true,"sourceImage":true,"seconds":4}]'::jsonb,
  '{"status":"not_run","source":"seed_configuration_state"}'::jsonb,
  1, 'active', '2026-10-02T00:00:00.000Z'::timestamp, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
WHERE NOT EXISTS (
  SELECT 1 FROM generation_recipes
  WHERE mode = 'video' AND "useCase" = 'freeplay' AND status = 'active'
)
ON CONFLICT (id) DO NOTHING;

COMMIT;

SELECT id, "recipeKey", version, status
FROM generation_recipes
WHERE mode = 'video' AND "useCase" = 'freeplay' AND status = 'active';
