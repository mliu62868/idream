-- Keep the selected portrait in Character Project draft authority until a
-- Character Release snapshots and publishes it. The live Character projection
-- is intentionally unchanged by studio selection.
ALTER TABLE "character_projects"
  ADD COLUMN "draftImageAssetId" TEXT,
  ADD COLUMN "draftAssetPack" JSONB NOT NULL DEFAULT '{}';

CREATE INDEX "character_projects_draftImageAssetId_idx"
  ON "character_projects"("draftImageAssetId");

ALTER TABLE "character_projects"
  ADD CONSTRAINT "character_projects_draftImageAssetId_fkey"
  FOREIGN KEY ("draftImageAssetId") REFERENCES "media_assets"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
