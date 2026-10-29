-- Publish source-size support for the two existing edit routes. Deploy Main/Gen
-- code first and quiesce affected generation through the PM2 wrapper. Existing
-- requests keep their original profile, dimensions, source snapshots and price.
BEGIN;
LOCK TABLE generation_model_profiles IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE generation_jobs IN SHARE MODE;
DO $$
DECLARE
  route record;
  previous generation_model_profiles%ROWTYPE;
  next_version integer;
BEGIN
  IF EXISTS (
    SELECT 1 FROM generation_jobs job
    WHERE job.status IN ('queued','moderating_input','running','moderating_output')
      AND (job."profileId" IN ('chat-image-edit','character-image-variation')
        OR job.controls->>'workflowKey' IN ('qwen-image-edit-img2img','qwen-image-edit-multi-reference')
        OR job."profileId" IN (SELECT id FROM generation_model_profiles WHERE "profileKey" IN ('chat-image-edit','character-image-variation')))
  ) THEN RAISE EXCEPTION 'Affected image edits must finish before publishing source-size support'; END IF;
  FOR route IN SELECT * FROM (VALUES
    ('chat-image-edit','qwen-image-edit-img2img'),
    ('character-image-variation','qwen-image-edit-multi-reference')
  ) AS routes(profile_key, workflow_key)
  LOOP
    SELECT * INTO STRICT previous FROM generation_model_profiles
      WHERE "profileKey" = route.profile_key AND status = 'active';
    IF previous.mode <> 'image' OR previous.runner <> 'comfyui'
      OR previous."workflowKey" IS DISTINCT FROM route.workflow_key
      OR previous."runnerConfig"->'capabilities'->>'initImage' IS DISTINCT FROM 'true'
    THEN RAISE EXCEPTION 'Unexpected image edit route: %', route.profile_key; END IF;
    IF previous."allowedOrientations" @> '["original"]'::jsonb THEN CONTINUE; END IF;
    SELECT max(version) + 1 INTO next_version FROM generation_model_profiles WHERE "profileKey" = route.profile_key;
    INSERT INTO generation_model_profiles SELECT (jsonb_populate_record(
      NULL::generation_model_profiles, to_jsonb(previous) || jsonb_build_object(
        'id',route.profile_key || '-source-size-v' || next_version,
        'allowedOrientations',previous."allowedOrientations" || '["original"]'::jsonb,
        'version',next_version,'status','active',
        'dryRunSummary',jsonb_build_object('status','not_run','source','2026-10-29-image-edit-original-dimensions',
          'previousProfileId',previous.id,'notes','Configuration publication; live source-size qualification is recorded separately.'),
        'publishedAt',CURRENT_TIMESTAMP,'archivedAt',NULL,'createdAt',CURRENT_TIMESTAMP,'updatedAt',CURRENT_TIMESTAMP
      )
    )).*;
    UPDATE generation_model_profiles SET status = 'archived',"archivedAt" = CURRENT_TIMESTAMP,"updatedAt" = CURRENT_TIMESTAMP
      WHERE id = previous.id;
  END LOOP;
END $$;
COMMIT;
