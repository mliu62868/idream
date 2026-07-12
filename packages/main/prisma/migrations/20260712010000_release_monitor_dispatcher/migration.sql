ALTER TABLE "release_monitors"
  ADD COLUMN "dueAt" TIMESTAMP(3),
  ADD COLUMN "leaseOwner" TEXT,
  ADD COLUMN "leaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "nextAttemptAt" TIMESTAMP(3),
  ADD COLUMN "lastError" JSONB;

UPDATE "release_monitors"
SET "dueAt" = "startedAt" + CASE "window"
  WHEN '24h' THEN INTERVAL '24 hours'
  WHEN '72h' THEN INTERVAL '72 hours'
END
WHERE "dueAt" IS NULL
  AND "window" IN ('24h', '72h');

CREATE INDEX "release_monitors_status_dueAt_leaseExpiresAt_idx"
  ON "release_monitors"("status", "dueAt", "leaseExpiresAt");
