-- Accepted Voice Clip prices belong to the logical request, not one provider
-- attempt. Null keeps pre-migration requests readable without inventing consent.
ALTER TABLE "voice_clip_requests" ADD COLUMN IF NOT EXISTS "billingAuthority" JSONB;

CREATE OR REPLACE FUNCTION valid_voice_clip_billing_authority(
  authority JSONB, expected_user_id TEXT, expected_request_fingerprint TEXT
) RETURNS BOOLEAN AS $$
BEGIN
  IF authority IS NULL THEN RETURN TRUE; END IF;
  IF (
    jsonb_typeof(authority) = 'object'
    AND authority ?& ARRAY[
      'version', 'userId', 'requestFingerprint', 'intent', 'pricingFingerprint',
      'overflowCostDreamcoins', 'maxCostDreamcoins', 'allowanceMinutes',
      'allowanceWindowStartsAt', 'quotedAt', 'expiresAt'
    ]
    AND authority - ARRAY[
      'version', 'userId', 'requestFingerprint', 'intent', 'pricingFingerprint',
      'overflowCostDreamcoins', 'maxCostDreamcoins', 'allowanceMinutes',
      'allowanceWindowStartsAt', 'quotedAt', 'expiresAt'
    ] = '{}'::jsonb
    AND authority->'version' = '1'::jsonb
    AND jsonb_typeof(authority->'userId') = 'string'
    AND jsonb_typeof(authority->'requestFingerprint') = 'string'
    AND jsonb_typeof(authority->'intent') = 'string'
    AND authority->>'userId' = expected_user_id
    AND authority->>'requestFingerprint' = expected_request_fingerprint
    AND authority->>'intent' IN ('play', 'prewarm')
    AND jsonb_typeof(authority->'pricingFingerprint') = 'string'
    AND length(authority->>'pricingFingerprint') > 0
    AND jsonb_typeof(authority->'overflowCostDreamcoins') = 'number'
    AND jsonb_typeof(authority->'maxCostDreamcoins') = 'number'
    AND jsonb_typeof(authority->'allowanceMinutes') = 'number'
    AND jsonb_typeof(authority->'allowanceWindowStartsAt') = 'string'
    AND jsonb_typeof(authority->'quotedAt') = 'string'
    AND jsonb_typeof(authority->'expiresAt') = 'string'
  ) IS NOT TRUE THEN RETURN FALSE; END IF;
  RETURN (
    (authority->>'overflowCostDreamcoins')::numeric >= 0
    AND (authority->>'overflowCostDreamcoins')::numeric = trunc((authority->>'overflowCostDreamcoins')::numeric)
    AND (authority->>'maxCostDreamcoins')::numeric >= 0
    AND (authority->>'maxCostDreamcoins')::numeric = trunc((authority->>'maxCostDreamcoins')::numeric)
    AND (authority->>'maxCostDreamcoins')::numeric <= (authority->>'overflowCostDreamcoins')::numeric
    AND (authority->>'allowanceMinutes')::numeric >= 0
    AND (authority->>'intent' <> 'prewarm' OR (authority->>'maxCostDreamcoins')::numeric = 0)
    AND (authority->>'expiresAt')::timestamptz > (authority->>'quotedAt')::timestamptz
    AND (authority->>'allowanceWindowStartsAt')::timestamptz <= (authority->>'quotedAt')::timestamptz
  ) IS TRUE;
EXCEPTION WHEN OTHERS THEN RETURN FALSE;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

ALTER TABLE "voice_clip_requests" DROP CONSTRAINT IF EXISTS "voice_clip_requests_billing_authority_check";
ALTER TABLE "voice_clip_requests" ADD CONSTRAINT "voice_clip_requests_billing_authority_check"
  CHECK (valid_voice_clip_billing_authority("billingAuthority", "userId", "requestFingerprint"));

CREATE OR REPLACE FUNCTION reject_voice_clip_billing_authority_update()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."billingAuthority" IS NOT DISTINCT FROM OLD."billingAuthority" THEN RETURN NEW; END IF;
  IF OLD."billingAuthority"->>'intent' = 'play' THEN
    RAISE EXCEPTION 'voice_clip_requests accepted billing authority is immutable across attempts';
  END IF;
  -- A legacy request or a zero-coin automatic prewarm can accept its first
  -- explicit Play quote only together with the next legitimate lease takeover.
  IF NEW."billingAuthority" IS NOT NULL
    AND NEW."billingAuthority"->>'intent' = 'play'
    AND NEW."status" = 'running'
    AND NEW."attemptNo" = OLD."attemptNo" + 1
    AND NEW."leaseOwner" IS NOT NULL
    AND NEW."leaseOwner" IS DISTINCT FROM OLD."leaseOwner"
    AND (OLD."status" <> 'running' OR OLD."leaseExpiresAt" IS NULL OR OLD."leaseExpiresAt" <= CURRENT_TIMESTAMP)
  THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'voice_clip_requests billing authority requires a new accepted Play takeover';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS voice_clip_requests_billing_authority_immutable_update ON "voice_clip_requests";
CREATE TRIGGER voice_clip_requests_billing_authority_immutable_update
  BEFORE UPDATE ON "voice_clip_requests"
  FOR EACH ROW EXECUTE FUNCTION reject_voice_clip_billing_authority_update();
