ALTER TABLE "character_qa_runs"
  ADD COLUMN "visualProfileId" TEXT,
  ADD COLUMN "visualProfileVersion" INTEGER,
  ADD COLUMN "visualProfileHash" TEXT,
  ADD COLUMN "referenceSetRevisionId" TEXT,
  ADD COLUMN "referenceSetRevision" INTEGER,
  ADD COLUMN "referenceSetHash" TEXT,
  ADD COLUMN "draftAssetPackHash" TEXT;

CREATE INDEX "character_qa_runs_visualProfileId_referenceSetRevisionId_idx"
  ON "character_qa_runs"("visualProfileId", "referenceSetRevisionId");
