-- SPEC: Expose the existing source-only and identity+source Qwen routes in
-- Generate Image Edit after their workflow-v2 rollout. Other profile settings
-- and every archived version remain operator-owned and unchanged.

BEGIN;
LOCK TABLE "generation_model_profiles" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  target record;
  current_profile record;
  active_count integer;
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('chat-image-edit', 'qwen-image-edit-img2img'),
      ('character-image-variation', 'qwen-image-edit-multi-reference')
    ) AS routes(profile_key, workflow_key)
  LOOP
    SELECT count(*) INTO active_count FROM "generation_model_profiles"
    WHERE "profileKey" = target.profile_key AND "status" = 'active';
    IF active_count <> 1 THEN
      RAISE EXCEPTION 'Expected one active image-edit profile for %, found %', target.profile_key, active_count;
    END IF;
    SELECT * INTO STRICT current_profile FROM "generation_model_profiles"
    WHERE "profileKey" = target.profile_key AND "status" = 'active';
    IF current_profile."mode" <> 'image' OR current_profile."runner" <> 'comfyui'
      OR current_profile."workflowKey" IS DISTINCT FROM target.workflow_key
      OR current_profile."version" <> 2
      OR current_profile."runnerConfig" ->> 'workflowVersion' IS DISTINCT FROM '2'
      OR current_profile."runnerConfig" #>> '{capabilities,initImage}' IS DISTINCT FROM 'true'
      OR current_profile."enabled" IS DISTINCT FROM true OR current_profile."rolloutPercent" <> 100
      OR current_profile."publishedAt" IS NULL OR current_profile."archivedAt" IS NOT NULL
      OR (current_profile."runnerConfig" -> 'publicSelection' IS NOT NULL
        AND jsonb_typeof(current_profile."runnerConfig" -> 'publicSelection') <> 'object')
      OR (current_profile."runnerConfig" #>> '{publicSelection,surface}' IS NOT NULL
        AND current_profile."runnerConfig" #>> '{publicSelection,surface}' <> 'generator_image_edit') THEN
      RAISE EXCEPTION 'Image-edit route % has not reached its exact released authority', target.profile_key;
    END IF;
    IF current_profile."runnerConfig" #>> '{publicSelection,surface}' = 'generator_image_edit' THEN
      CONTINUE;
    END IF;
    UPDATE "generation_model_profiles"
    SET "runnerConfig" = jsonb_set("runnerConfig", '{publicSelection}',
        COALESCE("runnerConfig" -> 'publicSelection', '{}'::jsonb) || '{"surface":"generator_image_edit"}'::jsonb, true),
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = current_profile."id";
  END LOOP;
END $$;

COMMIT;
