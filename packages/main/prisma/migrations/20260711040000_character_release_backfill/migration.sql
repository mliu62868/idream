-- Phase 2 Character / Release / Visual Identity truth and resumable backfill.
ALTER TABLE "character_visual_profiles"
ADD COLUMN "immutableHash" TEXT,
ADD COLUMN "evidenceState" TEXT NOT NULL DEFAULT 'legacy_candidate';

ALTER TABLE "reference_set_revisions"
ADD COLUMN "snapshotHash" TEXT;

-- Expand permits truthful legacy-incomplete snapshots during M3. Cutover remains
-- blocked until reconciliation proves current live releases have all exact refs.
ALTER TABLE "character_releases"
ALTER COLUMN "visualProfileId" DROP NOT NULL,
ALTER COLUMN "visualProfileVersion" DROP NOT NULL,
ALTER COLUMN "referenceSetRevisionId" DROP NOT NULL,
ADD COLUMN "readiness" TEXT NOT NULL DEFAULT 'unknown',
ADD COLUMN "legacy" BOOLEAN NOT NULL DEFAULT false;

-- An exact historical snapshot can legitimately be published again by rollback.
-- Idempotency is command-owned, not enforced by forbidding identical snapshots.
DROP INDEX "character_releases_projectId_snapshotHash_key";
CREATE INDEX "character_releases_projectId_snapshotHash_idx"
ON "character_releases"("projectId", "snapshotHash");

ALTER TABLE "control_plane_commands"
ADD COLUMN "requestPayload" JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE "character_release_events" (
    "id" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "characterId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "actorId" TEXT,
    "commandId" TEXT,
    "reason" TEXT,
    "fromState" JSONB NOT NULL,
    "toState" JSONB NOT NULL,
    "evidence" JSONB NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "character_release_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "character_release_events_commandId_key"
ON "character_release_events"("commandId");
CREATE INDEX "character_release_events_releaseId_occurredAt_idx"
ON "character_release_events"("releaseId", "occurredAt");
CREATE INDEX "character_release_events_characterId_occurredAt_idx"
ON "character_release_events"("characterId", "occurredAt");

CREATE TABLE "admin_backfill_runs" (
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "cursor" TEXT,
    "stopAtId" TEXT,
    "batchSize" INTEGER NOT NULL,
    "optionsHash" TEXT NOT NULL,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "summary" JSONB NOT NULL,
    "report" JSONB,
    "reportHash" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),
    CONSTRAINT "admin_backfill_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "admin_backfill_runs_domain_status_updatedAt_idx"
ON "admin_backfill_runs"("domain", "status", "updatedAt");

CREATE TABLE "admin_backfill_items" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "classification" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "mismatches" JSONB NOT NULL,
    "checksum" TEXT NOT NULL,
    "applied" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "admin_backfill_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "admin_backfill_items_runId_entityType_entityId_key"
ON "admin_backfill_items"("runId", "entityType", "entityId");
CREATE INDEX "admin_backfill_items_entityType_entityId_createdAt_idx"
ON "admin_backfill_items"("entityType", "entityId", "createdAt");

ALTER TABLE "character_serving"
ADD CONSTRAINT "character_serving_schedule_pair_check"
CHECK (("scheduledReleaseId" IS NULL) = ("scheduledAt" IS NULL));

ALTER TABLE "character_releases"
ADD CONSTRAINT "character_release_visual_pair_check"
CHECK (("visualProfileId" IS NULL) = ("visualProfileVersion" IS NULL));

ALTER TABLE "character_releases"
ADD CONSTRAINT "character_release_readiness_check"
CHECK ("readiness" IN ('unknown', 'ready', 'blocked', 'stale'));

ALTER TABLE "character_visual_profiles"
ADD CONSTRAINT "character_visual_profile_evidence_state_check"
CHECK ("evidenceState" IN ('legacy_candidate', 'candidate', 'qualified', 'stale'));

ALTER TABLE "admin_backfill_runs"
ADD CONSTRAINT "admin_backfill_run_mode_check"
CHECK ("mode" IN ('dry_run', 'apply')),
ADD CONSTRAINT "admin_backfill_run_status_check"
CHECK ("status" IN ('running', 'paused', 'completed', 'failed')),
ADD CONSTRAINT "admin_backfill_run_batch_size_check"
CHECK ("batchSize" > 0);
