-- Publish one RedCraft / FineView checkpoint for all image generation semantics.
-- Quiesce admission/workers and install the matching workflow descriptors first.
-- Run only on an authorized development/test database. No Job, Asset or ledger
-- is repinned; old profile versions and retired catalogue entries remain history.
BEGIN;
LOCK TABLE generation_model_profiles IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE generation_jobs IN SHARE MODE;
DO $$
DECLARE
  profile_count integer;
  default_profile generation_model_profiles%ROWTYPE;
  previous_profile generation_model_profiles%ROWTYPE;
  route record;
  workflow_directory text;
  model_root text;
  encoder_config jsonb;
  redcraft_config jsonb;
  old_edit_config jsonb;
  old_plain_config jsonb;
  expected_config jsonb;
  previous_config jsonb;
  next_version integer;
  already_unified boolean;
  retained_keys text[] := ARRAY[
    'profile_image_default_v1','character-image-single-identity-redcraft',
    'chat-image-edit','character-image-variation','character-image-multi-identity'
  ];
  workflow_keys text[] := ARRAY[
    'redqw21','redcraft-qw21t','qwen-image-edit-img2img',
    'qwen-image-edit-multi-identity','qwen-image-edit-multi-reference'
  ];
BEGIN
  -- Match every supported historical pin shape, including a profile row ID.
  -- The table lock closes the check/write race while callers are quiesced.
  IF EXISTS (
    SELECT 1 FROM generation_jobs job
    WHERE job.status IN ('queued','moderating_input','running','moderating_output')
      AND (job.model LIKE 'redqw21%' OR job.model LIKE 'redcraft%'
        OR job.controls->>'workflowKey' = ANY(workflow_keys)
        OR job."profileId" = ANY(retained_keys || ARRAY['profile_image_premium_v1','image-redcraft-qw21t'])
        OR job."profileId" IN (
          SELECT pin FROM generation_model_profiles profile
          CROSS JOIN LATERAL (VALUES (profile.id),(profile."profileKey")) AS pins(pin)
          WHERE profile."profileKey" = ANY(retained_keys || ARRAY['profile_image_premium_v1','image-redcraft-qw21t'])
            OR profile."pipelineModel" LIKE 'redqw21%' OR profile."workflowKey" = ANY(workflow_keys)
        ))
  ) THEN RAISE EXCEPTION 'Pending affected image jobs must finish before RedCraft unification'; END IF;

  SELECT count(*) INTO profile_count FROM generation_model_profiles
    WHERE "profileKey" = 'profile_image_default_v1' AND status = 'active';
  IF profile_count <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one active default image profile, found %', profile_count;
  END IF;
  SELECT * INTO STRICT default_profile FROM generation_model_profiles
    WHERE "profileKey" = 'profile_image_default_v1' AND status = 'active';

  -- Deployment paths are inherited from the published default, never from the
  -- machine running SQL. Digests, filenames and recipes are release identities.
  workflow_directory := default_profile."runnerConfig"->>'workflowPath';
  IF workflow_directory IS NULL
    OR workflow_directory !~ '^/.+/packages/gen/workflows/redcraft-qw21t\.json$'
    OR workflow_directory ~ '/\.{1,2}/'
  THEN RAISE EXCEPTION 'Default RedCraft profile has an invalid workflow path'; END IF;
  workflow_directory := regexp_replace(workflow_directory, 'redcraft-qw21t\.json$', '');
  model_root := default_profile."runnerConfig"->>'diffusionModelPath';
  IF model_root IS NULL
    OR model_root !~ '^/.+/diffusion_models/fineview_qw21_turbo_fixed_int8\.safetensors$'
    OR model_root ~ '/\.{1,2}/'
  THEN RAISE EXCEPTION 'Default RedCraft profile has an invalid model root'; END IF;
  model_root := regexp_replace(model_root, '/diffusion_models/fineview_qw21_turbo_fixed_int8\.safetensors$', '');

  encoder_config := jsonb_build_object(
    'textEncoderPath', model_root || '/text_encoders/qwen3vl_8b_int8_convrot.safetensors',
    'textEncoderSha256','8bfd0f6e12abf2d2d697ecc888e5e90b0d6741d6708f05799f53afa560452e8f',
    'textEncoderRepository','Comfy-Org/Qwen-Image-2.1',
    'textEncoderRevision','cb504a4090723e43f17ad01cec0359490e2de613',
    'textEncoderPrecision','int8_convrot','textEncoderDevice','mps'
  );
  redcraft_config := encoder_config || jsonb_build_object(
    'baseModel','Qwen-Image 2.1',
    'civitaiModelId',958009,'civitaiVersionId',3407259,'civitaiFileId',3299030,
    'diffusionModelPath',model_root || '/diffusion_models/fineview_qw21_turbo_fixed_int8.safetensors',
    'diffusionModelSha256','712b44d2a79b30ed1aa11f19fc4e2cd0f1f46a43dc3bde5d6fe2a07e36b68f0f',
    'vaePath',model_root || '/vae/texture_fix_vae_for_qwen_image_2.1_bf16.safetensors',
    'vaeSha256','36f56608b02077a50a08ea3dbcdb88351298ceba49948f41f9f87186378e6908',
    'vaeTemporalPadding','torch_cat','precisionPolicy','int8_exact_bf16_resident_mps','conditioningPasses',1
  );
  old_edit_config := encoder_config || jsonb_build_object(
    'baseModel','Qwen-Image 2.1',
    'civitaiModelId',452459,'civitaiVersionId',3370753,'civitaiFileId',3258921,
    'sourceModelSha256','0efb5aeb2b372025042e320c2e35c66ec6681ef54ad5de88a652ab19cc63ad92',
    'diffusionModelPath',model_root || '/diffusion_models/redqw21_unlocked_v2_bf16.safetensors',
    'vaePath',model_root || '/vae/qwen_image_2.1_vae_bf16.safetensors',
    'vaeTemporalPadding','torch_cat','precisionPolicy','bf16_resident_mps','conditioningPasses',1,
    'turboLora',jsonb_build_object(
      'path',model_root || '/loras/Qwen-Image-2.1-viggle-turbo-v0.3-6step-lora-r128.safetensors',
      'sha256','0c98591700346f9777051d4e6fa29aa94519abec0d85b1f1f672a2a3db8c94b3',
      'repository','Viggle/Qwen-Image-2.1-viggle-turbo',
      'revision','009a44a895ef85f7e643c80fdca9543795248867',
      'rank',128,'alpha',128,'strength',1,'unmerged',true
    )
  );
  old_plain_config := encoder_config || jsonb_build_object(
    'baseModel','Qwen-Image 2.1','apiModelId','redqw21',
    'civitaiModelId',452459,'civitaiVersionId',3353689,
    'diffusionModelPath',model_root || '/diffusion_models/redqw21_bf16.safetensors',
    'diffusionModelSha256','9830a9925759a4b69ea1346133d08917ec2390b8495ea7f0eb613f37e7c46647',
    'vaePath',model_root || '/vae/qwen_image_2.1_vae_bf16.safetensors',
    'vaeTemporalPadding','torch_cat','precisionPolicy','bf16_resident_mps','textEncoderDevice','cpu',
    'workflowPath',workflow_directory || 'redqw21.json','workflowVersion',3,
    'capabilities','{"lora":false,"initImage":false,"stableSeed":true,"textToImage":true,"referenceImages":true}'::jsonb
  );

  FOR route IN SELECT * FROM (VALUES
    ('profile_image_default_v1','redcraft-qw21t','redcraft-qw21t','redcraft-qw21t',3,3,
      'Default image · RedCraft / FineView',
      '{"publicSelection":{"surface":"generator_image_edit"},"capabilities":{"textToImage":true,"stableSeed":true,"referenceImages":true,"initImage":true,"lora":false}}'::jsonb),
    ('character-image-single-identity-redcraft','redqw21-image-edit','redcraft-image-edit','qwen-image-edit-img2img',5,6,
      'Character Single-Reference Identity (RedCraft / FineView)',
      '{"templateIntent":"single_face_reference_identity_restaging","publicSelection":{"explicitOnly":true},"capabilities":{"textToImage":false,"stableSeed":true,"referenceImages":true,"initImage":true,"lora":false}}'::jsonb),
    ('chat-image-edit','redqw21-image-edit','redcraft-image-edit','qwen-image-edit-img2img',5,6,
      'Chat Image Edit (RedCraft / FineView)',
      '{"publicSelection":{"surface":"generator_image_edit"},"capabilities":{"textToImage":false,"stableSeed":true,"referenceImages":true,"initImage":true,"lora":false}}'::jsonb),
    ('character-image-variation','redqw21-multi-reference','redcraft-multi-reference','qwen-image-edit-multi-reference',7,8,
      'Character Image Variation (RedCraft / FineView)',
      '{"publicSelection":{"surface":"generator_image_edit"},"capabilities":{"textToImage":false,"stableSeed":true,"referenceImages":true,"initImage":true,"lora":false}}'::jsonb),
    ('character-image-multi-identity','redqw21-multi-identity','redcraft-multi-identity','qwen-image-edit-multi-identity',6,7,
      'Character Multi-Reference Identity (RedCraft / FineView)',
      '{"capabilities":{"textToImage":false,"stableSeed":true,"referenceImages":true,"initImage":false,"lora":false}}'::jsonb)
  ) AS definitions(profile_key,old_model,new_model,workflow_key,old_pin,new_pin,label,semantics)
  LOOP
    SELECT count(*) INTO profile_count FROM generation_model_profiles
      WHERE "profileKey" = route.profile_key AND status = 'active';
    IF profile_count <> 1 THEN
      RAISE EXCEPTION 'Expected exactly one active image profile for %, found %', route.profile_key, profile_count;
    END IF;
    SELECT * INTO STRICT previous_profile FROM generation_model_profiles
      WHERE "profileKey" = route.profile_key AND status = 'active';
    IF EXISTS (SELECT version FROM generation_model_profiles WHERE "profileKey" = route.profile_key GROUP BY version HAVING count(*) > 1) THEN
      RAISE EXCEPTION 'Conflicting profile versions for %', route.profile_key;
    END IF;
    expected_config := redcraft_config || route.semantics || jsonb_build_object(
      'apiModelId',route.new_model,'workflowVersion',route.new_pin,
      'workflowPath',workflow_directory || route.workflow_key || '.json'
    );
    already_unified := previous_profile."pipelineModel" = route.new_model
      AND (route.profile_key <> 'profile_image_default_v1' OR previous_profile."maxCount" = 4);
    previous_config := CASE WHEN already_unified OR route.profile_key = 'profile_image_default_v1' THEN expected_config
      ELSE old_edit_config || jsonb_set(route.semantics,'{capabilities,lora}','true'::jsonb)
        || jsonb_build_object('apiModelId',route.old_model,'workflowVersion',route.old_pin,
          'workflowPath',workflow_directory || route.workflow_key || '.json') END;

    IF previous_profile.mode IS DISTINCT FROM 'image' OR previous_profile.runner IS DISTINCT FROM 'comfyui'
      OR previous_profile."workflowKey" IS DISTINCT FROM route.workflow_key
      OR previous_profile."pipelineModel" IS DISTINCT FROM (CASE WHEN already_unified THEN route.new_model ELSE route.old_model END)
      OR previous_profile."runnerConfig" IS DISTINCT FROM previous_config
      OR previous_profile."modelFormat" IS DISTINCT FROM 'safetensors'
      OR previous_profile."sourceModelPath" IS DISTINCT FROM (CASE WHEN already_unified OR route.profile_key = 'profile_image_default_v1'
        THEN redcraft_config->>'diffusionModelPath' ELSE model_root || '/diffusion_models/redqw21_unlocked_v2_fp8.safetensors' END)
      OR previous_profile."convertedModelPath" IS DISTINCT FROM (CASE WHEN already_unified OR route.profile_key = 'profile_image_default_v1'
        THEN NULL ELSE model_root || '/diffusion_models/redqw21_unlocked_v2_bf16.safetensors' END)
      OR previous_profile.steps IS DISTINCT FROM 6 OR previous_profile."cfgScale" IS DISTINCT FROM 1
      OR previous_profile.sampler IS DISTINCT FROM (CASE WHEN already_unified OR route.profile_key = 'profile_image_default_v1' THEN 'er_sde' ELSE 'euler' END)
      OR previous_profile.scheduler IS DISTINCT FROM (CASE WHEN already_unified OR route.profile_key = 'profile_image_default_v1' THEN 'simple' ELSE 'viggle_turbo' END)
      OR previous_profile."publishedAt" IS NULL OR previous_profile."archivedAt" IS NOT NULL
      OR (route.profile_key = 'profile_image_default_v1' AND previous_profile."maxCount" NOT IN (1,4))
    THEN RAISE EXCEPTION 'Image profile % differs from the released configuration', route.profile_key; END IF;
    IF already_unified THEN CONTINUE; END IF;

    SELECT max(version) + 1 INTO next_version FROM generation_model_profiles WHERE "profileKey" = route.profile_key;
    -- Preserve billing, entitlements, rollout, dimensions and reference semantics.
    -- The default absorbs the retired premium route's four-image batch capacity.
    INSERT INTO generation_model_profiles SELECT (jsonb_populate_record(
      NULL::generation_model_profiles, to_jsonb(previous_profile) || jsonb_build_object(
        'id',route.profile_key || '-redcraft-unified-v' || next_version,
        'label',route.label,'pipelineModel',route.new_model,
        'sourceModelPath',redcraft_config->>'diffusionModelPath','convertedModelPath',NULL,
        'runnerConfig',expected_config,'sampler','er_sde','scheduler','simple',
        'maxCount',CASE WHEN route.profile_key = 'profile_image_default_v1' THEN 4 ELSE previous_profile."maxCount" END,
        'version',next_version,'status','active',
        'dryRunSummary',jsonb_build_object('status','not_run','source','2026-10-23-unify-redcraft-image-model',
          'previousProfileId',previous_profile.id,'notes','Configuration publication; live qualification is recorded separately.'),
        'publishedAt',CURRENT_TIMESTAMP,'archivedAt',NULL,'createdAt',CURRENT_TIMESTAMP,'updatedAt',CURRENT_TIMESTAMP
      )
    )).*;
    UPDATE generation_model_profiles SET status = 'archived',"archivedAt" = CURRENT_TIMESTAMP,"updatedAt" = CURRENT_TIMESTAMP
      WHERE id = previous_profile.id;
  END LOOP;

  -- Retire only verified obsolete catalogue entries. A mismatched or unknown
  -- legacy route is a configuration conflict, not permission to archive it.
  FOR previous_profile IN SELECT * FROM generation_model_profiles
    WHERE status = 'active' AND NOT ("profileKey" = ANY(retained_keys))
      AND ("profileKey" IN ('profile_image_premium_v1','image-redcraft-qw21t')
        OR "pipelineModel" LIKE 'redqw21%' OR "workflowKey" = 'redqw21')
  LOOP
    IF previous_profile."profileKey" = 'image-redcraft-qw21t' THEN
      expected_config := redcraft_config || jsonb_build_object(
        'apiModelId','redcraft-qw21t','workflowVersion',3,'workflowPath',workflow_directory || 'redcraft-qw21t.json',
        'publicSelection','{"surface":"generator_image_edit","explicitOnly":true}'::jsonb,
        'capabilities','{"textToImage":true,"stableSeed":true,"referenceImages":true,"initImage":true,"lora":false}'::jsonb
      );
      IF previous_profile."pipelineModel" IS DISTINCT FROM 'redcraft-qw21t'
        OR previous_profile."workflowKey" IS DISTINCT FROM 'redcraft-qw21t'
        OR previous_profile.steps IS DISTINCT FROM 6 OR previous_profile.sampler IS DISTINCT FROM 'er_sde'
        OR previous_profile.scheduler IS DISTINCT FROM 'simple'
      THEN RAISE EXCEPTION 'Retired image profile % differs from the released configuration',previous_profile."profileKey"; END IF;
    ELSE
      expected_config := old_plain_config;
      IF previous_profile."pipelineModel" IS DISTINCT FROM 'redqw21' OR previous_profile."workflowKey" IS DISTINCT FROM 'redqw21'
        OR previous_profile.steps IS DISTINCT FROM 10 OR previous_profile.sampler IS DISTINCT FROM 'euler'
        OR previous_profile.scheduler IS DISTINCT FROM 'simple'
      THEN RAISE EXCEPTION 'Retired image profile % differs from the released configuration',previous_profile."profileKey"; END IF;
    END IF;
    IF previous_profile.mode IS DISTINCT FROM 'image' OR previous_profile.runner IS DISTINCT FROM 'comfyui'
      OR previous_profile."runnerConfig" IS DISTINCT FROM expected_config
      OR previous_profile."sourceModelPath" IS DISTINCT FROM expected_config->>'diffusionModelPath'
      OR previous_profile."convertedModelPath" IS NOT NULL OR previous_profile."modelFormat" IS DISTINCT FROM 'safetensors'
      OR previous_profile."cfgScale" IS DISTINCT FROM 1
    THEN RAISE EXCEPTION 'Retired image profile % differs from the released configuration',previous_profile."profileKey"; END IF;
    UPDATE generation_model_profiles SET status = 'archived',"archivedAt" = CURRENT_TIMESTAMP,"updatedAt" = CURRENT_TIMESTAMP
      WHERE id = previous_profile.id;
  END LOOP;
END $$;
COMMIT;
