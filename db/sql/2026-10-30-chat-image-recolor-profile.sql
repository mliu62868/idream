-- Add only the owner-confirmed, source-only CPU recolor route. This is data
-- configuration, not evidence that an installation passed a live generation.
-- Run only against the task's verified development database. No existing profile,
-- Job, attachment, balance, or ledger row is changed; repeat execution is a no-op.
BEGIN;
INSERT INTO generation_model_profiles (
  id, "profileKey", label, mode, runner, "pipelineModel", "workflowKey",
  "modelFormat", "runnerConfig", "defaultWidth", "defaultHeight", "allowedOrientations",
  steps, sampler, scheduler, "cfgScale", "costMultiplier", "maxCount",
  enabled, "rolloutPercent", version, status, "dryRunSummary", "publishedAt", "updatedAt"
)
SELECT
  'seed-profile-chat-image-recolor-v1', 'chat-image-recolor', 'Local image recolor',
  'image', 'local-image', 'local-recolor', 'local-recolor', 'native',
  '{"workflowVersion":1,"publicSelection":{"surface":"chat_image_recolor","explicitOnly":true},"capabilities":{"textToImage":false,"initImage":true,"referenceImages":true,"stableSeed":false,"lora":false}}'::jsonb,
  2048, 2048, '["original"]'::jsonb,
  1, 'native', 'native', 1, 0, 1, true, 100, 1, 'active',
  '{"status":"not_run","source":"explicit_configuration_cutover","notes":"Deterministic masked recoloring; only an owner-confirmed mask can admit this route."}'::jsonb,
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
WHERE NOT EXISTS (
  SELECT 1 FROM generation_model_profiles WHERE "profileKey" = 'chat-image-recolor'
)
ON CONFLICT DO NOTHING;
COMMIT;
SELECT id, "profileKey", version, runner, "workflowKey", "costMultiplier", status, enabled,
  "allowedOrientations", "runnerConfig"
FROM generation_model_profiles WHERE "profileKey" = 'chat-image-recolor';
