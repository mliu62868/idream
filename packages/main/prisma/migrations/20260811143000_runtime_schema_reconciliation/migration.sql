BEGIN;

-- `sd_cpp` was retired in application authority, but the baseline default and
-- historical rows were only repaired by a manual runbook. Make every fresh or
-- partially repaired database converge through Prisma migration history.
UPDATE public.generation_model_profiles
SET runner = 'comfyui'
WHERE runner = 'sd_cpp';

ALTER TABLE public.generation_model_profiles
  ALTER COLUMN runner SET DEFAULT 'comfyui';

-- This spelling predates the terminal artifact vocabulary and is no longer
-- accepted by the current application.
UPDATE public.generation_artifacts
SET "validationState" = 'late_after_cancelled'
WHERE "validationState" = 'late_after_cancel';

-- CharacterVisualProfile authority moved to immutable ReferenceSetRevision.
-- The old JSON column may still carry production-only references, so dropping it
-- is allowed only after every non-empty shadow is proven to be covered by the one
-- active Reference Set for that exact profile. Malformed JSON and drift both stop
-- the transaction before any history can be discarded.
DO $profile_shadow_parity$
DECLARE
  shadow_column_exists boolean;
  invalid_profile_count bigint;
  invalid_profile_samples text;
  drifted_profile_count bigint;
  drifted_profile_samples text;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'character_visual_profiles'
      AND column_name = 'referenceAssetIds'
  )
  INTO shadow_column_exists;

  IF shadow_column_exists THEN
    -- Freeze both sides of the comparison until the column is dropped. Without
    -- these locks, a writer could change a shadow or its active snapshots after
    -- the parity read but before the destructive DDL.
    LOCK TABLE public.character_visual_profiles IN ACCESS EXCLUSIVE MODE;
    LOCK TABLE
      public.reference_set_revisions,
      public.character_visual_reference_snapshots
      IN SHARE MODE;

    EXECUTE $shape_check$
      WITH invalid_profiles AS (
        SELECT profiles.id
        FROM public.character_visual_profiles AS profiles
        WHERE CASE
          WHEN jsonb_typeof(profiles."referenceAssetIds") IS DISTINCT FROM 'array'
            THEN true
          ELSE EXISTS (
            SELECT 1
            FROM jsonb_array_elements(profiles."referenceAssetIds") AS element(value)
            WHERE jsonb_typeof(element.value) IS DISTINCT FROM 'string'
              OR btrim(element.value #>> '{}') = ''
          )
        END
      ), sample_profiles AS (
        SELECT id
        FROM invalid_profiles
        ORDER BY id
        LIMIT 20
      )
      SELECT
        (SELECT count(*) FROM invalid_profiles),
        (SELECT string_agg(id, ', ' ORDER BY id) FROM sample_profiles)
    $shape_check$
    INTO invalid_profile_count, invalid_profile_samples;

    IF invalid_profile_count > 0 THEN
      RAISE EXCEPTION
        'character_visual_profiles.referenceAssetIds must be a JSON array of non-empty media asset ids (% profile(s); first ids: %)',
        invalid_profile_count,
        invalid_profile_samples
        USING ERRCODE = '23514';
    END IF;

    EXECUTE $parity_check$
      WITH drifted_profiles AS (
        SELECT profiles.id
        FROM public.character_visual_profiles AS profiles
        CROSS JOIN LATERAL (
          SELECT count(*) AS active_reference_set_count
          FROM public.reference_set_revisions AS active_revisions
          WHERE active_revisions."visualProfileId" = profiles.id
            AND active_revisions."status" = 'active'
        ) AS authority
        WHERE jsonb_array_length(profiles."referenceAssetIds") > 0
          AND (
            authority.active_reference_set_count <> 1
            OR EXISTS (
              SELECT 1
              FROM jsonb_array_elements_text(
                profiles."referenceAssetIds"
              ) AS shadow_ids(media_asset_id)
              WHERE NOT EXISTS (
                SELECT 1
                FROM public.reference_set_revisions AS revisions
                JOIN public.character_visual_reference_snapshots AS snapshots
                  ON snapshots."referenceSetRevisionId" = revisions.id
                WHERE revisions."visualProfileId" = profiles.id
                  AND revisions."status" = 'active'
                  AND snapshots."mediaAssetId" = shadow_ids.media_asset_id
              )
            )
          )
      ), sample_profiles AS (
        SELECT id
        FROM drifted_profiles
        ORDER BY id
        LIMIT 20
      )
      SELECT
        (SELECT count(*) FROM drifted_profiles),
        (SELECT string_agg(id, ', ' ORDER BY id) FROM sample_profiles)
    $parity_check$
    INTO drifted_profile_count, drifted_profile_samples;

    IF drifted_profile_count > 0 THEN
      RAISE EXCEPTION
        'character_visual_profiles.referenceAssetIds shadow parity failed (% profile(s); first ids: %)',
        drifted_profile_count,
        drifted_profile_samples
        USING ERRCODE = '23514';
    END IF;
  END IF;
END
$profile_shadow_parity$;

-- Any unknown dependency must stop the deployment instead of being removed.
ALTER TABLE public.character_visual_profiles
  DROP COLUMN IF EXISTS "referenceAssetIds";

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.generation_model_profiles
    WHERE runner = 'sd_cpp'
  ) THEN
    RAISE EXCEPTION 'retired generation runner sd_cpp remains';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.generation_artifacts
    WHERE "validationState" = 'late_after_cancel'
  ) THEN
    RAISE EXCEPTION 'retired artifact state late_after_cancel remains';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'character_visual_profiles'
      AND column_name = 'referenceAssetIds'
  ) THEN
    RAISE EXCEPTION
      'character_visual_profiles.referenceAssetIds shadow column remains';
  END IF;
END
$$;

COMMIT;
