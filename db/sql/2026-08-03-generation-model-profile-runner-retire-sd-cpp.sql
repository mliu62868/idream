-- Retire the `sd_cpp` value of generation_model_profiles.runner.
--
-- WHY THIS IS BEHAVIOR-PRESERVING
-- `runner` only picks gen's *adapter layer*, it never picks a backend. In
-- packages/gen/src/pipeline.ts `workerAdapterForRecordedProvider` mapped BOTH
-- `comfyui` and `sd_cpp` to the same `backend` adapter; the concrete backend is
-- chosen by the workflow descriptor's `backendKind`. So `sd_cpp` -> `comfyui` is
-- a rename inside one equivalence class — dispatch resolves to the same adapter
-- and the same descriptor either way.
-- Independently: gen has already deleted its whole sd.cpp backend (zero workflow
-- descriptors reference it), and the dev database carries 0 rows with
-- runner='sd_cpp' (11 comfyui + 1 pipeline), so this UPDATE is expected to touch
-- 0 rows. It exists to make the outcome unconditional, not because rows are known
-- to need it.
--
-- WHY THE DEFAULT CHANGES TOO
-- 'sd_cpp' was the column default, so any INSERT that omitted `runner` minted a
-- profile pointing at a runner nothing could execute. 'comfyui' is the value every
-- real image profile already carries.
--
-- DEPLOY ORDER — RUN ONCE, BEFORE ACTIVATING THE NEW CODE.
-- The new code no longer understands 'sd_cpp' anywhere:
--   * packages/gen/src/pipeline.ts dropped `case "sd_cpp"`, so a dispatch carrying
--     it now throws "Unsupported pinned generation provider: sd_cpp";
--   * main's admin zod enums reject it on write;
--   * main's public text-to-image admission no longer grants it an implicit
--     textToImage capability.
-- A row left as 'sd_cpp' after the new code is live is therefore a hard job
-- failure, not a degraded path. Run this first, then deploy.
BEGIN;

UPDATE public.generation_model_profiles
SET runner = 'comfyui'
WHERE runner = 'sd_cpp';

ALTER TABLE public.generation_model_profiles
  ALTER COLUMN runner SET DEFAULT 'comfyui';

-- Fails the transaction if anything still carries the retired runner.
DO $$
DECLARE
  stragglers bigint;
BEGIN
  SELECT count(*) INTO stragglers
  FROM public.generation_model_profiles
  WHERE runner = 'sd_cpp';
  IF stragglers > 0 THEN
    RAISE EXCEPTION 'sd_cpp still present on % generation_model_profiles row(s)', stragglers;
  END IF;
END $$;

COMMIT;
