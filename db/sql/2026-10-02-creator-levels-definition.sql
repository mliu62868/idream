-- Controlled, explicit operational publication; never run on GET/startup/seed.
-- This task's first product rule, not a verified competitor threshold:
-- 0: active customer; 1: >=1 currently public, available work;
-- 2: >=1 such work and >=5 distinct active customer followers.
-- Private/unlisted work, self/internal followers, and payments do not qualify.
-- Defaults publish v1 only against an absent pointer (expected version 0).
-- To publish another definition, SET LOCAL the three idream.creator_levels.*
-- settings inside the caller's transaction before executing this DO block.
-- The caller owns BEGIN/COMMIT. A failed block must roll back the transaction.
DO $creator_levels$
DECLARE
  expected_pointer integer := COALESCE(NULLIF(current_setting('idream.creator_levels.expected_pointer_version', true), ''), '0')::integer;
  definition_version integer := COALESCE(NULLIF(current_setting('idream.creator_levels.definition_version', true), ''), '1')::integer;
  definition_value jsonb := COALESCE(NULLIF(current_setting('idream.creator_levels.definition_json', true), '')::jsonb,
    '{"schemaVersion":1,"definitionVersion":1,"levels":[{"level":0,"label":"Creator","publicWorks":0,"followers":0},{"level":1,"label":"Published creator","publicWorks":1,"followers":0},{"level":2,"label":"Community creator","publicWorks":1,"followers":5}]}'::jsonb);
  definition_key text;
  pointer_row app_settings%ROWTYPE;
  definition_row app_settings%ROWTYPE;
  current_pointer integer;
BEGIN
  IF expected_pointer < 0 OR definition_version < 1 OR jsonb_typeof(definition_value) IS DISTINCT FROM 'object'
    OR jsonb_typeof(definition_value->'schemaVersion') IS DISTINCT FROM 'number'
    OR definition_value->'schemaVersion' IS DISTINCT FROM '1'::jsonb
    OR jsonb_typeof(definition_value->'definitionVersion') IS DISTINCT FROM 'number'
    OR definition_value->'definitionVersion' IS DISTINCT FROM to_jsonb(definition_version)
    OR jsonb_typeof(definition_value->'levels') IS DISTINCT FROM 'array'
    OR (SELECT count(*) FROM jsonb_object_keys(definition_value)) <> 3 THEN
    RAISE EXCEPTION 'Invalid Creator level definition';
  END IF;
  IF jsonb_array_length(definition_value->'levels') NOT BETWEEN 1 AND 10 OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(definition_value->'levels') WITH ORDINALITY AS rules(rule, ordinal)
    WHERE jsonb_typeof(rule) IS DISTINCT FROM 'object'
      OR (SELECT count(*) FROM jsonb_object_keys(rule)) <> 4
      OR jsonb_typeof(rule->'level') IS DISTINCT FROM 'number'
      OR rule->'level' IS DISTINCT FROM to_jsonb((ordinal - 1)::integer)
      OR jsonb_typeof(rule->'label') IS DISTINCT FROM 'string' OR length(btrim(rule->>'label')) NOT BETWEEN 1 AND 80
      OR jsonb_typeof(rule->'publicWorks') IS DISTINCT FROM 'number' OR (rule->>'publicWorks')::numeric NOT BETWEEN 0 AND 1000000
      OR (rule->>'publicWorks')::numeric <> trunc((rule->>'publicWorks')::numeric)
      OR jsonb_typeof(rule->'followers') IS DISTINCT FROM 'number' OR (rule->>'followers')::numeric NOT BETWEEN 0 AND 1000000
      OR (rule->>'followers')::numeric <> trunc((rule->>'followers')::numeric)
      OR (ordinal = 1 AND ((rule->>'publicWorks')::numeric <> 0 OR (rule->>'followers')::numeric <> 0))
      OR (ordinal > 1 AND (
        (rule->>'publicWorks')::numeric < (definition_value->'levels'->(ordinal::integer - 2)->>'publicWorks')::numeric
        OR (rule->>'followers')::numeric < (definition_value->'levels'->(ordinal::integer - 2)->>'followers')::numeric
        OR ((rule->>'publicWorks')::numeric = (definition_value->'levels'->(ordinal::integer - 2)->>'publicWorks')::numeric
          AND (rule->>'followers')::numeric = (definition_value->'levels'->(ordinal::integer - 2)->>'followers')::numeric)))
  ) THEN RAISE EXCEPTION 'Invalid Creator level rules'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('creator.levels.active'));
  SELECT * INTO pointer_row FROM app_settings WHERE key = 'creator.levels.active' FOR UPDATE;
  current_pointer := COALESCE(pointer_row.version, 0);
  IF current_pointer <> expected_pointer THEN
    RAISE EXCEPTION 'Creator level pointer conflict: expected %, current %', expected_pointer, current_pointer;
  END IF;
  definition_key := 'creator.levels.definition:' || definition_version;
  SELECT * INTO definition_row FROM app_settings WHERE key = definition_key;
  IF FOUND THEN
    IF definition_row.value IS DISTINCT FROM definition_value OR definition_row.version <> definition_version OR definition_row.status <> 'active' THEN
      RAISE EXCEPTION 'Published Creator level definition % cannot be overwritten', definition_version;
    END IF;
  ELSE
    INSERT INTO app_settings (key, value, version, status, "updatedAt")
      VALUES (definition_key, definition_value, definition_version, 'active', CURRENT_TIMESTAMP);
  END IF;
  IF current_pointer = 0 THEN
    INSERT INTO app_settings (key, value, version, status, "updatedAt")
      VALUES ('creator.levels.active', jsonb_build_object('schemaVersion', 1, 'definitionVersion', definition_version), 1, 'active', CURRENT_TIMESTAMP);
  ELSE
    UPDATE app_settings SET value = jsonb_build_object('schemaVersion', 1, 'definitionVersion', definition_version),
      version = version + 1, status = 'active', "updatedAt" = CURRENT_TIMESTAMP
      WHERE key = 'creator.levels.active' AND version = expected_pointer;
    IF NOT FOUND THEN RAISE EXCEPTION 'Creator level pointer changed during publication'; END IF;
  END IF;
END;
$creator_levels$;
