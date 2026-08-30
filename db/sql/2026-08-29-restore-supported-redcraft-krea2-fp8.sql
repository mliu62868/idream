-- SPEC: Restore only the RedCraft Krea2 routes that keep the scaled-FP8
-- checkpoint resident and never point at a materialized whole-model BF16 copy.
-- INTENT: M1-M4 execute the decoded operation in BF16, but the 12 GiB FP8
-- checkpoint remains the serving/storage authority. Legacy missing-file routes
-- and the 24 GiB BF16 comparison candidate stay archived.

BEGIN;

DO $$
DECLARE
  target_count integer;
  active_job_count integer;
BEGIN
  SELECT count(*)
  INTO target_count
  FROM generation_model_profiles
  WHERE id IN (
    'seed-profile-character-image-single-identity-redcraft-v1',
    'seed-profile-sdcpp-redcraft-krea2-text-v1',
    'seed-profile-image-default-v1',
    'cms9mtnmd00014dl7fimo5kju',
    'seed-profile-image-premium-v1',
    'seed-profile-image-premium-v2',
    'seed-profile-redcraft-krea2-redmix3-v1'
  );

  IF target_count <> 7 THEN
    RAISE EXCEPTION 'expected exactly 7 known RedCraft Krea2 profiles, found %', target_count;
  END IF;

  SELECT count(*)
  INTO active_job_count
  FROM generation_jobs
  WHERE status IN ('queued', 'running')
    AND "profileId" IN (
      'seed-profile-character-image-single-identity-redcraft-v1',
      'cms9mtnmd00014dl7fimo5kju',
      'seed-profile-image-premium-v2'
    );

  IF active_job_count <> 0 THEN
    RAISE EXCEPTION 'cannot restore RedCraft Krea2 with % queued/running jobs', active_job_count;
  END IF;
END $$;

DO $$
DECLARE
  changed_count integer;
BEGIN
  UPDATE generation_model_profiles
  SET
    enabled = true,
    "rolloutPercent" = 100,
    status = 'active',
    "archivedAt" = NULL,
    "runnerConfig" = COALESCE("runnerConfig", '{}'::jsonb) || jsonb_build_object(
      'precisionPolicy', 'fp8_resident_bf16_transient_mps',
      'workflowVersion', CASE
        WHEN id = 'seed-profile-character-image-single-identity-redcraft-v1' THEN 4
        ELSE 1
      END
    ),
    "updatedAt" = CURRENT_TIMESTAMP
  WHERE id IN (
      'seed-profile-character-image-single-identity-redcraft-v1',
      'cms9mtnmd00014dl7fimo5kju',
      'seed-profile-image-premium-v2'
    )
    AND "sourceModelPath" = '/Users/kk/ComfyUI-Shared/models/diffusion_models/Krea2RedMix3.0-fp8-scaled-ComfyUI.safetensors'
    AND "convertedModelPath" IS NULL
    AND "pipelineModel" IN (
      'redcraft-krea2-redmix3-fp8',
      'redcraft-krea2-identity-edit'
    );

  GET DIAGNOSTICS changed_count = ROW_COUNT;
  IF changed_count <> 3 THEN
    RAISE EXCEPTION 'expected to restore exactly 3 supported FP8 profiles, updated %', changed_count;
  END IF;
END $$;

DO $$
DECLARE
  invalid_supported integer;
  invalid_unsupported integer;
BEGIN
  SELECT count(*)
  INTO invalid_supported
  FROM generation_model_profiles
  WHERE id IN (
      'seed-profile-character-image-single-identity-redcraft-v1',
      'cms9mtnmd00014dl7fimo5kju',
      'seed-profile-image-premium-v2'
    )
    AND (
      enabled <> true
      OR "rolloutPercent" <> 100
      OR status <> 'active'
      OR "archivedAt" IS NOT NULL
      OR "convertedModelPath" IS NOT NULL
      OR "runnerConfig" ->> 'precisionPolicy' <> 'fp8_resident_bf16_transient_mps'
    );

  SELECT count(*)
  INTO invalid_unsupported
  FROM generation_model_profiles
  WHERE id IN (
      'seed-profile-sdcpp-redcraft-krea2-text-v1',
      'seed-profile-image-default-v1',
      'seed-profile-image-premium-v1',
      'seed-profile-redcraft-krea2-redmix3-v1'
    )
    AND (
      enabled <> false
      OR "rolloutPercent" <> 0
      OR status <> 'archived'
      OR "archivedAt" IS NULL
    );

  IF invalid_supported <> 0 THEN
    RAISE EXCEPTION 'supported FP8 terminal assertion failed for % profiles', invalid_supported;
  END IF;
  IF invalid_unsupported <> 0 THEN
    RAISE EXCEPTION 'unsupported RedCraft terminal assertion failed for % profiles', invalid_unsupported;
  END IF;
END $$;

COMMIT;
