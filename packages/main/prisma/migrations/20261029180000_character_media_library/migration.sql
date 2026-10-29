CREATE TABLE "character_media_library_entries" (
    "id" TEXT NOT NULL,
    "characterId" TEXT,
    "sourceAssetId" TEXT,
    "visualProfileId" TEXT NOT NULL,
    "visualProfileVersion" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "description" TEXT NOT NULL,
    "facts" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "absentFacts" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "nudity" TEXT NOT NULL DEFAULT 'unknown',
    "durationSeconds" DOUBLE PRECISION,
    "hasAudio" BOOLEAN,
    "width" INTEGER,
    "height" INTEGER,
    "contentType" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "thumbnailKey" TEXT,
    "contentHash" TEXT NOT NULL,
    "descriptionSource" TEXT NOT NULL DEFAULT 'operator',
    "descriptorModel" TEXT,
    "embedding" DOUBLE PRECISION[] NOT NULL DEFAULT ARRAY[]::DOUBLE PRECISION[],
    "embeddingModel" TEXT,
    "embeddingDimensions" INTEGER,
    "embeddingHash" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "sourceSnapshot" JSONB NOT NULL,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "publishedAt" TIMESTAMP(3),
    CONSTRAINT "character_media_library_entries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "character_media_library_entries_storageKey_key" ON "character_media_library_entries"("storageKey");
CREATE UNIQUE INDEX "character_media_library_entries_characterId_sourceAssetId_vi_key" ON "character_media_library_entries"("characterId", "sourceAssetId", "visualProfileId", "visualProfileVersion");
CREATE INDEX "character_media_library_entries_characterId_visualProfileId_v_idx" ON "character_media_library_entries"("characterId", "visualProfileId", "visualProfileVersion", "status", "kind");
CREATE INDEX "character_media_library_entries_sourceAssetId_status_idx" ON "character_media_library_entries"("sourceAssetId", "status");

ALTER TABLE "character_media_library_entries" ADD CONSTRAINT "character_media_library_entries_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "characters"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "character_media_library_entries" ADD CONSTRAINT "character_media_library_entries_sourceAssetId_fkey" FOREIGN KEY ("sourceAssetId") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
