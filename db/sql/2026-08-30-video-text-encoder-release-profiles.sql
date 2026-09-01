-- SPEC: Video workflow v2/v4 releases CPU-side text encoders after every
-- conditioning branch completes, while retaining MPS diffusion and VAE models.
-- INTENT: Profile and workflow pins advance together so new jobs cannot execute
-- the changed graph under an old immutable authority.

BEGIN;

UPDATE "generation_model_profiles"
SET
  "runnerConfig" = jsonb_set(
    COALESCE("runnerConfig", '{}'::jsonb),
    '{workflowVersion}',
    '2'::jsonb,
    true
  ),
  "version" = 2,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" = 'seed-profile-video-redgraft-ltx25-v1'
  AND "profileKey" = 'profile_video_redgraft_ltx25_v1'
  AND "workflowKey" = 'redgraft-ltx25-i2v'
  AND "version" = 1
  AND "runnerConfig" ->> 'workflowVersion' = '1';

UPDATE "generation_model_profiles"
SET
  "runnerConfig" = jsonb_set(
    COALESCE("runnerConfig", '{}'::jsonb),
    '{workflowVersion}',
    '4'::jsonb,
    true
  ),
  "version" = 4,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" = 'seed-profile-video-h3-v1'
  AND "profileKey" = 'profile_video_h3_v1'
  AND "workflowKey" = 'minimax-h3-redcraft-i2v'
  AND "version" = 3
  AND "runnerConfig" ->> 'workflowVersion' = '3';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "generation_model_profiles"
    WHERE "id" = 'seed-profile-video-redgraft-ltx25-v1'
      AND "profileKey" = 'profile_video_redgraft_ltx25_v1'
      AND "workflowKey" = 'redgraft-ltx25-i2v'
      AND "runnerConfig" ->> 'workflowVersion' = '2'
      AND "version" = 2
      AND "enabled" = true
      AND "status" = 'active'
      AND "rolloutPercent" = 100
  ) THEN
    RAISE EXCEPTION 'RedGraft profile did not converge to workflow/profile v2';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "generation_model_profiles"
    WHERE "id" = 'seed-profile-video-h3-v1'
      AND "profileKey" = 'profile_video_h3_v1'
      AND "workflowKey" = 'minimax-h3-redcraft-i2v'
      AND "runnerConfig" ->> 'workflowVersion' = '4'
      AND "version" = 4
      AND "enabled" = true
      AND "status" = 'active'
      AND "rolloutPercent" = 100
  ) THEN
    RAISE EXCEPTION 'MiniMax H3 profile did not converge to workflow/profile v4';
  END IF;
END $$;

COMMIT;
