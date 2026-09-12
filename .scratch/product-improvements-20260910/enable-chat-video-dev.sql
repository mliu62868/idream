-- Controlled development validation only. This does not enable production.
BEGIN;
DO $guard$
BEGIN
  IF current_database() <> 'idream_runtime_20260812' THEN
    RAISE EXCEPTION 'Unexpected database: %', current_database();
  END IF;
END
$guard$;
INSERT INTO feature_flags (key, label, description, enabled, "rolloutPercent", "targetRoles", "targetPlans", "hardPolicy", version, "createdAt", "updatedAt")
VALUES ('chat_video', 'Chat video', 'Explicit quoted video requests from delivered chat images.', true, 100, '[]'::jsonb, '["deluxe"]'::jsonb, false, 1, now(), now())
ON CONFLICT (key) DO UPDATE SET enabled = true, "rolloutPercent" = 100, version = feature_flags.version + 1, "updatedAt" = now();
COMMIT;
-- To close new requests after controlled validation:
-- UPDATE feature_flags SET enabled = false, version = version + 1, "updatedAt" = now() WHERE key = 'chat_video';
