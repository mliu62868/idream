-- Never turn an unrelated account into the fixed internal official owner.
DO $official_system_identity_preflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM users
    WHERE email = 'system@idream.local'
      AND id <> 'seed-system-creator'
  ) THEN
    RAISE EXCEPTION
      'system@idream.local is already owned by a different user id';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM users
    WHERE id = 'seed-system-creator'
      AND (
        email <> 'system@idream.local'
        OR "dataClass" = 'customer'
      )
  ) THEN
    RAISE EXCEPTION
      'seed-system-creator conflicts with an existing non-system identity';
  END IF;
END;
$official_system_identity_preflight$;
