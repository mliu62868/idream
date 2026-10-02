-- Existing preferences and accepted Turn snapshots retain their historical values.
ALTER TABLE "chat_experience_preferences" ADD COLUMN "conversationProfile" JSONB;
