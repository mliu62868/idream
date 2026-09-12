-- Retire the `pipeline`, `mlx` and `external` values of generation_model_profiles.runner.
--
-- WHY THESE THREE GO TOGETHER
-- All three resolved to one adapter. In packages/gen/src/pipeline.ts
-- `workerAdapterForRecordedProvider` mapped `pipeline` to the `pipeline` adapter
-- and mapped `mlx` and `external` onto it as aliases. That adapter — the legacy
-- OpenAI-compatible gateway (PipelineImageModel / PipelineVideoModel) — was
-- deleted on 2026-09-12: it had zero callers, both architecture documents
-- already called it deprecated, and the rollback runbook its retention cited
-- (docs/architecture/10-operations.md) does not mention it at all. With the
-- adapter gone the three runner values name something that cannot be built.
--
-- WHY THIS IS BEHAVIOR-PRESERVING
-- `runner` only picks gen's *adapter layer*; the concrete backend comes from the
-- workflow descriptor's `backendKind`. The one dev row carrying `pipeline` is
-- "Command test creative profile" with pipelineModel='mock-image' and an empty
-- workflowKey — an admin-command test artefact that never executed: every
-- generation_attempts row records provider comfyui, backend or null, none
-- pipeline. Rewriting it to `comfyui` moves it into the adapter every real
-- profile already uses, and it still cannot dispatch without a workflowKey,
-- exactly as before.
--
-- Measured in idream_runtime_20260812 before this ran: 16 rows comfyui,
-- 1 row pipeline, 0 rows mlx, 0 rows external.
--
-- This mirrors db/sql/2026-08-03-generation-model-profile-runner-retire-sd-cpp.sql.
-- DEV: run by agent under the AGENTS.md dev-database authorization.
-- PROD: run before deploying the source revision that deletes the adapter.

BEGIN;

UPDATE public.generation_model_profiles
   SET runner = 'comfyui'
 WHERE runner IN ('pipeline', 'mlx', 'external');

COMMIT;

-- Verify: expect a single row, comfyui.
-- SELECT runner, count(*) FROM public.generation_model_profiles GROUP BY runner;
