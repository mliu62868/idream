-- Character Soul runtime authority cutover.
-- RUN AS: database superuser. Main Prisma migration
-- 20260805210000_character_soul_current_content_pointer must be applied first.
-- User Characters pin their immutable current Content Version; official
-- Characters continue to pin the current serving Release + Content Version.

\set ON_ERROR_STOP on

SET ROLE core_owner;

CREATE OR REPLACE VIEW core.chat_character_view AS
SELECT
  c.id AS character_id,
  c."creatorId" AS creator_id,
  c.name,
  c.age,
  c.description,
  c."systemPrompt" AS system_prompt,
  c.relationship,
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
