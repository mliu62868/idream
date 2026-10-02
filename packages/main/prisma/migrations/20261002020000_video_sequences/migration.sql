CREATE TABLE "video_sequences" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "characterId" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "requestFingerprint" TEXT NOT NULL,
  "acceptedQuote" JSONB NOT NULL,
  "request" JSONB NOT NULL,
  "voicePin" JSONB,
  "audio" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'generating',
  "mediaAssetId" TEXT,
  "errorCode" TEXT,
  "compositionOwner" TEXT,
  "compositionLeaseAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "video_sequences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "video_sequences_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "characters"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "video_sequences_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "video_sequences_audio_check" CHECK ("audio" IN ('generated','silent','narration')),
  CONSTRAINT "video_sequences_status_check" CHECK ("status" IN ('generating','composing','completed','failed','unknown','composition_failed','cancelled')),
  CONSTRAINT "video_sequences_lease_check" CHECK (("compositionOwner" IS NULL) = ("compositionLeaseAt" IS NULL)),
  CONSTRAINT "video_sequences_scenes_check" CHECK (jsonb_typeof("request"->'scenes') = 'array' AND jsonb_array_length("request"->'scenes') BETWEEN 1 AND 3),
  CONSTRAINT "video_sequences_voice_pin_check" CHECK (("audio" = 'narration') = ("voicePin" IS NOT NULL))
);
CREATE UNIQUE INDEX "video_sequences_userId_idempotencyKey_key" ON "video_sequences"("userId","idempotencyKey");
CREATE INDEX "video_sequences_userId_createdAt_idx" ON "video_sequences"("userId","createdAt");
CREATE INDEX "video_sequences_status_updatedAt_idx" ON "video_sequences"("status","updatedAt");
CREATE TABLE "video_sequence_scenes" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "sequenceId" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "generationJobId" TEXT NOT NULL,
  "narrationMediaAssetId" TEXT,
  "narrationState" TEXT NOT NULL DEFAULT 'pending',
  CONSTRAINT "video_sequence_scenes_sequenceId_fkey" FOREIGN KEY ("sequenceId") REFERENCES "video_sequences"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "video_sequence_scenes_generationJobId_fkey" FOREIGN KEY ("generationJobId") REFERENCES "generation_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "video_sequence_scenes_narrationMediaAssetId_fkey" FOREIGN KEY ("narrationMediaAssetId") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "video_sequence_scenes_ordinal_check" CHECK ("ordinal" BETWEEN 0 AND 2),
  CONSTRAINT "video_sequence_scenes_narration_check" CHECK ("narrationState" IN ('pending','running','completed','failed'))
);
CREATE UNIQUE INDEX "video_sequence_scenes_generationJobId_key" ON "video_sequence_scenes"("generationJobId");
CREATE UNIQUE INDEX "video_sequence_scenes_sequenceId_ordinal_key" ON "video_sequence_scenes"("sequenceId","ordinal");

CREATE FUNCTION "protect_video_sequence_acceptance"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."userId" IS DISTINCT FROM OLD."userId" OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
     OR NEW."requestFingerprint" IS DISTINCT FROM OLD."requestFingerprint" OR NEW."acceptedQuote" IS DISTINCT FROM OLD."acceptedQuote"
     OR NEW."request" IS DISTINCT FROM OLD."request" OR NEW."voicePin" IS DISTINCT FROM OLD."voicePin" OR NEW."audio" IS DISTINCT FROM OLD."audio" THEN
    RAISE EXCEPTION 'Video sequence acceptance is immutable';
  END IF;
  IF OLD."status" = 'completed' AND NEW."status" <> 'completed' THEN RAISE EXCEPTION 'Completed video sequence cannot repeat execution'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "video_sequences_acceptance_immutable" BEFORE UPDATE ON "video_sequences" FOR EACH ROW EXECUTE FUNCTION "protect_video_sequence_acceptance"();
CREATE FUNCTION "protect_video_scene_identity"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW."sequenceId" IS DISTINCT FROM OLD."sequenceId" OR NEW."ordinal" IS DISTINCT FROM OLD."ordinal" OR NEW."generationJobId" IS DISTINCT FROM OLD."generationJobId") THEN
    RAISE EXCEPTION 'Video scene Request binding is immutable';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "generation_jobs" j JOIN "video_sequences" s ON s.id = NEW."sequenceId"
     WHERE j.id = NEW."generationJobId" AND j."userId" = s."userId" AND j.mode = 'video'
       AND j."sourceType" = 'video_sequence_scene' AND j."sourceId" = s.id || ':' || NEW.ordinal::TEXT) THEN
    RAISE EXCEPTION 'Video scene Request does not belong to its sequence';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "video_sequence_scenes_identity" BEFORE INSERT OR UPDATE ON "video_sequence_scenes" FOR EACH ROW EXECUTE FUNCTION "protect_video_scene_identity"();
