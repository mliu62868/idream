ALTER TABLE "content_production_batches"
  ADD COLUMN "ownerId" TEXT,
  ADD COLUMN "dueAt" TIMESTAMP(3),
  ADD COLUMN "priority" TEXT NOT NULL DEFAULT 'normal',
  ADD COLUMN "lifecycleState" TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN "workflowStage" TEXT NOT NULL DEFAULT 'generation',
  ADD COLUMN "verificationState" TEXT NOT NULL DEFAULT 'pending';

UPDATE "content_production_batches"
SET "lifecycleState" = CASE
  WHEN "status" = 'draft' THEN 'draft'
  WHEN "status" = 'archived' THEN 'archived'
  ELSE 'active'
END,
"workflowStage" = CASE
  WHEN "status" IN ('reviewing', 'completed') THEN 'review'
  ELSE 'generation'
END;

ALTER TABLE "content_production_items"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "media_asset_placements"
  ADD COLUMN "verificationState" TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN "verificationEvidence" JSONB,
  ADD COLUMN "verifiedAt" TIMESTAMP(3),
  ADD COLUMN "rollbackPlacementId" TEXT,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "generation_attempts"
  ADD COLUMN "sourceCommandId" TEXT,
  ADD COLUMN "creativeRunItemId" TEXT;

CREATE UNIQUE INDEX "generation_attempts_sourceCommandId_creativeRunItemId_key"
  ON "generation_attempts"("sourceCommandId", "creativeRunItemId");
CREATE INDEX "generation_attempts_sourceCommandId_status_idx"
  ON "generation_attempts"("sourceCommandId", "status");

CREATE TABLE "creative_review_decisions" (
  "id" TEXT NOT NULL,
  "runItemId" TEXT NOT NULL,
  "artifactId" TEXT NOT NULL,
  "decision" TEXT NOT NULL,
  "identityConsistency" TEXT NOT NULL,
  "score" INTEGER,
  "reason" TEXT NOT NULL,
  "reviewerId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "creative_review_decisions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "creative_review_decisions_runItemId_createdAt_idx"
  ON "creative_review_decisions"("runItemId", "createdAt");
CREATE INDEX "creative_review_decisions_artifactId_createdAt_idx"
  ON "creative_review_decisions"("artifactId", "createdAt");
