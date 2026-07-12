ALTER TABLE "operational_work_preferences"
ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "operational_work_preferences"
ADD CONSTRAINT "operational_work_preferences_version_check"
CHECK ("version" > 0);
