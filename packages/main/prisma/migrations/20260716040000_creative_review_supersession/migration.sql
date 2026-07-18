ALTER TABLE "creative_review_decisions"
  ADD COLUMN "supersedesDecisionId" TEXT;

CREATE INDEX "creative_review_decisions_supersedesDecisionId_idx"
  ON "creative_review_decisions"("supersedesDecisionId");
