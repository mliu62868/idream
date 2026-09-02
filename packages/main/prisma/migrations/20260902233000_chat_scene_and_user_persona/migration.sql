-- Explicit settings only; immutable historical Turn snapshots are not rewritten.
ALTER TABLE "chat_experience_preferences"
  ADD COLUMN "sceneGeneration" TEXT NOT NULL DEFAULT 'follow',
  ADD CONSTRAINT "chat_experience_preferences_scene_generation_check"
    CHECK ("sceneGeneration" IN ('follow', 'advance'));

ALTER TABLE "user_preferences"
  ADD COLUMN "chatPersona" JSONB,
  ADD COLUMN "chatPersonaVersion" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "user_preferences_chat_persona_version_check"
    CHECK ("chatPersonaVersion" >= 0);
-- Existing user_preferences.userId ON DELETE CASCADE owns account cleanup.
