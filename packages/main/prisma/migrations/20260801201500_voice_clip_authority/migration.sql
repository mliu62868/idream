CREATE TABLE "voice_clip_requests" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "characterId" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "requestFingerprint" TEXT NOT NULL,
  "synthesisPayload" JSONB,
  "providerPayload" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'running',
  "attemptNo" INTEGER NOT NULL DEFAULT 1,
  "leaseOwner" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "mediaAssetId" TEXT,
  "provider" TEXT,
  "providerRequestId" TEXT,
  "errorCode" TEXT,
  "error" JSONB,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "voice_clip_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "voice_clip_requests_status_check"
    CHECK ("status" IN ('running', 'succeeded', 'failed', 'skipped')),
  CONSTRAINT "voice_clip_requests_attempt_no_positive"
    CHECK ("attemptNo" > 0),
  CONSTRAINT "voice_clip_requests_synthesis_payload_check"
    CHECK (
      "synthesisPayload" IS NULL OR (
        jsonb_typeof("synthesisPayload") = 'object'
        AND "synthesisPayload" ?& ARRAY['version', 'text', 'sessionId', 'intent']
        AND "synthesisPayload" - ARRAY['version', 'text', 'sessionId', 'intent'] = '{}'::jsonb
        AND "synthesisPayload"->'version' = '1'::jsonb
        AND jsonb_typeof("synthesisPayload"->'text') = 'string'
        AND length(btrim("synthesisPayload"->>'text')) BETWEEN 1 AND 2000
        AND (
          "synthesisPayload"->'sessionId' = 'null'::jsonb
          OR (
            jsonb_typeof("synthesisPayload"->'sessionId') = 'string'
            AND length("synthesisPayload"->>'sessionId') > 0
          )
        )
        AND jsonb_typeof("synthesisPayload"->'intent') = 'string'
        AND "synthesisPayload"->>'intent' IN ('play', 'prewarm')
      )
    )
);

CREATE TABLE "voice_usage_facts" (
  "id" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "attemptNo" INTEGER NOT NULL,
  "userId" TEXT NOT NULL,
  "characterId" TEXT NOT NULL,
  "mediaAssetId" TEXT,
  "durationMs" INTEGER NOT NULL,
  "costDreamcoins" INTEGER NOT NULL,
  "intent" TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "voice_usage_facts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "voice_usage_facts_attempt_no_positive"
    CHECK ("attemptNo" > 0),
  CONSTRAINT "voice_usage_facts_duration_nonnegative"
    CHECK ("durationMs" >= 0),
  CONSTRAINT "voice_usage_facts_cost_nonnegative"
    CHECK ("costDreamcoins" >= 0),
  CONSTRAINT "voice_usage_facts_intent_check"
    CHECK ("intent" IN ('play', 'prewarm'))
);

CREATE UNIQUE INDEX "voice_clip_requests_userId_messageId_key"
  ON "voice_clip_requests"("userId", "messageId");
CREATE INDEX "voice_clip_requests_status_leaseExpiresAt_idx"
  ON "voice_clip_requests"("status", "leaseExpiresAt");
CREATE INDEX "voice_clip_requests_characterId_createdAt_idx"
  ON "voice_clip_requests"("characterId", "createdAt");
CREATE UNIQUE INDEX "voice_usage_facts_requestId_attemptNo_key"
  ON "voice_usage_facts"("requestId", "attemptNo");
CREATE INDEX "voice_usage_facts_userId_occurredAt_idx"
  ON "voice_usage_facts"("userId", "occurredAt");
CREATE INDEX "voice_usage_facts_characterId_occurredAt_idx"
  ON "voice_usage_facts"("characterId", "occurredAt");

ALTER TABLE "voice_clip_requests"
  ADD CONSTRAINT "voice_clip_requests_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "voice_clip_requests_characterId_fkey"
  FOREIGN KEY ("characterId") REFERENCES "characters"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "voice_clip_requests_mediaAssetId_fkey"
  FOREIGN KEY ("mediaAssetId") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "voice_usage_facts"
  ADD CONSTRAINT "voice_usage_facts_requestId_fkey"
  FOREIGN KEY ("requestId") REFERENCES "voice_clip_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "voice_usage_facts_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "voice_usage_facts_characterId_fkey"
  FOREIGN KEY ("characterId") REFERENCES "characters"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "voice_usage_facts_mediaAssetId_fkey"
  FOREIGN KEY ("mediaAssetId") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE FUNCTION reject_voice_usage_fact_update()
RETURNS trigger AS $$
BEGIN
  IF NEW."mediaAssetId" IS NULL
    AND OLD."mediaAssetId" IS NOT NULL
    AND NEW."id" IS NOT DISTINCT FROM OLD."id"
    AND NEW."requestId" IS NOT DISTINCT FROM OLD."requestId"
    AND NEW."attemptNo" IS NOT DISTINCT FROM OLD."attemptNo"
    AND NEW."userId" IS NOT DISTINCT FROM OLD."userId"
    AND NEW."characterId" IS NOT DISTINCT FROM OLD."characterId"
    AND NEW."durationMs" IS NOT DISTINCT FROM OLD."durationMs"
    AND NEW."costDreamcoins" IS NOT DISTINCT FROM OLD."costDreamcoins"
    AND NEW."intent" IS NOT DISTINCT FROM OLD."intent"
    AND NEW."occurredAt" IS NOT DISTINCT FROM OLD."occurredAt"
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'voice_usage_facts are immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER voice_usage_facts_immutable_update
  BEFORE UPDATE ON "voice_usage_facts"
  FOR EACH ROW EXECUTE FUNCTION reject_voice_usage_fact_update();

CREATE FUNCTION reject_voice_clip_synthesis_payload_update()
RETURNS trigger AS $$
BEGIN
  IF NEW."synthesisPayload" IS DISTINCT FROM OLD."synthesisPayload"
    AND NOT (
      (
        OLD."status" <> 'running'
        OR OLD."leaseExpiresAt" IS NULL
        OR OLD."leaseExpiresAt" <= CURRENT_TIMESTAMP
      )
      AND NEW."status" = 'running'
      AND NEW."attemptNo" = OLD."attemptNo" + 1
    )
  THEN
    RAISE EXCEPTION 'voice_clip_requests.synthesisPayload is immutable within an attempt';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER voice_clip_requests_synthesis_payload_immutable_update
  BEFORE UPDATE ON "voice_clip_requests"
  FOR EACH ROW EXECUTE FUNCTION reject_voice_clip_synthesis_payload_update();
