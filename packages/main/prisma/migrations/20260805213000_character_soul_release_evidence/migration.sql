-- Character Soul release gates require immutable behavior and exact-model
-- canary evidence. Existing QA rows remain historical and intentionally fail
-- the new Release gate until a fresh QA Run records these fields.

ALTER TABLE "character_qa_runs"
  ADD COLUMN "behavior_evaluation" JSONB,
  ADD COLUMN "live_canaries" JSONB;
