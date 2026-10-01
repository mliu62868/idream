ALTER TABLE "chat_turns" ADD COLUMN "executionDeadlineAt" TIMESTAMP(3);
CREATE INDEX "chat_turns_assistantStatus_executionDeadlineAt_idx"
  ON "chat_turns"("assistantStatus", "executionDeadlineAt");

ALTER TABLE "chat_turn_usage_facts" ADD COLUMN "consumedAt" TIMESTAMP(3);

-- A sent reply or an admitted cancellation has already consumed its slot.
-- Reply statistics cannot record the latter; the fact must survive revision.
UPDATE "chat_turn_usage_facts" AS fact
   SET "consumedAt" = COALESCE(turn."statsCountedAt", turn."terminalAt", fact."createdAt"),
       "voidedAt" = NULL
  FROM "chat_turns" AS turn
 WHERE turn.id = fact."turnId"
   AND (turn."statsCountedAt" IS NOT NULL
     OR turn."assistantStatus" = 'sent'
     OR (turn."assistantStatus" = 'cancelled' AND turn."admittedAt" IS NOT NULL));
