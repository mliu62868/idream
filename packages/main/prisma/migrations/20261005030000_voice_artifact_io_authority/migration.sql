-- A takeover may deliver while an older Main uploader still owns active I/O.
ALTER TABLE "voice_clip_requests"
ADD COLUMN "activeArtifactOwners" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
