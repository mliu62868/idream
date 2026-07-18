-- Phase 4 canonical chat exchange facts. RUN AS a database superuser; this file
-- switches to the least-privileged owners for each authority boundary.
-- Additive and idempotent; SQL must land before a chat build that emits
-- chat.exchange.completed.v2.

SET ROLE chat_owner;

ALTER TABLE chat.messages
  ADD COLUMN IF NOT EXISTS engagement_session_id text,
  ADD COLUMN IF NOT EXISTS character_content_version_id text,
  ADD COLUMN IF NOT EXISTS character_release_id text;

ALTER TABLE chat.chat_outbox_events
  ADD COLUMN IF NOT EXISTS schema_version integer NOT NULL DEFAULT 1;

RESET ROLE;
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
  cr."characterContentVersionId" AS character_content_version_id,
  cr.id AS character_release_id
FROM public.characters c
LEFT JOIN public.character_visual_profiles vp
  ON vp."characterId" = c.id AND vp.status = 'active'
LEFT JOIN public.character_serving cs
  ON cs."characterId" = c.id
LEFT JOIN public.character_releases cr
  ON cr.id = cs."currentReleaseId";

GRANT SELECT ON core.chat_character_view TO chat_service;

RESET ROLE;
