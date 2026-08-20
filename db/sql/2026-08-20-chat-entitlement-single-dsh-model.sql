-- DSH has one configured provider/model. Remove a product promise that could not
-- be executed: plan-specific model aliases and a 3x generic-memory multiplier.
-- RUN AS: database superuser. Apply before restarting Chat on this revision.

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL ROLE core_owner;

-- CREATE OR REPLACE cannot remove a view column. Recreate the read model in one
-- transaction, then restore its exact runtime grant before commit.
DROP VIEW billing.chat_entitlement_view;
CREATE VIEW billing.chat_entitlement_view AS
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
  COALESCE((t.m->>'unlimited_messages')::boolean, false)    AS unlimited_messages,
  COALESCE((t.m->>'voice_enabled')::boolean, false)         AS voice_enabled,
  t.updated_at                                              AS updated_at,
  COALESCE((t.m->>'image_tool_enabled')::boolean, true)     AS image_tool_enabled
FROM tier t;

GRANT SELECT ON billing.chat_entitlement_view TO chat_service;
COMMIT;
