CREATE TABLE "group_conversations" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "nextOrdinal" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "group_conversations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "group_conversations_status_check" CHECK ("status" IN ('active', 'archived')),
  CONSTRAINT "group_conversations_nextOrdinal_check" CHECK ("nextOrdinal" > 0)
);
ALTER TABLE "recent_chats" ADD COLUMN "groupId" TEXT, ADD COLUMN "groupPosition" INTEGER;
ALTER TABLE "recent_chats" ADD CONSTRAINT "recent_chats_group_position_check"
  CHECK (("groupId" IS NULL AND "groupPosition" IS NULL) OR ("groupId" IS NOT NULL AND "groupPosition" BETWEEN 0 AND 11 AND "activeKey" IS NULL));
CREATE TABLE "group_chat_turns" (
  "groupId" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "turnId" TEXT NOT NULL,
  CONSTRAINT "group_chat_turns_pkey" PRIMARY KEY ("groupId", "ordinal"),
  CONSTRAINT "group_chat_turns_ordinal_check" CHECK ("ordinal" > 0)
);
CREATE INDEX "group_conversations_userId_updatedAt_idx" ON "group_conversations"("userId", "updatedAt");
CREATE UNIQUE INDEX "recent_chats_groupId_characterId_key" ON "recent_chats"("groupId", "characterId");
CREATE UNIQUE INDEX "recent_chats_groupId_groupPosition_key" ON "recent_chats"("groupId", "groupPosition");
CREATE UNIQUE INDEX "group_chat_turns_turnId_key" ON "group_chat_turns"("turnId");
ALTER TABLE "group_conversations" ADD CONSTRAINT "group_conversations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "recent_chats" ADD CONSTRAINT "recent_chats_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "group_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "group_chat_turns" ADD CONSTRAINT "group_chat_turns_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "group_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "group_chat_turns" ADD CONSTRAINT "group_chat_turns_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "chat_turns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
