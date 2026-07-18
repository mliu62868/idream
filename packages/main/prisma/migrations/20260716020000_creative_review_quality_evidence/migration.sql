ALTER TABLE "creative_review_decisions"
ADD COLUMN "evidence" JSONB NOT NULL DEFAULT '{}'::jsonb;
