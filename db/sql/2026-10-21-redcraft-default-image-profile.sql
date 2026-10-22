-- Publish RedCraft/FineView six-step er_sde/simple as workflow v3 and default image route.
-- Quiesce admission/workers before replacing the descriptor and applying SQL.
-- Run only on the authorized development/test database. Replays are no-ops;
-- unexpected configuration or pending affected Jobs abort the entire transaction.
-- Historical profiles/Jobs/Attempts remain intact; multi-reference routes are unchanged.
BEGIN;
LOCK TABLE generation_model_profiles IN SHARE ROW EXCLUSIVE MODE;
DO $$
DECLARE
  profile_count integer;
  previous_profile generation_model_profiles%ROWTYPE;
  default_profile generation_model_profiles%ROWTYPE;
  current_workflow_path text;
  next_version integer;
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
    "workflowVersion":3,"precisionPolicy":"int8_exact_bf16_resident_mps",
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
        OR job."profileId" = 'profile_image_default_v1'
        OR job."profileId" IN (SELECT id FROM generation_model_profiles WHERE "profileKey" IN ('image-redcraft-qw21t','profile_image_default_v1')))
  ) THEN
    RAISE EXCEPTION 'Pending RedCraft jobs must finish before six-step default publication';
  END IF;

  SELECT count(*) INTO profile_count FROM generation_model_profiles
    WHERE "profileKey" = 'profile_image_default_v1' AND status = 'active';
  IF profile_count <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one active default image profile, found %', profile_count;
  END IF;
  SELECT * INTO STRICT default_profile FROM generation_model_profiles
    WHERE "profileKey" = 'profile_image_default_v1' AND status = 'active';
  IF default_profile.mode IS DISTINCT FROM 'image' OR default_profile.runner IS DISTINCT FROM 'comfyui'
    OR default_profile."workflowKey" IS NULL
    OR default_profile."workflowKey" NOT IN ('redqw21','redcraft-qw21t')
    OR default_profile."pipelineModel" IS DISTINCT FROM default_profile."workflowKey"
  THEN RAISE EXCEPTION 'Active default image profile has an unexpected route'; END IF;

  -- The active default pins the deployment directory; a developer's checkout
  -- is not a release identity. Only this path varies: every model digest,
  -- recipe and other profile must still match the exact released configuration.
  current_workflow_path := default_profile."runnerConfig"->>'workflowPath';
  IF current_workflow_path IS NULL
    OR current_workflow_path !~ '^/.+/packages/gen/workflows/(redqw21|redcraft-qw21t)\.json$'
    OR current_workflow_path ~ '/\.{1,2}/'
    OR current_workflow_path NOT LIKE '%/' || default_profile."workflowKey" || '.json'
  THEN RAISE EXCEPTION 'Active default image profile has an invalid workflow path'; END IF;
  expected_config := jsonb_set(expected_config, '{workflowPath}', to_jsonb(
    regexp_replace(current_workflow_path, '(redqw21|redcraft-qw21t)\.json$', 'redcraft-qw21t.json')
  ));

  -- Historical recipes remain immutable, including the original Euler v1.
  FOR previous_profile IN SELECT * FROM generation_model_profiles
    WHERE "profileKey" = 'image-redcraft-qw21t' AND version IN (1,2)
  LOOP
    IF previous_profile."pipelineModel" IS DISTINCT FROM 'redcraft-qw21t'
      OR previous_profile."workflowKey" IS DISTINCT FROM 'redcraft-qw21t'
      OR previous_profile.mode IS DISTINCT FROM 'image'
      OR previous_profile.runner IS DISTINCT FROM 'comfyui'
      OR previous_profile.steps IS DISTINCT FROM (CASE previous_profile.version WHEN 1 THEN 6 ELSE 8 END)
      OR previous_profile.sampler IS DISTINCT FROM (CASE previous_profile.version WHEN 1 THEN 'euler' ELSE 'er_sde' END)
      OR previous_profile.scheduler IS DISTINCT FROM (CASE previous_profile.version WHEN 1 THEN 'qwen21_six_step_sigmas' ELSE 'simple' END)
      OR previous_profile."cfgScale" IS DISTINCT FROM 1
      OR previous_profile."sourceModelPath" IS DISTINCT FROM expected_config->>'diffusionModelPath'
      OR previous_profile."convertedModelPath" IS NOT NULL
      OR previous_profile."modelFormat" IS DISTINCT FROM 'safetensors'
      OR previous_profile."defaultWidth" IS DISTINCT FROM 832 OR previous_profile."defaultHeight" IS DISTINCT FROM 1024
      OR previous_profile."allowedOrientations" IS DISTINCT FROM '["4:5"]'::jsonb
      OR previous_profile."costMultiplier" IS DISTINCT FROM 1.5 OR previous_profile."requiredEntitlement" IS NOT NULL
      OR previous_profile."maxCount" IS DISTINCT FROM 1 OR previous_profile."concurrencyLimit" IS DISTINCT FROM 1
      OR NOT previous_profile.enabled OR previous_profile."rolloutPercent" IS DISTINCT FROM 100
      OR previous_profile."runnerConfig" IS DISTINCT FROM (expected_config || jsonb_build_object('workflowVersion',previous_profile.version))
      OR previous_profile.status NOT IN ('active','archived')
    THEN
      RAISE EXCEPTION 'Existing RedCraft QW21T profile differs from the exact released configuration; no update performed';
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM generation_model_profiles WHERE "profileKey" = 'image-redcraft-qw21t' AND version NOT IN (1,2,3))
    OR EXISTS (SELECT version FROM generation_model_profiles WHERE "profileKey" = 'image-redcraft-qw21t' GROUP BY version HAVING count(*) > 1)
  THEN
    RAISE EXCEPTION 'Existing RedCraft QW21T profile differs from the exact released configuration; no update performed';
  END IF;
  SELECT count(*) INTO profile_count FROM generation_model_profiles
    WHERE "profileKey" = 'image-redcraft-qw21t' AND version = 3;
  IF profile_count = 0 THEN
    INSERT INTO generation_model_profiles (
      id,"profileKey",label,mode,runner,"pipelineModel","workflowKey",
      "sourceModelPath","modelFormat","runnerConfig","defaultWidth","defaultHeight",
      "allowedOrientations",steps,sampler,scheduler,"cfgScale","costMultiplier",
      "maxCount","concurrencyLimit",enabled,"rolloutPercent",version,status,
      "dryRunSummary","publishedAt","updatedAt"
    ) VALUES (
      'seed-profile-image-redcraft-qw21t-v3','image-redcraft-qw21t','RedCraft 3.0 · QW21 Fixed',
      'image','comfyui','redcraft-qw21t','redcraft-qw21t',
      expected_config->>'diffusionModelPath','safetensors',expected_config,832,1024,
      '["4:5"]'::jsonb,6,'er_sde','simple',1,1.5,
      1,1,true,100,3,'active',
      '{"status":"not_run","source":"2026-10-21-redcraft-default-image-profile","notes":"Configuration publication; live smoke evidence is recorded separately."}'::jsonb,
      CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
    );
  ELSIF profile_count <> 1 OR NOT EXISTS (
    SELECT 1 FROM generation_model_profiles WHERE "profileKey" = 'image-redcraft-qw21t'
      AND mode = 'image' AND runner = 'comfyui' AND "pipelineModel" = 'redcraft-qw21t'
      AND "workflowKey" = 'redcraft-qw21t' AND version = 3 AND status = 'active'
      AND enabled AND "rolloutPercent" = 100 AND "runnerConfig" = expected_config
      AND "sourceModelPath" = expected_config->>'diffusionModelPath'
      AND "modelFormat" = 'safetensors' AND "convertedModelPath" IS NULL
      AND "defaultWidth" = 832 AND "defaultHeight" = 1024 AND "allowedOrientations" = '["4:5"]'::jsonb
      AND steps = 6 AND sampler = 'er_sde' AND scheduler = 'simple' AND "cfgScale" = 1
      AND "maxCount" = 1 AND "concurrencyLimit" = 1 AND "costMultiplier" = 1.5
      AND "requiredEntitlement" IS NULL AND "publishedAt" IS NOT NULL AND "archivedAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'Existing RedCraft QW21T profile differs from the exact released configuration; no update performed';
  END IF;
  UPDATE generation_model_profiles SET status = 'archived', "archivedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "profileKey" = 'image-redcraft-qw21t' AND version IN (1,2) AND status = 'active';

  expected_config := jsonb_set(expected_config, '{publicSelection}', '{"surface":"generator_image_edit"}'::jsonb);
  IF default_profile."workflowKey" = 'redcraft-qw21t' THEN
    IF default_profile."pipelineModel" IS DISTINCT FROM 'redcraft-qw21t'
      OR default_profile."runnerConfig" IS DISTINCT FROM expected_config
      OR default_profile.steps IS DISTINCT FROM 6 OR default_profile.sampler IS DISTINCT FROM 'er_sde'
      OR default_profile.scheduler IS DISTINCT FROM 'simple' OR default_profile."cfgScale" IS DISTINCT FROM 1
      OR default_profile."sourceModelPath" IS DISTINCT FROM expected_config->>'diffusionModelPath'
      OR default_profile."convertedModelPath" IS NOT NULL
      OR default_profile."defaultWidth" IS DISTINCT FROM 832 OR default_profile."defaultHeight" IS DISTINCT FROM 1024
    THEN RAISE EXCEPTION 'Existing default RedCraft profile differs from the released configuration'; END IF;
    RETURN;
  END IF;
  IF default_profile.mode <> 'image' OR default_profile.runner <> 'comfyui'
    OR default_profile."workflowKey" IS DISTINCT FROM 'redqw21'
    OR default_profile."pipelineModel" IS DISTINCT FROM 'redqw21'
    OR default_profile."requiredEntitlement" IS NOT NULL
    OR NOT default_profile.enabled OR default_profile."rolloutPercent" <> 100
  THEN RAISE EXCEPTION 'Active default image profile has an unexpected route'; END IF;
  SELECT max(version) + 1 INTO next_version FROM generation_model_profiles
    WHERE "profileKey" = 'profile_image_default_v1';

  -- Copy billing/access/orientation policy, replacing only the model recipe.
  INSERT INTO generation_model_profiles SELECT (jsonb_populate_record(
    NULL::generation_model_profiles, to_jsonb(default_profile) || jsonb_build_object(
      'id', 'profile-image-default-redcraft-v' || next_version,
      'label', 'Default image · RedCraft / FineView',
      'pipelineModel', 'redcraft-qw21t', 'workflowKey', 'redcraft-qw21t',
      'sourceModelPath', expected_config->>'diffusionModelPath',
      'convertedModelPath', NULL, 'modelFormat', 'safetensors',
      'runnerConfig', expected_config, 'defaultWidth', 832, 'defaultHeight', 1024,
      'steps', 6, 'sampler', 'er_sde', 'scheduler', 'simple', 'cfgScale', 1,
      'version', next_version, 'status', 'active',
      'dryRunSummary', jsonb_build_object('status','not_run',
        'source','2026-10-21-redcraft-default-image-profile',
        'previousProfileId',default_profile.id,
        'notes','Configuration publication; live evidence is recorded separately.'),
      'publishedAt', CURRENT_TIMESTAMP, 'archivedAt', NULL,
      'createdAt', CURRENT_TIMESTAMP, 'updatedAt', CURRENT_TIMESTAMP
    )
  )).*;
  UPDATE generation_model_profiles SET status = 'archived',
    "archivedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
    WHERE id = default_profile.id;
END $$;
COMMIT;
