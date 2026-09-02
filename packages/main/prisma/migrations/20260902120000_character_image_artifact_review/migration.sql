-- A generated-image review keeps its ContentProductionItem lineage. An
-- operator-upload review is bound directly to CreativeReviewDecision.artifactId
-- and deliberately has no fabricated generation item.
ALTER TABLE "creative_review_decisions"
  ALTER COLUMN "runItemId" DROP NOT NULL;
