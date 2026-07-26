ALTER TABLE "character_voice_profiles"
ADD COLUMN IF NOT EXISTS "deliverySettings" JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE "character_voice_profiles"
ALTER COLUMN "provider" SET DEFAULT 'fish_audio';
