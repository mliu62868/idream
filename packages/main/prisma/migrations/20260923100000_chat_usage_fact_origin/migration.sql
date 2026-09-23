-- The daily allowance used to be counted through a JOIN to "chat_turns". Usage
-- facts have no FK to Turns on purpose (deleting a message or a session must
-- not refund the allowance), so the JOIN silently dropped every deleted Turn
-- and handed the allowance back. The fact now carries what the count needs.
ALTER TABLE "chat_turn_usage_facts"
  ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'user',
  ADD COLUMN "voidedAt" TIMESTAMP(3);

-- Facts whose Turn is already gone keep the conservative 'user' default: the
-- Turn that proved otherwise no longer exists.
UPDATE "chat_turn_usage_facts" f
   SET "origin" = t."origin"
  FROM "chat_turns" t
 WHERE t.id = f."turnId"
   AND t."origin" <> 'user';

-- A Turn that failed or was cancelled and never delivered a reply does not
-- spend the allowance (see turn-ledger.ts settleChatTurnUsage).
UPDATE "chat_turn_usage_facts" f
   SET "voidedAt" = COALESCE(t."terminalAt", now())
  FROM "chat_turns" t
 WHERE t.id = f."turnId"
   AND t."assistantStatus" IN ('failed', 'cancelled')
   AND t."statsCountedAt" IS NULL;
