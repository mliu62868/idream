-- Text replies superseded by regenerate, selectable again on the latest Turn.
CREATE TABLE "chat_turn_alternatives" (
    "turnId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "assistantContent" TEXT NOT NULL,
    "model" TEXT,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "finishReason" TEXT,
    "sceneVersion" INTEGER NOT NULL,
    "scene" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_turn_alternatives_pkey" PRIMARY KEY ("turnId","ordinal")
);

ALTER TABLE "chat_turn_alternatives" ADD CONSTRAINT "chat_turn_alternatives_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "chat_turns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
