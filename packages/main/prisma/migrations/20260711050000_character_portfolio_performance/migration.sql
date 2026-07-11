-- Character Portfolio canonical performance/economics facts.
-- Additive only: legacy projections remain readable while v2 fails closed on
-- incomplete attribution or unaudited money authority.

ALTER TABLE "character_exposure_facts"
  ADD COLUMN "eventType" TEXT NOT NULL DEFAULT 'eligible_impression',
  ADD COLUMN "parentExposureId" TEXT;

CREATE INDEX "character_exposure_facts_parentExposureId_eventType_idx"
  ON "character_exposure_facts"("parentExposureId", "eventType");

ALTER TABLE "character_funnel_daily"
  ADD COLUMN "sameCharacterD7EligiblePairs" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "projectionVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "latestDataAt" TIMESTAMP(3),
  ADD COLUMN "sourceEvidence" JSONB NOT NULL DEFAULT '[]';

-- Prisma's nullable composite unique permits duplicate NULL grains in
-- PostgreSQL. This expression index makes the all-placement/all-release grain
-- idempotent as well, including concurrent backfill workers.
CREATE UNIQUE INDEX "character_funnel_daily_canonical_grain_key"
  ON "character_funnel_daily"(
    "characterContentVersionId",
    COALESCE("characterReleaseId", ''),
    COALESCE("placementId", ''),
    "productDay",
    "metricVersion"
  );

ALTER TABLE "decision_records"
  ADD COLUMN "releaseId" TEXT,
  ADD COLUMN "evidenceLevel" TEXT NOT NULL DEFAULT 'observational';

ALTER TABLE "decision_records"
  ADD CONSTRAINT "decision_records_evidence_level_check"
  CHECK ("evidenceLevel" IN ('observational', 'attribution', 'causal'));

CREATE INDEX "decision_records_sourceType_sourceId_releaseId_createdAt_idx"
  ON "decision_records"("sourceType", "sourceId", "releaseId", "createdAt");

CREATE TABLE "character_economics_facts" (
  "id" TEXT NOT NULL,
  "characterId" TEXT NOT NULL,
  "characterContentVersionId" TEXT NOT NULL,
  "characterReleaseId" TEXT NOT NULL,
  "placementId" TEXT,
  "kind" TEXT NOT NULL,
  "amountMicros" BIGINT NOT NULL,
  "currency" TEXT NOT NULL,
  "authorityType" TEXT NOT NULL,
  "authorityId" TEXT NOT NULL,
  "attributionMethod" TEXT NOT NULL,
  "auditState" TEXT NOT NULL DEFAULT 'audited',
  "coverageState" TEXT NOT NULL DEFAULT 'exact',
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "character_economics_facts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "character_economics_facts_amount_nonnegative" CHECK ("amountMicros" >= 0),
  CONSTRAINT "character_economics_facts_kind_check" CHECK ("kind" IN ('cash_revenue', 'refund', 'credit', 'variable_cost')),
  CONSTRAINT "character_economics_facts_audit_state_check" CHECK ("auditState" IN ('audited', 'unaudited')),
  CONSTRAINT "character_economics_facts_coverage_state_check" CHECK ("coverageState" IN ('exact', 'partial', 'unattributed'))
);

CREATE UNIQUE INDEX "character_economics_facts_authorityType_authorityId_kind_key"
  ON "character_economics_facts"("authorityType", "authorityId", "kind");

CREATE INDEX "character_economics_facts_characterId_characterContentVersionId_characterReleaseId_placementId_occurredAt_idx"
  ON "character_economics_facts"("characterId", "characterContentVersionId", "characterReleaseId", "placementId", "occurredAt");

CREATE INDEX "character_economics_facts_auditState_coverageState_occurredAt_idx"
  ON "character_economics_facts"("auditState", "coverageState", "occurredAt");
