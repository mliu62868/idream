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

CREATE OR REPLACE FUNCTION reject_creative_direction_lineage_update()
RETURNS trigger AS $$
BEGIN
  IF OLD."directionId" IS DISTINCT FROM NEW."directionId"
     OR OLD."directionSnapshot" IS DISTINCT FROM NEW."directionSnapshot"
     OR OLD."directionHash" IS DISTINCT FROM NEW."directionHash" THEN
    RAISE EXCEPTION 'creative direction lineage is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "content_production_items_direction_lineage_immutable"
BEFORE UPDATE ON "content_production_items"
FOR EACH ROW EXECUTE FUNCTION reject_creative_direction_lineage_update();
