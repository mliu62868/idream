ALTER TABLE "admin_collaboration_activities"
  ADD COLUMN "requestHash" TEXT;

UPDATE "admin_collaboration_activities"
SET "requestHash" = metadata ->> '_requestHash'
WHERE "requestHash" IS NULL;
