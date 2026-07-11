-- P4 boundary update · visual passport injection + image-tool flags. RUN AS: core_owner.
-- CREATE OR REPLACE VIEW — re-runnable / idempotent. Adds columns ONLY (existing
-- consumers of core.chat_character_view / billing.chat_entitlement_view keep working).
--
-- Deploy ordering: NO hard dependency. Old chat code never selects the new
-- columns, so it is unaffected if this SQL lands first. New chat code selects
-- them unconditionally, so it will error ("column does not exist") if it starts
-- before this SQL is applied — SQL FIRST is still the safe order, but there is
-- no destructive/blocking step either direction (pure additive CREATE OR REPLACE).
--
-- Visual passport columns: LEFT JOIN the character's ACTIVE visual profile.
-- Since P2, creating a new profile archives the prior active one, so at most one
-- row has status='active' per character — this LEFT JOIN can never fan out rows.
CREATE OR REPLACE VIEW core.chat_character_view AS
SELECT
  c.id            AS character_id,
  c."creatorId"   AS creator_id,
  c.name          AS name,
  c.age           AS age,
  c.description   AS description,
  c."systemPrompt" AS system_prompt,
  c.relationship  AS relationship,
  c.visibility    AS visibility,
  c.status        AS status,
  c."voiceId"     AS voice_id,
  c."updatedAt"   AS updated_at,
  vp.id           AS visual_profile_id,
  vp.version      AS visual_profile_version,
  vp."identityPrompt" AS identity_prompt,
  COALESCE((c."advancedDetails"->>'imageToolEnabled')::boolean, true) AS image_tool_enabled
  ,cr."characterContentVersionId" AS character_content_version_id
  ,cr.id            AS character_release_id
FROM public.characters c
LEFT JOIN public.character_visual_profiles vp
  ON vp."characterId" = c.id AND vp.status = 'active'
LEFT JOIN public.character_serving cs ON cs."characterId" = c.id
LEFT JOIN public.character_releases cr ON cr.id = cs."currentReleaseId";

-- Entitlement image_tool_enabled: mirrors the voice_enabled pivot in 02_core_views.sql
-- (:76), but defaults TRUE — the tool is currently available to every tier, gated
-- only by the per-character flag above (AND'd together in chat's policy.ts).
CREATE OR REPLACE VIEW billing.chat_entitlement_view AS
WITH ent AS (
  SELECT
    e."userId"                                              AS user_id,
    jsonb_object_agg(e.key, e.value)                        AS m,
    max(e."createdAt")                                      AS updated_at
  FROM public.entitlements e
  WHERE e."expiresAt" IS NULL OR e."expiresAt" > now()
  GROUP BY e."userId"
),
tier AS (
  SELECT
    u.id AS user_id,
    CASE
      WHEN COALESCE(ent.m->'plan'->>'slug', '') LIKE '%deluxe%'
        OR ent.m->'video_generation' = 'true'::jsonb        THEN 'deluxe'
      WHEN COALESCE(ent.m->'plan'->>'slug', '') LIKE '%premium%'
        OR ent.m->'premium_controls' = 'true'::jsonb        THEN 'premium'
      ELSE 'free'
    END AS model_tier,
    ent.m AS m,
    ent.updated_at AS updated_at
  FROM public.users u
  LEFT JOIN ent ON ent.user_id = u.id
)
SELECT
  t.user_id                                                 AS user_id,
  t.model_tier                                               AS model_tier,
  CASE WHEN t.model_tier = 'deluxe' THEN 3 ELSE 1 END       AS memory_multiplier,
  COALESCE((t.m->>'unlimited_messages')::boolean, false)    AS unlimited_messages,
  COALESCE((t.m->>'voice_enabled')::boolean, false)         AS voice_enabled,
  t.updated_at                                              AS updated_at,
  COALESCE((t.m->>'image_tool_enabled')::boolean, true)     AS image_tool_enabled
FROM tier t;
