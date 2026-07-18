-- Redeem-code rewards are an economic authority. Preserve historical payloads
-- for auditability, but make malformed active codes unusable before the
-- fail-closed application reader is deployed.
UPDATE "redeem_codes"
SET "status" = 'disabled'
WHERE "status" = 'active'
  AND CASE
    WHEN jsonb_typeof("reward") IS DISTINCT FROM 'object' THEN TRUE
    WHEN NOT ("reward" ? 'dreamcoins') THEN TRUE
    WHEN jsonb_typeof("reward"->'dreamcoins') IS DISTINCT FROM 'number' THEN TRUE
    ELSE
      ("reward"->>'dreamcoins')::numeric
        < 1
      OR ("reward"->>'dreamcoins')::numeric
        > 1000000
      OR trunc(("reward"->>'dreamcoins')::numeric)
        <> ("reward"->>'dreamcoins')::numeric
  END;
