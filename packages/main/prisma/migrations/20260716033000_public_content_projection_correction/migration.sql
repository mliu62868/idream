-- Keep the already-committed provenance migration immutable. This follow-up
-- adds the public feedback audience field and repairs durable projections after
-- user provenance became explicit.
ALTER TABLE "product_feedback_items"
  ADD COLUMN IF NOT EXISTS "visibility" TEXT NOT NULL DEFAULT 'public';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'product_feedback_items_visibility_check'
  ) THEN
    ALTER TABLE "product_feedback_items"
      ADD CONSTRAINT "product_feedback_items_visibility_check"
      CHECK ("visibility" IN ('public', 'unlisted'));
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS "product_feedback_items_visibility_status_createdAt_idx"
  ON "product_feedback_items"("visibility", "status", "createdAt");

-- The preceding legacy backfill was intended for unhashed schema-v1 rows.
-- Canonical rows include dataClass and actor in payloadHash, so restore any row
-- whose stored actor proves that customer was the original hashed identity.
UPDATE "analytics_events"
SET "dataClass" = 'customer'
WHERE "payloadHash" IS NOT NULL
  AND "schemaVersion" >= 2
  AND "dataClass" <> 'customer'
  AND COALESCE("actor"->>'isInternal', 'false') = 'false';

-- Durable facts are the serving/metric authorities. If their user is a
-- fixture, internal operator, audit actor, privileged account, or inactive
-- account, make the historical fact ineligible without rewriting canonical
-- event hashes.
UPDATE "customer_signup_facts" facts
SET
  "dataClass" = CASE
    WHEN actor."dataClass" = 'customer' THEN 'internal'
    ELSE actor."dataClass"
  END,
  "actorIsInternal" = TRUE,
  eligible = FALSE
FROM "users" actor
WHERE facts."userId" = actor.id
  AND (
    actor."dataClass" <> 'customer'
    OR actor.role <> 'user'
    OR actor.status <> 'active'
    OR actor."deletedAt" IS NOT NULL
  );

UPDATE "chat_exchange_facts" facts
SET
  "dataClass" = CASE
    WHEN actor."dataClass" = 'customer' THEN 'internal'
    ELSE actor."dataClass"
  END,
  "actorIsInternal" = TRUE,
  eligible = FALSE
FROM "users" actor
WHERE facts."userId" = actor.id
  AND (
    actor."dataClass" <> 'customer'
    OR actor.role <> 'user'
    OR actor.status <> 'active'
    OR actor."deletedAt" IS NOT NULL
  );

UPDATE "generation_fulfillment_facts" facts
SET
  "dataClass" = CASE
    WHEN actor."dataClass" = 'customer' THEN 'internal'
    ELSE actor."dataClass"
  END,
  "actorIsInternal" = TRUE,
  eligible = FALSE
FROM "users" actor
WHERE facts."userId" = actor.id
  AND (
    actor."dataClass" <> 'customer'
    OR actor.role <> 'user'
    OR actor.status <> 'active'
    OR actor."deletedAt" IS NOT NULL
  );

UPDATE "subscription_lifecycle_facts" facts
SET
  "dataClass" = CASE
    WHEN actor."dataClass" = 'customer' THEN 'internal'
    ELSE actor."dataClass"
  END,
  "actorIsInternal" = TRUE,
  eligible = FALSE
FROM "users" actor
WHERE facts."userId" = actor.id
  AND (
    actor."dataClass" <> 'customer'
    OR actor.role <> 'user'
    OR actor.status <> 'active'
    OR actor."deletedAt" IS NOT NULL
  );

UPDATE "character_exposure_facts" facts
SET
  "dataClass" = CASE
    WHEN actor."dataClass" = 'customer' THEN 'internal'
    ELSE actor."dataClass"
  END,
  "actorIsInternal" = TRUE,
  eligible = FALSE
FROM "users" actor
WHERE facts."userId" = actor.id
  AND (
    actor."dataClass" <> 'customer'
    OR actor.role <> 'user'
    OR actor.status <> 'active'
    OR actor."deletedAt" IS NOT NULL
  );

UPDATE "experiment_exposure_facts" facts
SET
  "dataClass" = CASE
    WHEN actor."dataClass" = 'customer' THEN 'internal'
    ELSE actor."dataClass"
  END,
  eligible = FALSE
FROM "users" actor
WHERE facts."subjectType" = 'user'
  AND facts."subjectId" = actor.id
  AND (
    actor."dataClass" <> 'customer'
    OR actor.role <> 'user'
    OR actor.status <> 'active'
    OR actor."deletedAt" IS NOT NULL
  );

UPDATE "ai_usage_facts" facts
SET
  "dataClass" = CASE
    WHEN actor."dataClass" = 'customer' THEN 'internal'
    ELSE actor."dataClass"
  END,
  "actorIsInternal" = TRUE
FROM "users" actor
WHERE facts."userId" = actor.id
  AND (
    actor."dataClass" <> 'customer'
    OR actor.role <> 'user'
    OR actor.status <> 'active'
    OR actor."deletedAt" IS NOT NULL
  );

-- Rebuild public engagement only after the durable facts have been corrected.
UPDATE "character_stats" stats
SET "likesCount" = (
  SELECT COUNT(*)::int
  FROM "character_likes" likes
  JOIN "users" actor ON actor.id = likes."userId"
  WHERE likes."characterId" = stats."characterId"
    AND actor."dataClass" = 'customer'
    AND actor.role = 'user'
    AND actor.status = 'active'
    AND actor."deletedAt" IS NULL
);

UPDATE "character_stats" stats
SET
  "chatsCount" = (
    SELECT COUNT(*)::int
    FROM "chat_exchange_facts" facts
    WHERE facts."characterId" = stats."characterId"
      AND facts.eligible = TRUE
      AND facts.environment = 'production'
      AND facts."dataClass" = 'customer'
      AND facts."trustClass" = 'canonical'
      AND facts."actorIsInternal" = FALSE
  ),
  "viewsCount" = (
    SELECT COUNT(*)::int
    FROM "character_exposure_facts" facts
    WHERE facts."characterId" = stats."characterId"
      AND facts."eventType" = 'detail_view'
      AND facts.eligible = TRUE
      AND facts.environment = 'production'
      AND facts."dataClass" = 'customer'
      AND facts."trustClass" IN ('canonical', 'typed_client')
      AND facts."actorIsInternal" = FALSE
  );

UPDATE "product_feedback_items" feedback
SET "voteCount" = (
  SELECT COUNT(*)::int
  FROM "product_feedback_votes" votes
  JOIN "users" actor ON actor.id = votes."userId"
  WHERE votes."itemId" = feedback.id
    AND actor."dataClass" = 'customer'
    AND actor.role = 'user'
    AND actor.status = 'active'
    AND actor."deletedAt" IS NULL
);
