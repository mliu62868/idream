-- Empty provenance strings are not evidence. Require an explicit repair before
-- the ownership migration so COALESCE cannot accidentally preserve blanks.
DO $official_provenance_preflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM characters character
    JOIN users owner ON owner.id = character."creatorId"
    WHERE character.source = 'official'
      AND character."creatorId" <> 'seed-system-creator'
      AND owner."dataClass" <> 'customer'
      AND (
        (
          character."advancedDetails"->'provenance' ? 'originalCreator'
          AND NULLIF(
            btrim(
              character."advancedDetails"->'provenance'->>'originalCreator'
            ),
            ''
          ) IS NULL
        )
        OR (
          character."advancedDetails"->'provenance' ? 'legacyCreatorId'
          AND NULLIF(
            btrim(
              character."advancedDetails"->'provenance'->>'legacyCreatorId'
            ),
            ''
          ) IS NULL
        )
      )
  ) THEN
    RAISE EXCEPTION
      'official Character provenance contains an empty creator identity';
  END IF;
END;
$official_provenance_preflight$;
