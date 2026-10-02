CREATE TABLE "packs" (
  "id" TEXT NOT NULL,
  "creatorId" TEXT,
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "visibility" TEXT NOT NULL DEFAULT 'private',
  "status" TEXT NOT NULL DEFAULT 'draft',
  "version" INTEGER NOT NULL DEFAULT 1,
  "draftContent" JSONB NOT NULL,
  "currentReleaseId" TEXT,
  "blockedReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "packs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "packs_visibility_check" CHECK ("visibility" IN ('private','unlisted','public')),
  CONSTRAINT "packs_status_check" CHECK ("status" IN ('draft','published','withdrawn','blocked')),
  CONSTRAINT "packs_version_check" CHECK ("version" > 0),
  CONSTRAINT "packs_published_release_check" CHECK ("status" <> 'published' OR "currentReleaseId" IS NOT NULL)
);

CREATE TABLE "pack_releases" (
  "id" TEXT NOT NULL,
  "packId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "manifest" JSONB NOT NULL,
  "manifestHash" TEXT NOT NULL,
  "priceCents" INTEGER NOT NULL DEFAULT 0,
  "rights" TEXT NOT NULL DEFAULT 'personal_view_download_current_only',
  "claimUntil" TIMESTAMP(3),
  "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pack_releases_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pack_releases_version_check" CHECK ("version" > 0),
  CONSTRAINT "pack_releases_free_rights_check" CHECK (
    "priceCents" = 0 AND "rights" = 'personal_view_download_current_only'
  )
);

CREATE TABLE "pack_grants" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "releaseId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pack_grants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "packs_currentReleaseId_id_key" ON "packs"("currentReleaseId","id");
CREATE INDEX "packs_creatorId_updatedAt_id_idx" ON "packs"("creatorId","updatedAt","id");
CREATE INDEX "packs_status_visibility_updatedAt_id_idx" ON "packs"("status","visibility","updatedAt","id");
CREATE UNIQUE INDEX "pack_releases_id_packId_key" ON "pack_releases"("id","packId");
CREATE UNIQUE INDEX "pack_releases_packId_version_key" ON "pack_releases"("packId","version");
CREATE UNIQUE INDEX "pack_grants_userId_releaseId_key" ON "pack_grants"("userId","releaseId");
CREATE INDEX "pack_grants_userId_createdAt_id_idx" ON "pack_grants"("userId","createdAt","id");
CREATE INDEX "pack_grants_releaseId_idx" ON "pack_grants"("releaseId");

ALTER TABLE "packs" ADD CONSTRAINT "packs_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "pack_releases" ADD CONSTRAINT "pack_releases_packId_fkey" FOREIGN KEY ("packId") REFERENCES "packs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "packs" ADD CONSTRAINT "packs_currentReleaseId_id_fkey" FOREIGN KEY ("currentReleaseId","id") REFERENCES "pack_releases"("id","packId") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "pack_grants" ADD CONSTRAINT "pack_grants_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pack_grants" ADD CONSTRAINT "pack_grants_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "pack_releases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE FUNCTION idream_pack_release_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Pack releases are immutable; publish another version';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER pack_releases_immutable BEFORE UPDATE ON "pack_releases"
FOR EACH ROW EXECUTE FUNCTION idream_pack_release_immutable();
