-- AlterTable
ALTER TABLE "ai_usage_facts" ADD COLUMN     "actorIsInternal" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "dataClass" TEXT NOT NULL DEFAULT 'customer',
ADD COLUMN     "environment" TEXT NOT NULL DEFAULT 'local',
ADD COLUMN     "sourceEventId" TEXT,
ADD COLUMN     "sourceService" TEXT NOT NULL DEFAULT 'main',
ADD COLUMN     "trustClass" TEXT NOT NULL DEFAULT 'canonical';

-- CreateTable
CREATE TABLE "metric_projection_receipts" (
    "id" TEXT NOT NULL,
    "sourceService" TEXT NOT NULL,
    "sourceEventId" TEXT NOT NULL,
    "canonicalEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "factType" TEXT,
    "factId" TEXT,
    "reason" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "metric_projection_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_signup_facts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sourceService" TEXT NOT NULL,
    "sourceEventId" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "dataClass" TEXT NOT NULL,
    "trustClass" TEXT NOT NULL,
    "actorIsInternal" BOOLEAN NOT NULL DEFAULT false,
    "eligible" BOOLEAN NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "coverageState" TEXT NOT NULL DEFAULT 'exact',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_signup_facts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_exchange_facts" (
    "id" TEXT NOT NULL,
    "exchangeId" TEXT NOT NULL,
    "sourceService" TEXT NOT NULL,
    "sourceEventId" TEXT NOT NULL,
    "userMessageId" TEXT NOT NULL,
    "assistantMessageId" TEXT NOT NULL,
    "selectedAssistantMessageId" TEXT NOT NULL,
    "assistantAttemptNo" INTEGER NOT NULL,
    "correctionRevision" INTEGER NOT NULL DEFAULT 0,
    "correctionType" TEXT,
    "sessionId" TEXT NOT NULL,
    "engagementSessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "characterId" TEXT NOT NULL,
    "characterContentVersionId" TEXT NOT NULL,
    "characterReleaseId" TEXT,
    "environment" TEXT NOT NULL,
    "dataClass" TEXT NOT NULL,
    "trustClass" TEXT NOT NULL,
    "actorIsInternal" BOOLEAN NOT NULL DEFAULT false,
    "eligible" BOOLEAN NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "productDay" DATE NOT NULL,
    "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "coverageState" TEXT NOT NULL DEFAULT 'exact',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_exchange_facts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generation_fulfillment_facts" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "sourceService" TEXT NOT NULL,
    "sourceEventId" TEXT NOT NULL,
    "artifactId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "characterId" TEXT,
    "characterReleaseId" TEXT,
    "placementId" TEXT,
    "expectedOutputCount" INTEGER NOT NULL DEFAULT 1,
    "deliveredOutputCount" INTEGER NOT NULL DEFAULT 1,
    "outcome" TEXT NOT NULL DEFAULT 'succeeded',
    "validArtifact" BOOLEAN NOT NULL DEFAULT true,
    "displayable" BOOLEAN NOT NULL DEFAULT true,
    "environment" TEXT NOT NULL,
    "dataClass" TEXT NOT NULL,
    "trustClass" TEXT NOT NULL,
    "actorIsInternal" BOOLEAN NOT NULL DEFAULT false,
    "eligible" BOOLEAN NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "coverageState" TEXT NOT NULL DEFAULT 'exact_unattributed',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "generation_fulfillment_facts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_lifecycle_facts" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "planId" TEXT,
    "activatedSourceService" TEXT NOT NULL,
    "activatedSourceEventId" TEXT NOT NULL,
    "endedSourceService" TEXT,
    "endedSourceEventId" TEXT,
    "environment" TEXT NOT NULL,
    "dataClass" TEXT NOT NULL,
    "trustClass" TEXT NOT NULL,
    "actorIsInternal" BOOLEAN NOT NULL DEFAULT false,
    "eligible" BOOLEAN NOT NULL,
    "activeAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "validFrom" TIMESTAMP(3) NOT NULL,
    "coverageState" TEXT NOT NULL DEFAULT 'exact',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscription_lifecycle_facts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "character_exposure_facts" (
    "id" TEXT NOT NULL,
    "exposureId" TEXT NOT NULL,
    "sourceService" TEXT NOT NULL,
    "sourceEventId" TEXT NOT NULL,
    "userId" TEXT,
    "anonymousId" TEXT,
    "journeyId" TEXT NOT NULL,
    "characterId" TEXT NOT NULL,
    "characterContentVersionId" TEXT NOT NULL,
    "characterReleaseId" TEXT,
    "placementId" TEXT,
    "visibleRatio" DOUBLE PRECISION NOT NULL,
    "visibleDurationMs" INTEGER NOT NULL,
    "environment" TEXT NOT NULL,
    "dataClass" TEXT NOT NULL,
    "trustClass" TEXT NOT NULL,
    "actorIsInternal" BOOLEAN NOT NULL DEFAULT false,
    "eligible" BOOLEAN NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "coverageState" TEXT NOT NULL DEFAULT 'exact',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "character_exposure_facts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "experiment_exposure_facts" (
    "id" TEXT NOT NULL,
    "exposureId" TEXT NOT NULL,
    "sourceService" TEXT NOT NULL,
    "sourceEventId" TEXT NOT NULL,
    "experimentId" TEXT NOT NULL,
    "experimentVersion" INTEGER NOT NULL,
    "assignmentVersion" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "variant" TEXT NOT NULL,
    "eligible" BOOLEAN NOT NULL,
    "environment" TEXT NOT NULL,
    "dataClass" TEXT NOT NULL,
    "trustClass" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "experiment_exposure_facts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "companion_engagement_daily" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "characterId" TEXT NOT NULL,
    "productDay" DATE NOT NULL,
    "metricVersion" INTEGER NOT NULL DEFAULT 1,
    "exchangeCount" INTEGER NOT NULL,
    "engagementSessions" INTEGER NOT NULL,
    "qceCount" INTEGER NOT NULL,
    "latestOccurredAt" TIMESTAMP(3) NOT NULL,
    "coverageState" TEXT NOT NULL DEFAULT 'exact',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "companion_engagement_daily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "character_funnel_daily" (
    "id" TEXT NOT NULL,
    "characterId" TEXT NOT NULL,
    "characterContentVersionId" TEXT NOT NULL,
    "characterReleaseId" TEXT,
    "placementId" TEXT,
    "productDay" DATE NOT NULL,
    "metricVersion" INTEGER NOT NULL DEFAULT 1,
    "eligibleImpressions" INTEGER NOT NULL DEFAULT 0,
    "detailViews" INTEGER NOT NULL DEFAULT 0,
    "firstSuccessfulExchanges" INTEGER NOT NULL DEFAULT 0,
    "qceCount" INTEGER NOT NULL DEFAULT 0,
    "relationshipActivations" INTEGER NOT NULL DEFAULT 0,
    "sameCharacterD7Returns" INTEGER NOT NULL DEFAULT 0,
    "paidAttributions" INTEGER NOT NULL DEFAULT 0,
    "coverageState" TEXT NOT NULL DEFAULT 'exact',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "character_funnel_daily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metric_snapshots" (
    "id" TEXT NOT NULL,
    "metricKey" TEXT NOT NULL,
    "definitionVersion" INTEGER NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "asOf" TIMESTAMP(3) NOT NULL,
    "numeratorValue" DOUBLE PRECISION,
    "denominatorValue" DOUBLE PRECISION,
    "value" DOUBLE PRECISION,
    "sampleSize" INTEGER NOT NULL,
    "matureSampleSize" INTEGER NOT NULL,
    "immatureSampleSize" INTEGER NOT NULL,
    "maturity" TEXT NOT NULL,
    "qualityState" TEXT NOT NULL,
    "publicationStatus" TEXT NOT NULL,
    "latestDataAt" TIMESTAMP(3),
    "definitionQueryHash" TEXT NOT NULL,
    "qualityEvidence" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "metric_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_quality_checks" (
    "id" TEXT NOT NULL,
    "checkKey" TEXT NOT NULL,
    "checkVersion" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL,
    "metricKeys" JSONB NOT NULL,
    "observed" JSONB NOT NULL,
    "threshold" JSONB NOT NULL,
    "evidence" JSONB NOT NULL,
    "windowStart" TIMESTAMP(3),
    "windowEnd" TIMESTAMP(3),
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "data_quality_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metric_backfill_runs" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "dryRun" BOOLEAN NOT NULL DEFAULT true,
    "cursor" TEXT,
    "batchSize" INTEGER NOT NULL,
    "scannedCount" INTEGER NOT NULL DEFAULT 0,
    "appliedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "mismatchCount" INTEGER NOT NULL DEFAULT 0,
    "coverage" DOUBLE PRECISION,
    "validFrom" TIMESTAMP(3),
    "beforeSnapshot" JSONB NOT NULL,
    "afterSnapshot" JSONB NOT NULL,
    "mismatchReport" JSONB NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "metric_backfill_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "metric_projection_receipts_outcome_processedAt_idx" ON "metric_projection_receipts"("outcome", "processedAt");

-- CreateIndex
CREATE INDEX "metric_projection_receipts_canonicalEventId_idx" ON "metric_projection_receipts"("canonicalEventId");

-- CreateIndex
CREATE UNIQUE INDEX "metric_projection_receipts_sourceService_sourceEventId_key" ON "metric_projection_receipts"("sourceService", "sourceEventId");

-- CreateIndex
CREATE UNIQUE INDEX "customer_signup_facts_userId_key" ON "customer_signup_facts"("userId");

-- CreateIndex
CREATE INDEX "customer_signup_facts_eligible_occurredAt_idx" ON "customer_signup_facts"("eligible", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "customer_signup_facts_sourceService_sourceEventId_key" ON "customer_signup_facts"("sourceService", "sourceEventId");

-- CreateIndex
CREATE UNIQUE INDEX "chat_exchange_facts_exchangeId_key" ON "chat_exchange_facts"("exchangeId");

-- CreateIndex
CREATE INDEX "chat_exchange_facts_userId_characterId_productDay_engagemen_idx" ON "chat_exchange_facts"("userId", "characterId", "productDay", "engagementSessionId");

-- CreateIndex
CREATE INDEX "chat_exchange_facts_eligible_occurredAt_idx" ON "chat_exchange_facts"("eligible", "occurredAt");

-- CreateIndex
CREATE INDEX "chat_exchange_facts_characterContentVersionId_characterRele_idx" ON "chat_exchange_facts"("characterContentVersionId", "characterReleaseId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "chat_exchange_facts_sourceService_sourceEventId_key" ON "chat_exchange_facts"("sourceService", "sourceEventId");

-- CreateIndex
CREATE UNIQUE INDEX "generation_fulfillment_facts_requestId_key" ON "generation_fulfillment_facts"("requestId");

-- CreateIndex
CREATE INDEX "generation_fulfillment_facts_userId_eligible_occurredAt_idx" ON "generation_fulfillment_facts"("userId", "eligible", "occurredAt");

-- CreateIndex
CREATE INDEX "generation_fulfillment_facts_characterId_characterReleaseId_idx" ON "generation_fulfillment_facts"("characterId", "characterReleaseId", "placementId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "generation_fulfillment_facts_sourceService_sourceEventId_key" ON "generation_fulfillment_facts"("sourceService", "sourceEventId");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_lifecycle_facts_subscriptionId_key" ON "subscription_lifecycle_facts"("subscriptionId");

-- CreateIndex
CREATE INDEX "subscription_lifecycle_facts_userId_activeAt_endedAt_idx" ON "subscription_lifecycle_facts"("userId", "activeAt", "endedAt");

-- CreateIndex
CREATE INDEX "subscription_lifecycle_facts_eligible_activeAt_idx" ON "subscription_lifecycle_facts"("eligible", "activeAt");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_lifecycle_facts_activatedSourceService_activat_key" ON "subscription_lifecycle_facts"("activatedSourceService", "activatedSourceEventId");

-- CreateIndex
CREATE UNIQUE INDEX "character_exposure_facts_exposureId_key" ON "character_exposure_facts"("exposureId");

-- CreateIndex
CREATE INDEX "character_exposure_facts_characterId_characterReleaseId_pla_idx" ON "character_exposure_facts"("characterId", "characterReleaseId", "placementId", "occurredAt");

-- CreateIndex
CREATE INDEX "character_exposure_facts_journeyId_characterId_placementId_idx" ON "character_exposure_facts"("journeyId", "characterId", "placementId");

-- CreateIndex
CREATE UNIQUE INDEX "character_exposure_facts_sourceService_sourceEventId_key" ON "character_exposure_facts"("sourceService", "sourceEventId");

-- CreateIndex
CREATE UNIQUE INDEX "experiment_exposure_facts_exposureId_key" ON "experiment_exposure_facts"("exposureId");

-- CreateIndex
CREATE INDEX "experiment_exposure_facts_experimentId_experimentVersion_va_idx" ON "experiment_exposure_facts"("experimentId", "experimentVersion", "variant", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "experiment_exposure_facts_sourceService_sourceEventId_key" ON "experiment_exposure_facts"("sourceService", "sourceEventId");

-- CreateIndex
CREATE INDEX "companion_engagement_daily_productDay_qceCount_idx" ON "companion_engagement_daily"("productDay", "qceCount");

-- CreateIndex
CREATE UNIQUE INDEX "companion_engagement_daily_userId_characterId_productDay_me_key" ON "companion_engagement_daily"("userId", "characterId", "productDay", "metricVersion");

-- CreateIndex
CREATE INDEX "character_funnel_daily_characterId_productDay_idx" ON "character_funnel_daily"("characterId", "productDay");

-- CreateIndex
CREATE UNIQUE INDEX "character_funnel_daily_characterContentVersionId_characterR_key" ON "character_funnel_daily"("characterContentVersionId", "characterReleaseId", "placementId", "productDay", "metricVersion");

-- CreateIndex
CREATE INDEX "metric_snapshots_qualityState_asOf_idx" ON "metric_snapshots"("qualityState", "asOf");

-- CreateIndex
CREATE UNIQUE INDEX "metric_snapshots_metricKey_definitionVersion_windowStart_wi_key" ON "metric_snapshots"("metricKey", "definitionVersion", "windowStart", "windowEnd", "asOf");

-- CreateIndex
CREATE INDEX "data_quality_checks_checkKey_checkedAt_idx" ON "data_quality_checks"("checkKey", "checkedAt");

-- CreateIndex
CREATE INDEX "data_quality_checks_status_checkedAt_idx" ON "data_quality_checks"("status", "checkedAt");

-- CreateIndex
CREATE INDEX "metric_backfill_runs_source_status_updatedAt_idx" ON "metric_backfill_runs"("source", "status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ai_usage_facts_sourceService_sourceEventId_key" ON "ai_usage_facts"("sourceService", "sourceEventId");

-- Canonical metric fact invariants. Facts fail closed at the database boundary;
-- a row marked eligible can never be fixture/internal/non-canonical data.
ALTER TABLE "customer_signup_facts" ADD CONSTRAINT "customer_signup_facts_eligible_check"
  CHECK (NOT "eligible" OR ("environment" = 'production' AND "dataClass" = 'customer' AND "trustClass" = 'canonical' AND NOT "actorIsInternal"));
ALTER TABLE "chat_exchange_facts" ADD CONSTRAINT "chat_exchange_facts_eligible_check"
  CHECK (NOT "eligible" OR ("environment" = 'production' AND "dataClass" = 'customer' AND "trustClass" = 'canonical' AND NOT "actorIsInternal"));
ALTER TABLE "chat_exchange_facts" ADD CONSTRAINT "chat_exchange_facts_attempt_check"
  CHECK ("assistantAttemptNo" > 0 AND "correctionRevision" >= 0);
ALTER TABLE "generation_fulfillment_facts" ADD CONSTRAINT "generation_fulfillment_facts_eligible_check"
  CHECK (NOT "eligible" OR ("environment" = 'production' AND "dataClass" = 'customer' AND "trustClass" = 'canonical' AND NOT "actorIsInternal" AND "validArtifact" AND "displayable"));
ALTER TABLE "generation_fulfillment_facts" ADD CONSTRAINT "generation_fulfillment_facts_counts_check"
  CHECK ("expectedOutputCount" > 0 AND "deliveredOutputCount" >= 0 AND "deliveredOutputCount" <= "expectedOutputCount");
ALTER TABLE "subscription_lifecycle_facts" ADD CONSTRAINT "subscription_lifecycle_facts_eligible_check"
  CHECK (NOT "eligible" OR ("environment" = 'production' AND "dataClass" = 'customer' AND "trustClass" = 'canonical' AND NOT "actorIsInternal"));
ALTER TABLE "subscription_lifecycle_facts" ADD CONSTRAINT "subscription_lifecycle_facts_time_check"
  CHECK ("endedAt" IS NULL OR "endedAt" >= "activeAt");
ALTER TABLE "metric_snapshots" ADD CONSTRAINT "metric_snapshots_cohort_check"
  CHECK ("numeratorValue" IS NULL OR "denominatorValue" IS NULL OR "numeratorValue" <= "denominatorValue");
ALTER TABLE "ai_usage_facts" ADD CONSTRAINT "ai_usage_facts_cost_check"
  CHECK ("costMicros" IS NULL OR "costMicros" >= 0);
