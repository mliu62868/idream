-- SPEC: Advance only the unique active image profile for each released route.
-- Existing installations may have operator-created IDs and a RedMix3 v2 profile
-- still pinned to workflow v1. That pair advances to v3/v2; fresh v1/v1 advances
-- to v2/v2. Archived profiles, Jobs, Attempts, and their historical pins stay intact.

BEGIN;
LOCK TABLE "generation_model_profiles" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  target record;
  current_profile record;
  active_count integer;
  workflow_version text;
  next_version integer;
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('profile_image_default_v1', 'redcraft-krea2-redmix3-txt2img', 2, 'redmix3'),
      ('profile_image_premium_v1', 'redcraft-krea2-redmix3-txt2img', 2, 'redmix3'),
      ('character-image-single-identity-redcraft', 'redcraft-krea2-identity-edit', 5, 'identity'),
      ('chat-image-edit', 'qwen-image-edit-img2img', 2, 'qwen'),
      ('character-image-variation', 'qwen-image-edit-multi-reference', 2, 'qwen'),
      ('character-image-multi-identity', 'qwen-image-edit-multi-identity', 2, 'qwen')
    ) AS releases(profile_key, workflow_key, workflow_version, family)
  LOOP
    SELECT count(*) INTO active_count FROM "generation_model_profiles"
    WHERE "profileKey" = target.profile_key AND "status" = 'active';
    IF active_count <> 1 THEN
      RAISE EXCEPTION 'Expected one active profile for %, found %', target.profile_key, active_count;
    END IF;

    SELECT * INTO STRICT current_profile FROM "generation_model_profiles"
    WHERE "profileKey" = target.profile_key AND "status" = 'active';
    IF current_profile."mode" <> 'image'
      OR current_profile."runner" <> 'comfyui'
      OR current_profile."workflowKey" IS DISTINCT FROM target.workflow_key
      OR current_profile."enabled" IS DISTINCT FROM true
      OR current_profile."rolloutPercent" <> 100
      OR current_profile."publishedAt" IS NULL
      OR current_profile."archivedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'Active profile % has an unexpected workflow or publication state', target.profile_key;
    END IF;

    workflow_version := current_profile."runnerConfig" ->> 'workflowVersion';
    next_version := NULL;
    IF target.family = 'redmix3' THEN
      IF current_profile."version" IN (2, 3) AND workflow_version = '2' THEN
        CONTINUE;
      ELSIF current_profile."version" IN (1, 2) AND workflow_version = '1' THEN
        next_version := current_profile."version" + 1;
      END IF;
    ELSIF target.family = 'identity' THEN
      IF current_profile."version" = 5 AND workflow_version = '5' THEN
        CONTINUE;
      ELSIF current_profile."version" = 4 AND workflow_version = '4' THEN
        next_version := 5;
      END IF;
    ELSE
      IF current_profile."version" = 2 AND workflow_version = '2' THEN
        CONTINUE;
      ELSIF current_profile."version" = 1 AND (workflow_version IS NULL OR workflow_version = '1') THEN
        next_version := 2;
      END IF;
    END IF;
    IF next_version IS NULL THEN
      RAISE EXCEPTION 'Unrecognized profile/workflow pair %/% for %', current_profile."version", workflow_version, target.profile_key;
    END IF;

    UPDATE "generation_model_profiles"
    SET "runnerConfig" = jsonb_set(COALESCE("runnerConfig", '{}'::jsonb), '{workflowVersion}', to_jsonb(target.workflow_version), true),
      "version" = next_version, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = current_profile."id";
  END LOOP;
END $$;

COMMIT;
