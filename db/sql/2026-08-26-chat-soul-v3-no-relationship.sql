-- Remove Relationship from the Chat read model and pin every resolvable active
-- legacy session to immutable Character content. Sessions whose Character is
-- already absent from the read model remain inaccessible and cannot be pinned.
-- RUN AS: database superuser with Chat
-- writers paused. Apply this file before the matching Main Prisma migration.
\set ON_ERROR_STOP on

BEGIN;

SET LOCAL ROLE core_owner;

-- PostgreSQL forbids removing a view column through CREATE OR REPLACE VIEW.
-- Chat is paused for this transaction, so replace the dependency-free view
-- explicitly and restore its least-privilege grant below.
DROP VIEW core.chat_character_view;

CREATE VIEW core.chat_character_view AS
SELECT
  c.id AS character_id,
  c."creatorId" AS creator_id,
  c.name,
  c.age,
  c.description,
  c."systemPrompt" AS system_prompt,
  c.visibility,
  c.status,
  c."voiceId" AS voice_id,
  c."updatedAt" AS updated_at,
  vp.id AS visual_profile_id,
  vp.version AS visual_profile_version,
  vp."identityPrompt" AS identity_prompt,
  COALESCE((c."advancedDetails"->>'imageToolEnabled')::boolean, true) AS image_tool_enabled,
  COALESCE(cr."characterContentVersionId", c."currentContentVersionId") AS character_content_version_id,
  cr.id AS character_release_id,
  c."deletedAt" AS deleted_at
FROM public.characters c
LEFT JOIN public.character_visual_profiles vp
  ON vp."characterId" = c.id AND vp.status = 'active'
LEFT JOIN public.character_serving cs
  ON cs."characterId" = c.id
LEFT JOIN public.character_releases cr
  ON cr.id = cs."currentReleaseId";

GRANT SELECT ON core.chat_character_view TO chat_service;

RESET ROLE;

UPDATE chat.chat_sessions AS session
SET
  character_content_version_id = view.character_content_version_id,
  character_release_id = view.character_release_id,
  release_pinned_at = timezone('utc', now()),
  updated_at = timezone('utc', now())
FROM core.chat_character_view AS view
WHERE session.status = 'active'
  AND session.character_content_version_id IS NULL
  AND session.character_id = view.character_id
  AND view.character_content_version_id IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM chat.chat_sessions AS session
    JOIN core.chat_character_view AS view
      ON view.character_id = session.character_id
    WHERE session.status = 'active'
      AND session.character_content_version_id IS NULL
      AND view.character_content_version_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'resolvable active Chat sessions remain without an immutable content pin';
  END IF;
END $$;

COMMIT;
