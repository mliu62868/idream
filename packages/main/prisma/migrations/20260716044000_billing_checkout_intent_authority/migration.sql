-- Checkout is a durable purchase intent created before the external provider
-- side effect. Legacy rows remain readable while every new write records the
-- exact plan/amount/key/request hash and provider recovery state.
ALTER TABLE "checkout_sessions"
  ADD COLUMN "planId" TEXT,
  ADD COLUMN "idempotencyKey" TEXT,
  ADD COLUMN "requestHash" TEXT,
  ADD COLUMN "checkoutUrl" TEXT,
  ADD COLUMN "amountCents" INTEGER,
  ADD COLUMN "currency" TEXT,
  ADD COLUMN "offerSnapshot" JSONB,
  ADD COLUMN "autoConfirm" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "dispatchToken" TEXT,
  ADD COLUMN "dispatchLeaseUntil" TIMESTAMP(3),
  ADD COLUMN "providerAttemptedAt" TIMESTAMP(3),
  ADD COLUMN "failureCode" TEXT,
  ADD COLUMN "needsReconciliation" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "reconciliationEvidence" JSONB,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "checkout_sessions"
  ALTER COLUMN status SET DEFAULT 'provider_pending';

WITH inferred_plan AS (
  SELECT
    checkout.id AS "checkoutId",
    min(subscription."planId") AS "planId"
  FROM "checkout_sessions" checkout
  JOIN "subscriptions" subscription
    ON subscription."userId" = checkout."userId"
    AND subscription.provider = checkout.provider
    AND subscription."providerSubscriptionId" = checkout."providerSessionId"
  WHERE checkout."planId" IS NULL
    AND checkout."providerSessionId" IS NOT NULL
  GROUP BY checkout.id
  HAVING count(DISTINCT subscription."planId") = 1
)
UPDATE "checkout_sessions" checkout
SET "planId" = inferred_plan."planId"
FROM inferred_plan
WHERE checkout.id = inferred_plan."checkoutId";

-- A current Plan row is not historical proof of the offer shown when a legacy
-- checkout was created. Keep offerSnapshot NULL for legacy rows instead of
-- manufacturing a snapshot from mutable present-day pricing.
UPDATE "checkout_sessions"
SET
  "needsReconciliation" = TRUE,
  "failureCode" = COALESCE("failureCode", 'legacy_missing_offer_snapshot'),
  "reconciliationEvidence" =
    COALESCE("reconciliationEvidence", '{}'::jsonb)
      || jsonb_build_object(
        'schemaVersion', 'checkout-reconciliation-evidence-v1',
        'reason', 'legacy_missing_offer_snapshot'
      )
WHERE "offerSnapshot" IS NULL
  AND status <> 'completed';

-- Historical mock checkouts reused deterministic provider ids. Preserve the
-- oldest canonical record and quarantine later duplicates before adding the
-- provider identity unique key.
WITH ranked AS (
  SELECT
    checkout.id,
    checkout."providerSessionId",
    row_number() OVER (
      PARTITION BY checkout.provider, checkout."providerSessionId"
      ORDER BY
        CASE
          WHEN EXISTS (
            SELECT 1
            FROM subscriptions subscription
            WHERE subscription."userId" = checkout."userId"
              AND subscription.provider = checkout.provider
              AND subscription."providerSubscriptionId" = checkout."providerSessionId"
          ) THEN 0
          ELSE 1
        END,
        CASE checkout.status
          WHEN 'completed' THEN 0
          WHEN 'created' THEN 1
          ELSE 2
        END,
        checkout."createdAt",
        checkout.id
    ) AS duplicate_rank
  FROM "checkout_sessions" checkout
  WHERE checkout."providerSessionId" IS NOT NULL
)
UPDATE "checkout_sessions" checkout
SET
  status = 'canceled',
  "failureCode" = 'legacy_duplicate_provider_session',
  "providerSessionId" = NULL,
  "needsReconciliation" = TRUE,
  "reconciliationEvidence" =
    COALESCE(checkout."reconciliationEvidence", '{}'::jsonb)
      || jsonb_build_object(
        'schemaVersion', 'checkout-reconciliation-evidence-v1',
        'reason', 'legacy_duplicate_provider_session',
        'legacyProviderSessionId', ranked."providerSessionId",
        'duplicateRank', ranked.duplicate_rank
      )
FROM ranked
WHERE checkout.id = ranked.id
  AND ranked.duplicate_rank > 1;

CREATE UNIQUE INDEX "checkout_sessions_userId_idempotencyKey_key"
  ON "checkout_sessions"("userId", "idempotencyKey");
CREATE UNIQUE INDEX "checkout_sessions_provider_providerSessionId_key"
  ON "checkout_sessions"(provider, "providerSessionId");
CREATE INDEX "checkout_sessions_status_dispatchLeaseUntil_idx"
  ON "checkout_sessions"(status, "dispatchLeaseUntil");
CREATE INDEX "checkout_sessions_planId_createdAt_idx"
  ON "checkout_sessions"("planId", "createdAt");

ALTER TABLE "checkout_sessions"
  ADD CONSTRAINT "checkout_sessions_planId_fkey"
  FOREIGN KEY ("planId") REFERENCES "plans"(id)
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "provider_events"
  ADD COLUMN "targetHash" TEXT;

CREATE TABLE "provider_event_deliveries" (
  id TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "deliveryId" TEXT NOT NULL,
  payload JSONB NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "provider_event_deliveries_pkey" PRIMARY KEY (id),
  CONSTRAINT "provider_event_deliveries_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "provider_events"(id)
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "provider_event_deliveries_eventId_deliveryId_key"
  ON "provider_event_deliveries"("eventId", "deliveryId");
CREATE INDEX "provider_event_deliveries_deliveryId_receivedAt_idx"
  ON "provider_event_deliveries"("deliveryId", "receivedAt");
