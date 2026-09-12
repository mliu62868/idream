CREATE TABLE "comics" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "creatorId" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "visibility" TEXT NOT NULL DEFAULT 'private' CHECK ("visibility" IN ('private', 'unlisted', 'public')),
  "status" TEXT NOT NULL DEFAULT 'draft' CHECK ("status" IN ('draft', 'pending_review', 'published', 'withdrawn')),
  "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" > 0),
  "reviewNote" TEXT,
  "submittedAt" TIMESTAMP(3),
  "publishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "comics_creatorId_updatedAt_id_idx" ON "comics"("creatorId", "updatedAt", "id");
CREATE INDEX "comics_status_visibility_publishedAt_id_idx" ON "comics"("status", "visibility", "publishedAt", "id");
CREATE TABLE "comic_episodes" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "comicId" TEXT NOT NULL REFERENCES "comics"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "ordinal" INTEGER NOT NULL CHECK ("ordinal" >= 0),
  "title" TEXT NOT NULL
);
CREATE UNIQUE INDEX "comic_episodes_comicId_ordinal_key" ON "comic_episodes"("comicId", "ordinal");
CREATE TABLE "comic_pages" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "episodeId" TEXT NOT NULL REFERENCES "comic_episodes"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "mediaAssetId" TEXT REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  "ordinal" INTEGER NOT NULL CHECK ("ordinal" >= 0),
  "caption" TEXT NOT NULL DEFAULT '',
  "sourceProvenance" JSONB NOT NULL
);
CREATE UNIQUE INDEX "comic_pages_episodeId_ordinal_key" ON "comic_pages"("episodeId", "ordinal");
CREATE INDEX "comic_pages_mediaAssetId_idx" ON "comic_pages"("mediaAssetId");
