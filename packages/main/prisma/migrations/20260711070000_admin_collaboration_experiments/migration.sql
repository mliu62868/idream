ALTER TABLE "admin_saved_views"
  ADD COLUMN "queryState" JSONB,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "idempotencyKey" TEXT;

UPDATE "admin_saved_views"
SET "queryState" = jsonb_build_object(
  'search', '',
  'filters', "filters",
  'sort', jsonb_build_object('field', 'updatedAt', 'direction', 'desc'),
  'pageSize', 50
)
WHERE "queryState" IS NULL;

CREATE UNIQUE INDEX "admin_saved_views_ownerId_idempotencyKey_key"
  ON "admin_saved_views"("ownerId", "idempotencyKey");

CREATE TABLE "admin_collaboration_activities" (
  "id" TEXT NOT NULL,
  "targetType" TEXT NOT NULL,
  "targetId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "body" TEXT,
  "mentionedIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "metadata" JSONB NOT NULL,
  "parentId" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "admin_collaboration_activities_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "admin_collaboration_activities_actorId_idempotencyKey_key"
  ON "admin_collaboration_activities"("actorId", "idempotencyKey");
CREATE INDEX "admin_collaboration_activities_targetType_targetId_createdAt_id_idx"
  ON "admin_collaboration_activities"("targetType", "targetId", "createdAt", "id");
CREATE INDEX "admin_collaboration_activities_mentionedIds_idx"
  ON "admin_collaboration_activities" USING GIN ("mentionedIds");

ALTER TABLE "experiment_definitions"
  ADD COLUMN "stateVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "startedAt" TIMESTAMP(3),
  ADD COLUMN "startedById" TEXT,
  ADD COLUMN "stoppedAt" TIMESTAMP(3),
  ADD COLUMN "stoppedById" TEXT,
  ADD COLUMN "createdById" TEXT,
  ADD COLUMN "createIdempotencyKey" TEXT,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE UNIQUE INDEX "experiment_definitions_createdById_createIdempotencyKey_key"
  ON "experiment_definitions"("createdById", "createIdempotencyKey");
