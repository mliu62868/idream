-- The request's origin stays immutable; each provider attempt separately pins
-- standalone Play or the exact Call lease that may deliver and settle it.
ALTER TABLE "voice_clip_requests" ADD COLUMN IF NOT EXISTS "executionAuthority" JSONB;

-- Only known standalone history can be backfilled. A Call's old lease token
-- cannot be reconstructed from its current token after Resume. Unknown Call
-- attempts remain NULL: operator recovery fails closed; an explicit Call
-- request may authorize a new attempt with its then-current lease.
UPDATE "voice_clip_requests" AS request
SET "executionAuthority" = '{"version":1,"kind":"standalone"}'::jsonb
WHERE request."executionAuthority" IS NULL
  AND request."voiceCallUtteranceId" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "voice_call_utterances" AS utterance
    WHERE utterance."voiceRequestId" = request.id AND utterance."settledAt" IS NULL
  );

CREATE OR REPLACE FUNCTION valid_voice_execution_authority(
  authority JSONB, expected_reply_attempt INTEGER, origin_utterance_id TEXT
) RETURNS BOOLEAN AS $$
BEGIN
  IF authority IS NULL THEN RETURN TRUE; END IF;
  IF (
    jsonb_typeof(authority) = 'object'
    AND authority ?& ARRAY['version', 'kind']
    AND authority->'version' = '1'::jsonb
    AND jsonb_typeof(authority->'kind') = 'string'
  ) IS NOT TRUE THEN RETURN FALSE; END IF;
  IF authority->>'kind' = 'standalone' THEN
    RETURN origin_utterance_id IS NULL
      AND authority - ARRAY['version', 'kind'] = '{}'::jsonb;
  END IF;
  IF (
    authority->>'kind' = 'call'
    AND authority ?& ARRAY['callUtteranceId', 'replyAttempt', 'leaseToken']
    AND authority - ARRAY['version', 'kind', 'callUtteranceId', 'replyAttempt', 'leaseToken'] = '{}'::jsonb
    AND jsonb_typeof(authority->'callUtteranceId') = 'string'
    AND length(authority->>'callUtteranceId') > 0
    AND jsonb_typeof(authority->'leaseToken') = 'string'
    AND length(authority->>'leaseToken') > 0
    AND jsonb_typeof(authority->'replyAttempt') = 'number'
  ) IS NOT TRUE THEN RETURN FALSE; END IF;
  RETURN expected_reply_attempt > 0
    AND (authority->>'replyAttempt')::numeric = expected_reply_attempt
    AND (origin_utterance_id IS NULL OR authority->>'callUtteranceId' = origin_utterance_id);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

ALTER TABLE "voice_clip_requests"
  ADD CONSTRAINT "voice_clip_requests_execution_authority_check"
  CHECK (valid_voice_execution_authority("executionAuthority", "replyAttempt", "voiceCallUtteranceId"));

CREATE OR REPLACE FUNCTION reject_voice_execution_authority_update()
RETURNS trigger AS $$
BEGIN
  IF NEW."executionAuthority" IS DISTINCT FROM OLD."executionAuthority"
    AND NOT (
      (OLD.status <> 'running' OR OLD."leaseExpiresAt" IS NULL OR OLD."leaseExpiresAt" <= CURRENT_TIMESTAMP)
      AND NEW.status = 'running'
      AND NEW."attemptNo" = OLD."attemptNo" + 1
    )
  THEN
    RAISE EXCEPTION 'voice execution authority is immutable within an attempt';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER voice_execution_authority_immutable_update
  BEFORE UPDATE ON "voice_clip_requests"
  FOR EACH ROW EXECUTE FUNCTION reject_voice_execution_authority_update();
