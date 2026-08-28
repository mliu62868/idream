-- Main becomes the only product authority for Companion Chat sessions and Turns.
-- packages/chat keeps AgentRun files only and no longer owns product message rows.

BEGIN;

ALTER TABLE "recent_chats"
  ADD COLUMN IF NOT EXISTS "memoryEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "activeKey" TEXT,
  ADD COLUMN IF NOT EXISTS "contextRevision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "characterContentVersionId" TEXT,
  ADD COLUMN IF NOT EXISTS "characterReleaseId" TEXT,
  ADD COLUMN IF NOT EXISTS "releasePinnedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "entryExposureId" TEXT,
  ADD COLUMN IF NOT EXISTS "entryJourneyId" TEXT,
  ADD COLUMN IF NOT EXISTS "entryPlacementId" TEXT,
  ADD COLUMN IF NOT EXISTS "openingMessage" TEXT,
  ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Legacy projection writers allowed several active sessions for the same user
-- and character. Preserve every row, but keep only the most recent one active.
WITH ranked_active_sessions AS (
  SELECT
    "sessionId",
    row_number() OVER (
      PARTITION BY "userId", "characterId"
      ORDER BY "lastMessageAt" DESC NULLS LAST, "createdAt" DESC, "sessionId" DESC
    ) AS recency_rank
  FROM "recent_chats"
  WHERE status = 'active'
)
UPDATE "recent_chats" AS chat
SET
  "activeKey" = CASE
    WHEN ranked.recency_rank = 1 THEN chat."userId" || ':' || chat."characterId"
    ELSE NULL
  END,
  status = CASE WHEN ranked.recency_rank = 1 THEN chat.status ELSE 'archived' END,
  "updatedAt" = CURRENT_TIMESTAMP
FROM ranked_active_sessions AS ranked
WHERE ranked."sessionId" = chat."sessionId";

UPDATE "recent_chats"
SET "activeKey" = NULL
WHERE status <> 'active';

CREATE UNIQUE INDEX IF NOT EXISTS "recent_chats_activeKey_key" ON "recent_chats"("activeKey");

CREATE TABLE IF NOT EXISTS "chat_turns" (
  "id" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "attempt" INTEGER NOT NULL DEFAULT 1,
  "idempotencyKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "userMessageId" TEXT NOT NULL,
  "assistantMessageId" TEXT NOT NULL,
  "userContent" TEXT NOT NULL,
  "userStatus" TEXT NOT NULL DEFAULT 'sent',
  "assistantContent" TEXT NOT NULL DEFAULT '',
  "assistantStatus" TEXT NOT NULL DEFAULT 'pending',
  "model" TEXT,
  "promptTokens" INTEGER,
  "completionTokens" INTEGER,
  "terminalEvidence" JSONB,
  "characterContentVersionId" TEXT,
  "characterReleaseId" TEXT,
  "memoryEnabled" BOOLEAN NOT NULL,
  "sceneVersion" INTEGER NOT NULL DEFAULT 0,
  "scene" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "terminalAt" TIMESTAMP(3),
  CONSTRAINT "chat_turns_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "chat_turns_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "recent_chats"("sessionId") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "chat_turns_userMessageId_key" ON "chat_turns"("userMessageId");
CREATE UNIQUE INDEX IF NOT EXISTS "chat_turns_assistantMessageId_key" ON "chat_turns"("assistantMessageId");
CREATE UNIQUE INDEX IF NOT EXISTS "chat_turns_sessionId_idempotencyKey_key" ON "chat_turns"("sessionId", "idempotencyKey");
CREATE INDEX IF NOT EXISTS "chat_turns_sessionId_createdAt_idx" ON "chat_turns"("sessionId", "createdAt");
CREATE INDEX IF NOT EXISTS "chat_turns_assistantStatus_updatedAt_idx" ON "chat_turns"("assistantStatus", "updatedAt");

CREATE TABLE IF NOT EXISTS "chat_turn_attachments" (
  "id" TEXT NOT NULL,
  "turnId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'requesting',
  "generationJobId" TEXT,
  "mediaAssetId" TEXT,
  "promptHint" TEXT,
  "width" INTEGER,
  "height" INTEGER,
  "errorCode" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "chat_turn_attachments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "chat_turn_attachments_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "chat_turns"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "chat_turn_attachments_turnId_idx" ON "chat_turn_attachments"("turnId");
CREATE INDEX IF NOT EXISTS "chat_turn_attachments_generationJobId_idx" ON "chat_turn_attachments"("generationJobId");

COMMIT;
