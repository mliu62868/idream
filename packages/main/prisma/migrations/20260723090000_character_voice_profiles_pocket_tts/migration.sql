CREATE TABLE "character_voice_profiles" (
    "id" TEXT NOT NULL,
    "characterId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'pocket_tts',
    "providerVoiceId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "referenceAssetId" TEXT NOT NULL,
    "previewAssetId" TEXT,
    "sampleText" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "character_voice_profiles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "character_voice_profiles_providerVoiceId_key"
ON "character_voice_profiles"("providerVoiceId");

CREATE UNIQUE INDEX "character_voice_profiles_characterId_version_key"
ON "character_voice_profiles"("characterId", "version");

CREATE INDEX "character_voice_profiles_characterId_status_version_idx"
ON "character_voice_profiles"("characterId", "status", "version");

ALTER TABLE "character_voice_profiles"
ADD CONSTRAINT "character_voice_profiles_characterId_fkey"
FOREIGN KEY ("characterId") REFERENCES "characters"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "character_voice_profiles"
ADD CONSTRAINT "character_voice_profiles_referenceAssetId_fkey"
FOREIGN KEY ("referenceAssetId") REFERENCES "media_assets"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "character_voice_profiles"
ADD CONSTRAINT "character_voice_profiles_previewAssetId_fkey"
FOREIGN KEY ("previewAssetId") REFERENCES "media_assets"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
