-- New, empty settings table only. Existing Turns and their snapshots stay unchanged.
CREATE TABLE "chat_experience_preferences" (
  "sessionId" TEXT NOT NULL,
  "responseLength" TEXT NOT NULL DEFAULT 'auto',
  "interactionIntensity" TEXT NOT NULL DEFAULT 'balanced',
  "version" INTEGER NOT NULL DEFAULT 1,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "chat_experience_preferences_pkey" PRIMARY KEY ("sessionId"),
  CONSTRAINT "chat_experience_preferences_sessionId_fkey" FOREIGN KEY ("sessionId")
    REFERENCES "recent_chats"("sessionId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "chat_experience_preferences_response_length_check" CHECK ("responseLength" IN ('auto', 'short', 'long')),
  CONSTRAINT "chat_experience_preferences_interaction_intensity_check" CHECK ("interactionIntensity" IN ('gentle', 'balanced', 'expressive')),
  CONSTRAINT "chat_experience_preferences_version_check" CHECK ("version" > 0)
);
