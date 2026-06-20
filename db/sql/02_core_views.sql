-- P0-1 boundary · read-only views (PRD §5). RUN AS: core_owner.
-- Minimal columns chat needs; derived from public base tables. Column names are
-- snake_case (the chat-side contract) even though base columns are camelCase.
-- CREATE OR REPLACE VIEW is re-runnable.

-- 5.1 user view: existence / suspended / deleted / display + locale ------------
CREATE OR REPLACE VIEW core.chat_user_view AS
SELECT
  u.id                       AS user_id,
  u."displayName"            AS display_name,
  COALESCE(p.locale, 'en')   AS locale,
  u.status                   AS status,
  u."deletedAt"              AS deleted_at,
  u."updatedAt"              AS updated_at
FROM public.users u
LEFT JOIN public.user_preferences p ON p."userId" = u.id;

-- 5.2 character view + tags ----------------------------------------------------
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
  c."updatedAt"   AS updated_at
FROM public.characters c;

CREATE OR REPLACE VIEW core.chat_character_tags_view AS
SELECT
  ct."characterId"                       AS character_id,
  json_agg(t.slug ORDER BY t.slug)       AS tags
FROM public.character_tags ct
JOIN public.tags t ON t.id = ct."tagId"
GROUP BY ct."characterId";

-- 5.3 entitlement view: pivot active entitlement rows → tier/flags -------------
-- Mirrors service.ts modelTier/memoryMultiplier so chat resolves policy the same
-- way main does. `plan` value is jsonb {slug, billingPeriod}; feature flags are
-- jsonb booleans keyed snake_case (see featureKey()).
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
  t.model_tier                                              AS model_tier,
  CASE WHEN t.model_tier = 'deluxe' THEN 3 ELSE 1 END       AS memory_multiplier,
  COALESCE((t.m->>'unlimited_messages')::boolean, false)    AS unlimited_messages,
  COALESCE((t.m->>'voice_enabled')::boolean, false)         AS voice_enabled,
  t.updated_at                                              AS updated_at
FROM tier t;

-- 5.4 eligibility view: age gate / verification / jurisdiction -----------------
CREATE OR REPLACE VIEW compliance.chat_user_eligibility_view AS
SELECT
  u.id AS user_id,
  EXISTS (
    SELECT 1 FROM public.age_gate_acceptances a WHERE a."userId" = u.id
  )                                                        AS age_gate_accepted,
  (av.status = 'verified')                                 AS age_verified,
  av.jurisdiction                                          AS jurisdiction,
  CASE
    WHEN u."deletedAt" IS NOT NULL THEN 'account_deleted'
    WHEN u.status = 'suspended'    THEN 'account_suspended'
    ELSE NULL
  END                                                      AS restricted_reason,
  GREATEST(u."updatedAt", COALESCE(av."createdAt", u."updatedAt")) AS updated_at
FROM public.users u
LEFT JOIN LATERAL (
  SELECT v.status, v.jurisdiction, v."createdAt"
  FROM public.age_verifications v
  WHERE v."userId" = u.id
  ORDER BY v."createdAt" DESC
  LIMIT 1
) av ON true;
