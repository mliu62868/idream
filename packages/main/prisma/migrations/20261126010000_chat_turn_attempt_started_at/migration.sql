-- The pending-admission TTL needs the instant the current attempt entered
-- `pending`. createdAt only describes the first attempt; regenerate and edit
-- restart it. Existing rows take their last write as the best available start.
ALTER TABLE "chat_turns" ADD COLUMN "attemptStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
UPDATE "chat_turns" SET "attemptStartedAt" = "updatedAt";
