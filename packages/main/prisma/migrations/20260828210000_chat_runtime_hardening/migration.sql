-- Harden Main-owned Companion Chat execution, memory lifecycle and metering.
-- This migration is intentionally operator-applied; application code never
-- mutates the production schema at runtime.

BEGIN;

ALTER TABLE "recent_chats"
  ADD COLUMN IF NOT EXISTS "characterVisualProfileId" TEXT,
  ADD COLUMN IF NOT EXISTS "characterVisualProfileVersion" INTEGER;

ALTER TABLE "chat_turns"
  ADD COLUMN IF NOT EXISTS "characterVisualProfileId" TEXT,
  ADD COLUMN IF NOT EXISTS "characterVisualProfileVersion" INTEGER,
  ADD COLUMN IF NOT EXISTS "executionSnapshot" JSONB,
  ADD COLUMN IF NOT EXISTS "admissionAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "admissionNextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "admissionLeaseToken" TEXT,
  ADD COLUMN IF NOT EXISTS "admissionLeaseUntil" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "admissionLastError" JSONB,
  ADD COLUMN IF NOT EXISTS "admittedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "statsCountedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "chat_turns_assistantStatus_admissionNextRunAt_admissionLeaseUntil_idx"
  ON "chat_turns"("assistantStatus", "admissionNextRunAt", "admissionLeaseUntil");

CREATE TABLE IF NOT EXISTS "chat_turn_usage_facts" (
  "turnId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "productDay" DATE NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "chat_turn_usage_facts_pkey" PRIMARY KEY ("turnId"),
  CONSTRAINT "chat_turn_usage_facts_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "chat_turn_usage_facts_userId_productDay_idx"
  ON "chat_turn_usage_facts"("userId", "productDay");

INSERT INTO "chat_turn_usage_facts" ("turnId", "userId", "productDay", "createdAt")
SELECT turn."id", session."userId", turn."createdAt"::date, turn."createdAt"
FROM "chat_turns" AS turn
JOIN "recent_chats" AS session ON session."sessionId" = turn."sessionId"
WHERE turn."userStatus" = 'sent'
ON CONFLICT ("turnId") DO NOTHING;

CREATE TABLE IF NOT EXISTS "companion_memory_authorities" (
  "aggregateId" TEXT NOT NULL,
  "version" BIGINT NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "companion_memory_authorities_pkey" PRIMARY KEY ("aggregateId")
);

INSERT INTO "companion_memory_authorities" ("aggregateId", "version", "updatedAt")
SELECT
  "aggregateId",
  MAX((payload -> 'payload' ->> 'authorityVersion')::bigint),
  CURRENT_TIMESTAMP
FROM "main_outbox_events"
WHERE "eventType" = 'chat.companion_memory.rebuild_requested.v1'
  AND payload -> 'payload' ->> 'authorityVersion' ~ '^[1-9][0-9]*$'
GROUP BY "aggregateId"
ON CONFLICT ("aggregateId") DO UPDATE
SET "version" = GREATEST(
  "companion_memory_authorities"."version",
  EXCLUDED."version"
), "updatedAt" = CURRENT_TIMESTAMP;

UPDATE "recent_chats" AS session
SET
  "characterVisualProfileId" = release."visualProfileId",
  "characterVisualProfileVersion" = release."visualProfileVersion"
FROM "character_releases" AS release
WHERE session."characterReleaseId" = release."id"
  AND session."characterVisualProfileId" IS NULL;

UPDATE "chat_turns" AS turn
SET
  "characterVisualProfileId" = session."characterVisualProfileId",
  "characterVisualProfileVersion" = session."characterVisualProfileVersion",
  "statsCountedAt" = CASE
    WHEN turn."assistantStatus" = 'sent' THEN COALESCE(turn."terminalAt", turn."updatedAt")
    ELSE turn."statsCountedAt"
  END
FROM "recent_chats" AS session
WHERE turn."sessionId" = session."sessionId";

ALTER TABLE "recent_chats"
  ADD CONSTRAINT "recent_chats_characterVisualProfile_pin_check"
  CHECK (
    ("characterVisualProfileId" IS NULL AND "characterVisualProfileVersion" IS NULL)
    OR (
      "characterVisualProfileId" IS NOT NULL
      AND "characterVisualProfileVersion" IS NOT NULL
      AND "characterVisualProfileVersion" > 0
    )
  );

ALTER TABLE "chat_turns"
  ADD CONSTRAINT "chat_turns_characterVisualProfile_pin_check"
  CHECK (
    ("characterVisualProfileId" IS NULL AND "characterVisualProfileVersion" IS NULL)
    OR (
      "characterVisualProfileId" IS NOT NULL
      AND "characterVisualProfileVersion" IS NOT NULL
      AND "characterVisualProfileVersion" > 0
    )
  );

ALTER TABLE "main_outbox_events"
  ADD COLUMN IF NOT EXISTS "leaseToken" TEXT,
  ADD COLUMN IF NOT EXISTS "leaseExpiresAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "main_outbox_events_status_nextRunAt_leaseExpiresAt_idx"
  ON "main_outbox_events"("status", "nextRunAt", "leaseExpiresAt");

COMMIT;
