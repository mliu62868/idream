CREATE TABLE "deleted_chat_turn_sends" (
    "userId" TEXT NOT NULL,
    "conversationKey" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,

    CONSTRAINT "deleted_chat_turn_sends_pkey" PRIMARY KEY ("userId", "conversationKey", "keyHash"),
    CONSTRAINT "deleted_chat_turn_sends_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
