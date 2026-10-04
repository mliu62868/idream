-- SPEC: retire all executable Krea profiles; publish Qwen replacements under
-- existing profile keys so callers, entitlements and billing retain contracts.
-- INVARIANT: historical rows and completed Job/Attempt pins are preserved.
-- No model files are deleted. Run on the authorized development/test database.
BEGIN;
LOCK TABLE "generation_model_profiles", "generation_jobs", "generation_attempts"
  IN SHARE ROW EXCLUSIVE MODE;
DO $$
DECLARE
  previous_profile "generation_model_profiles"%ROWTYPE;
  replacement "generation_model_profiles"%ROWTYPE;
  published "generation_model_profiles"%ROWTYPE;
  next_version integer;
BEGIN
  IF EXISTS (
    SELECT 1 FROM "generation_attempts"
    WHERE "status" IN ('queued', 'running') AND coalesce("workflowKey", '') ILIKE '%krea%'
  ) OR EXISTS (
    SELECT 1 FROM "generation_jobs" j
    LEFT JOIN "generation_model_profiles" p
      ON p."profileKey" = j."profileId" AND p."version" = j."profileVersion"
    WHERE j."status" IN ('queued', 'running')
      AND concat(j."model", p."pipelineModel", p."workflowKey") ILIKE '%krea%'
  ) THEN
    RAISE EXCEPTION 'Drain Krea jobs and attempts before retirement';
  END IF;

  FOR previous_profile IN SELECT * FROM "generation_model_profiles"
    WHERE "status" = 'active'
      AND concat("pipelineModel", "workflowKey", "sourceModelPath", "convertedModelPath", "runnerConfig"::text) ILIKE '%krea%'
  LOOP
    IF previous_profile."profileKey" NOT IN (
      'profile_image_premium_v1', 'character-image-single-identity-redcraft'
    ) THEN
      RAISE EXCEPTION 'Unexpected active Krea profile: %', previous_profile."profileKey";
    END IF;
    SELECT * INTO STRICT replacement FROM "generation_model_profiles"
      WHERE "profileKey" = CASE previous_profile."profileKey"
        WHEN 'profile_image_premium_v1' THEN 'profile_image_default_v1'
        ELSE 'chat-image-edit' END
        AND "status" = 'active' AND "enabled" AND "runner" = 'comfyui'
        AND "pipelineModel" = CASE previous_profile."profileKey"
          WHEN 'profile_image_premium_v1' THEN 'redqw21' ELSE 'redqw21-image-edit' END;
    SELECT max("version") + 1 INTO next_version FROM "generation_model_profiles"
      WHERE "profileKey" = previous_profile."profileKey";
    -- Copy the validated Qwen model/graph configuration, retaining the old
    -- entry's access, price, count, rollout and caller-visible profile key.
    SELECT * INTO published FROM jsonb_populate_record(
      NULL::"generation_model_profiles", to_jsonb(replacement) || jsonb_build_object(
        'id', previous_profile."profileKey" || '-qwen-retired-krea-v' || next_version,
        'profileKey', previous_profile."profileKey",
        'label', CASE previous_profile."profileKey"
          WHEN 'profile_image_premium_v1' THEN 'Premium image · REDQW21 (Qwen-Image 2.1)'
          ELSE 'Character Single-Reference Identity (REDQW21 V2)' END,
        'runnerConfig', replacement."runnerConfig" || CASE previous_profile."profileKey"
          WHEN 'character-image-single-identity-redcraft' THEN jsonb_build_object('publicSelection', jsonb_build_object('explicitOnly', true),
            'templateIntent', 'single_face_reference_identity_restaging')
          ELSE '{}'::jsonb END,
        'defaultWidth', previous_profile."defaultWidth",
        'defaultHeight', previous_profile."defaultHeight",
        'allowedOrientations', previous_profile."allowedOrientations",
        'costMultiplier', previous_profile."costMultiplier",
        'requiredEntitlement', previous_profile."requiredEntitlement",
        'maxCount', previous_profile."maxCount",
        'concurrencyLimit', previous_profile."concurrencyLimit",
        'enabled', previous_profile."enabled", 'rolloutPercent', previous_profile."rolloutPercent",
        'version', next_version, 'status', 'active',
        'dryRunSummary', jsonb_build_object('status', 'configuration_cutover_requires_live_probe',
          'source', '2026-10-04-retire-krea-image-profiles',
          'previousProfileId', previous_profile."id", 'replacementProfileId', replacement."id"),
        'publishedAt', CURRENT_TIMESTAMP, 'archivedAt', NULL,
        'createdAt', CURRENT_TIMESTAMP, 'updatedAt', CURRENT_TIMESTAMP
      )
    );
    INSERT INTO "generation_model_profiles" SELECT published.*;
    UPDATE "generation_model_profiles" SET "status" = 'archived',
      "archivedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = previous_profile."id";
  END LOOP;
  -- Disable unpublished candidates as well; archived history is left intact.
  UPDATE "generation_model_profiles" SET "enabled" = false, "rolloutPercent" = 0,
    "status" = 'archived', "archivedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "status" <> 'archived'
      AND concat("pipelineModel", "workflowKey", "sourceModelPath", "convertedModelPath", "runnerConfig"::text) ILIKE '%krea%';
  IF EXISTS (SELECT 1 FROM "generation_model_profiles" WHERE "status" <> 'archived'
    AND concat("pipelineModel", "workflowKey", "sourceModelPath", "convertedModelPath", "runnerConfig"::text) ILIKE '%krea%') THEN
    RAISE EXCEPTION 'Executable Krea profile survived retirement';
  END IF;
END $$;
COMMIT;
