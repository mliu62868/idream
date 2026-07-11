-- GenerationJob is the deployed physical table for the GenerationRequest
-- logical authority during this expand/cutover. Add the missing request-level
-- outcome, terminal-time and optimistic-lock fields without renaming the table.
ALTER TABLE "generation_jobs"
  ADD COLUMN "deliveredOutputCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "finishedAt" TIMESTAMP(3),
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

-- Only successful legacy rows may inherit completedAt as a true terminal time.
UPDATE "generation_jobs"
SET "finishedAt" = "completedAt",
    "deliveredOutputCount" = LEAST("outputCount", (
      SELECT COUNT(*)::integer FROM "media_assets" a WHERE a."sourceJobId" = "generation_jobs"."id"
    ))
WHERE "status" = 'completed' AND "completedAt" IS NOT NULL;

ALTER TABLE "generation_jobs"
  ADD CONSTRAINT "generation_jobs_output_counts_check"
  CHECK ("outputCount" > 0 AND "deliveredOutputCount" >= 0 AND "deliveredOutputCount" <= "outputCount");
