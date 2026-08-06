-- RUN AS: main schema owner. Application deploy follows this migration.
\set ON_ERROR_STOP on

ALTER TABLE public.character_qa_runs
  ADD COLUMN IF NOT EXISTS behavior_evaluation jsonb,
  ADD COLUMN IF NOT EXISTS live_canaries jsonb;
