-- Paid delayed curated media fulfillment:
-- 1) Server-side delayed reveal schedule on chat_turn_attachments.
-- 2) Enriched official media library metadata (attireLevel, nudityVerifiedById,
--    distributionScope, visual clustering, audioType, paidDeliveryCount).
-- 3) Ledger-grade lifetime deduplication table (user_character_library_receipts)
--    decoupled from chat_turns cascade deletion.

ALTER TABLE "chat_turn_attachments"
  ADD COLUMN "deliverAt" TIMESTAMP(3);

CREATE INDEX "chat_turn_attachments_status_deliverAt_idx"
  ON "chat_turn_attachments"("status", "deliverAt");

ALTER TABLE "character_media_library_entries"
  ADD COLUMN "attireLevel" TEXT,
  ADD COLUMN "nudityVerifiedById" TEXT,
  ADD COLUMN "distributionScope" TEXT NOT NULL DEFAULT 'chat_library',
  ADD COLUMN "nearDuplicateClusterId" TEXT,
  ADD COLUMN "photoSetId" TEXT,
  ADD COLUMN "audioType" TEXT,
  ADD COLUMN "paidDeliveryCount" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "user_character_library_receipts" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "characterId" TEXT NOT NULL,
  "entryId" TEXT NOT NULL,
  "contentHash" TEXT NOT NULL,
  "nearDuplicateClusterId" TEXT,
  "photoSetId" TEXT,
  "kind" TEXT NOT NULL,
  "firstAttachmentId" TEXT NOT NULL,
  "costDreamcoins" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "user_character_library_receipts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_character_library_receipts_userId_characterId_entryId_key"
  ON "user_character_library_receipts"("userId", "characterId", "entryId");

CREATE UNIQUE INDEX "user_character_library_receipts_userId_characterId_contentH_key"
  ON "user_character_library_receipts"("userId", "characterId", "contentHash");

CREATE INDEX "user_character_library_receipts_userId_characterId_kind_cre_idx"
  ON "user_character_library_receipts"("userId", "characterId", "kind", "createdAt");

CREATE INDEX "user_character_library_receipts_userId_characterId_nearDupl_idx"
  ON "user_character_library_receipts"("userId", "characterId", "nearDuplicateClusterId");

ALTER TABLE "user_character_library_receipts"
  ADD CONSTRAINT "user_character_library_receipts_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
