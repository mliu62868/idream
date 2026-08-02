-- Merge the duplicate "artifact arrived after cancel" validation state.
--
-- Terminal-record ingest wrote "late_after_cancel" (keyed on Attempt status) while
-- finalize wrote "late_after_cancelled" (keyed on Request status) for the same
-- real-world fact, so any operator query filtering on validationState saw only
-- half the rows. Both paths now derive the state from one function that emits
-- "late_after_cancelled" (the spelling consistent with late_after_failed /
-- _blocked / _refunded / _unknown), and "late_after_cancel" has been removed from
-- the shared enum + transition authority.
--
-- generation_artifacts."validationState" is a plain text column (no PG enum), so
-- this is a pure data backfill — no type change, no downtime.
--
-- Run ONCE, at deploy, BEFORE activating the new code: rows left as
-- "late_after_cancel" would fail the validation-state schema parse afterwards.
BEGIN;

UPDATE public.generation_artifacts
SET "validationState" = 'late_after_cancelled'
WHERE "validationState" = 'late_after_cancel';

-- Fails the transaction if anything still carries the retired spelling.
DO $$
DECLARE
  stragglers bigint;
BEGIN
  SELECT count(*) INTO stragglers
  FROM public.generation_artifacts
  WHERE "validationState" = 'late_after_cancel';
  IF stragglers > 0 THEN
    RAISE EXCEPTION 'late_after_cancel still present on % generation_artifacts row(s)', stragglers;
  END IF;
END $$;

COMMIT;
