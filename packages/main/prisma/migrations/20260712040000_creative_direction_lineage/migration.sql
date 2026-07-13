ALTER TABLE "content_production_items"
  ADD COLUMN "directionId" TEXT,
  ADD COLUMN "directionSnapshot" JSONB,
  ADD COLUMN "directionHash" TEXT;

CREATE INDEX "content_production_items_batchId_directionId_idx"
  ON "content_production_items"("batchId", "directionId");

ALTER TABLE "content_production_items"
  ADD CONSTRAINT "content_production_items_direction_snapshot_check"
  CHECK (
    ("directionId" IS NULL AND "directionSnapshot" IS NULL AND "directionHash" IS NULL)
    OR
    ("directionId" IS NOT NULL AND "directionSnapshot" IS NOT NULL AND "directionHash" IS NOT NULL)
  );
