ALTER TABLE "voice_clip_requests" ADD COLUMN "voiceCallUtteranceId" TEXT;
CREATE UNIQUE INDEX "voice_clip_requests_voiceCallUtteranceId_key" ON voice_clip_requests("voiceCallUtteranceId");

CREATE TABLE "voice_calls" (
  "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "sessionId" TEXT NOT NULL, "characterId" TEXT NOT NULL,
  "activeKey" TEXT, "requestHash" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'active', "language" TEXT NOT NULL DEFAULT 'en',
  "providerPayload" JSONB NOT NULL, "billingAuthority" JSONB NOT NULL, "maxCostDreamcoins" INTEGER NOT NULL,
  "leaseToken" TEXT NOT NULL, "leaseExpiresAt" TIMESTAMP(3) NOT NULL, "deadlineAt" TIMESTAMP(3) NOT NULL,
  "lastHeartbeatAt" TIMESTAMP(3) NOT NULL, "connectedMs" INTEGER NOT NULL DEFAULT 0,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "endedAt" TIMESTAMP(3), "settledAt" TIMESTAMP(3), "endReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "voice_calls_userId_fkey" FOREIGN KEY ("userId") REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "voice_calls_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES recent_chats("sessionId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "voice_calls_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES characters(id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "voice_calls_activeKey_key" ON voice_calls("activeKey");
CREATE INDEX "voice_calls_status_leaseExpiresAt_idx" ON voice_calls(status, "leaseExpiresAt");
CREATE INDEX "voice_calls_characterId_createdAt_idx" ON voice_calls("characterId", "createdAt");

CREATE TABLE "voice_call_utterances" (
  id TEXT PRIMARY KEY, "callId" TEXT NOT NULL, "audioDigest" TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'transcribing',
  "turnId" TEXT, "assistantMessageId" TEXT, "replyAttempt" INTEGER, "voiceRequestId" TEXT, "mediaAssetId" TEXT,
  "durationMs" INTEGER NOT NULL DEFAULT 0, "costDreamcoins" INTEGER NOT NULL DEFAULT 0, "settledAt" TIMESTAMP(3), "errorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "voice_call_utterances_callId_fkey" FOREIGN KEY ("callId") REFERENCES voice_calls(id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "voice_call_utterances_turnId_key" ON voice_call_utterances("turnId");
CREATE INDEX "voice_call_utterances_callId_createdAt_idx" ON voice_call_utterances("callId", "createdAt");

-- Authority constraints
ALTER TABLE voice_calls ADD CONSTRAINT voice_calls_status_check CHECK (status IN ('active', 'muted', 'disconnected', 'ended'));
ALTER TABLE voice_calls ADD CONSTRAINT voice_calls_budget_check CHECK ("maxCostDreamcoins" BETWEEN 0 AND 100 AND "connectedMs" >= 0);
ALTER TABLE voice_calls ADD CONSTRAINT voice_calls_deadline_check CHECK ("deadlineAt" > "startedAt" AND "deadlineAt" <= "startedAt" + INTERVAL '5 minutes');
ALTER TABLE voice_calls ADD CONSTRAINT voice_calls_language_check CHECK (language = 'en');
ALTER TABLE voice_calls ADD CONSTRAINT voice_calls_terminal_check CHECK ((status = 'ended' AND "endedAt" IS NOT NULL AND "settledAt" IS NOT NULL AND "activeKey" IS NULL) OR (status <> 'ended' AND "endedAt" IS NULL AND "settledAt" IS NULL AND "activeKey" = "userId"));
ALTER TABLE voice_call_utterances ADD CONSTRAINT voice_call_utterances_usage_check CHECK ("durationMs" >= 0 AND "costDreamcoins" >= 0);
ALTER TABLE voice_call_utterances ADD CONSTRAINT voice_call_utterances_status_check CHECK (status IN ('transcribing', 'linked', 'delivered', 'cancelled', 'failed'));

CREATE FUNCTION reject_voice_call_authority_update() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = 'ended' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'ended voice call is immutable'; END IF;
  IF (NEW.id, NEW.language, NEW."userId", NEW."sessionId", NEW."characterId", NEW."requestHash", NEW."providerPayload", NEW."billingAuthority", NEW."maxCostDreamcoins", NEW."startedAt", NEW."deadlineAt")
    IS DISTINCT FROM (OLD.id, OLD.language, OLD."userId", OLD."sessionId", OLD."characterId", OLD."requestHash", OLD."providerPayload", OLD."billingAuthority", OLD."maxCostDreamcoins", OLD."startedAt", OLD."deadlineAt")
  THEN RAISE EXCEPTION 'voice call identity and accepted terms are immutable'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER voice_calls_authority_immutable BEFORE UPDATE ON voice_calls FOR EACH ROW EXECUTE FUNCTION reject_voice_call_authority_update();

CREATE FUNCTION reject_voice_call_utterance_authority_update() RETURNS TRIGGER AS $$
BEGIN
  IF (NEW.id, NEW."callId", NEW."audioDigest") IS DISTINCT FROM (OLD.id, OLD."callId", OLD."audioDigest")
    OR (OLD."turnId" IS NOT NULL AND (NEW."turnId", NEW."assistantMessageId", NEW."replyAttempt") IS DISTINCT FROM (OLD."turnId", OLD."assistantMessageId", OLD."replyAttempt"))
    OR (OLD."settledAt" IS NOT NULL AND NEW IS DISTINCT FROM OLD)
  THEN RAISE EXCEPTION 'voice call utterance identity and settlement are immutable'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER voice_call_utterances_authority_immutable BEFORE UPDATE ON voice_call_utterances FOR EACH ROW EXECUTE FUNCTION reject_voice_call_utterance_authority_update();

CREATE FUNCTION reject_voice_clip_call_identity_update() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."voiceCallUtteranceId" IS DISTINCT FROM OLD."voiceCallUtteranceId" THEN
    RAISE EXCEPTION 'voice clip call identity is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER voice_clip_call_identity_immutable BEFORE UPDATE ON voice_clip_requests FOR EACH ROW EXECUTE FUNCTION reject_voice_clip_call_identity_update();
