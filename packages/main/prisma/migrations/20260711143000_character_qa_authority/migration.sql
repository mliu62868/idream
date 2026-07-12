CREATE TABLE "character_qa_runs" (
  "id" TEXT NOT NULL,
  "characterId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "characterContentVersionId" TEXT NOT NULL,
  "projectVersion" INTEGER NOT NULL,
  "ownerId" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "checks" JSONB NOT NULL,
  "evidenceHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "character_qa_runs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "character_qa_runs_evidenceHash_key" ON "character_qa_runs"("evidenceHash");
CREATE INDEX "character_qa_runs_characterId_createdAt_idx" ON "character_qa_runs"("characterId", "createdAt");
CREATE INDEX "character_qa_runs_projectId_characterContentVersionId_status_idx" ON "character_qa_runs"("projectId", "characterContentVersionId", "status");

CREATE OR REPLACE FUNCTION reject_character_qa_run_update()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'character_qa_runs are immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "character_qa_runs_immutable_update"
BEFORE UPDATE ON "character_qa_runs"
FOR EACH ROW EXECUTE FUNCTION reject_character_qa_run_update();
