-- SPEC: Align the existing explicit-only MiniMax H3 profile with workflow v3,
-- whose exact PyTorch-SDPA graph is routed to the isolated 8190 runner.
-- INTENT: RedGraft/LTX remains on workflow v1 and the 8188 split-attention
-- process. The measured SolAttn candidate was not materially faster at the
-- production 512x512 envelope, so this profile keeps exact attention.

BEGIN;

UPDATE "generation_model_profiles"
SET
  "runnerConfig" = jsonb_set(
    COALESCE("runnerConfig", '{}'::jsonb),
    '{workflowVersion}',
    '3'::jsonb,
    true
  ),
  "version" = 3,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" = 'seed-profile-video-h3-v1'
  AND "profileKey" = 'profile_video_h3_v1'
  AND "workflowKey" = 'minimax-h3-redcraft-i2v'
  AND "version" IN (1, 2)
  AND "runnerConfig" ->> 'workflowVersion' IN ('1', '2');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "generation_model_profiles"
    WHERE "id" = 'seed-profile-video-h3-v1'
      AND "profileKey" = 'profile_video_h3_v1'
      AND "workflowKey" = 'minimax-h3-redcraft-i2v'
      AND "runnerConfig" ->> 'workflowVersion' = '3'
      AND "version" = 3
      AND "enabled" = true
      AND "rolloutPercent" = 100
  ) THEN
    RAISE EXCEPTION 'MiniMax H3 profile did not converge to isolated exact-attention workflow v3';
  END IF;
END $$;

COMMIT;
