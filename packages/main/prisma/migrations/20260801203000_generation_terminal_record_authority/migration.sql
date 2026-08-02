-- INTENT: The guard integration suite starts from `prisma db push` (the latest
-- shape) and then replays authority migrations. Conditional renames keep this
-- migration executable both in the historical chain and on that latest shape.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'generation_attempts'
      AND column_name = 'completionManifestRef'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'generation_attempts'
      AND column_name = 'terminalRecordRef'
  ) THEN
    ALTER TABLE "generation_attempts"
      RENAME COLUMN "completionManifestRef" TO "terminalRecordRef";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'generation_transport_executions'
      AND column_name = 'manifestRef'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'generation_transport_executions'
      AND column_name = 'terminalRecordRef'
  ) THEN
    ALTER TABLE "generation_transport_executions"
      RENAME COLUMN "manifestRef" TO "terminalRecordRef";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'generation_artifacts'
      AND column_name = 'manifestChecksum'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'generation_artifacts'
      AND column_name = 'terminalRecordChecksum'
  ) THEN
    ALTER TABLE "generation_artifacts"
      RENAME COLUMN "manifestChecksum" TO "terminalRecordChecksum";
  END IF;
END;
$$;

ALTER TABLE "generation_attempts"
  DROP CONSTRAINT IF EXISTS "generation_attempt_terminal_time_check";

ALTER TABLE "generation_attempts"
  ADD CONSTRAINT "generation_attempt_terminal_time_check" CHECK (
    "status" NOT IN ('succeeded', 'failed', 'blocked', 'cancelled', 'unknown')
    OR "finishedAt" IS NOT NULL
  );

ALTER TABLE "generation_attempt_events"
  DROP CONSTRAINT IF EXISTS "generation_attempt_events_terminal_check";

ALTER TABLE "generation_attempt_events"
  ADD CONSTRAINT "generation_attempt_events_terminal_check" CHECK (
    ("terminalScope" IS NULL AND "outcome" IS NULL)
    OR (
      "terminalScope" = 'terminal'
      AND "outcome" IN ('succeeded', 'failed', 'blocked', 'cancelled', 'unknown')
      AND "eventType" = ('generation.attempt.' || "outcome" || '.v1')
    )
  );

CREATE OR REPLACE FUNCTION enforce_generation_attempt_terminal_event()
RETURNS trigger AS $$
BEGIN
  IF NEW."status" IN ('succeeded', 'failed', 'blocked', 'cancelled', 'unknown') AND NOT EXISTS (
    SELECT 1
    FROM "generation_attempt_events" e
    WHERE e."attemptId" = NEW."id"
      AND e."terminalScope" = 'terminal'
      AND e."outcome" = NEW."status"
      AND e."sequence" = NEW."terminalSequence"
  ) THEN
    RAISE EXCEPTION 'terminal GenerationAttempt requires one matching canonical terminal event';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_generation_transport_execution_lifecycle()
RETURNS trigger AS $$
BEGIN
  IF NEW."attemptId" IS DISTINCT FROM OLD."attemptId"
    OR NEW."transportAttemptNo" IS DISTINCT FROM OLD."transportAttemptNo"
    OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
    OR (OLD."latencyMs" IS NOT NULL AND NEW."latencyMs" IS DISTINCT FROM OLD."latencyMs")
    OR (OLD."costMicros" IS NOT NULL AND NEW."costMicros" IS DISTINCT FROM OLD."costMicros")
    OR (OLD."pricingVersion" IS NOT NULL AND NEW."pricingVersion" IS DISTINCT FROM OLD."pricingVersion")
  THEN
    RAISE EXCEPTION 'generation transport execution is append-only after one terminal transition';
  END IF;
  IF NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF OLD."status" = 'running' AND NEW."status" IN ('succeeded', 'failed', 'unknown') THEN
    RETURN NEW;
  END IF;
  IF OLD."status" = 'unknown' AND NEW."status" = 'unknown'
    AND OLD."terminalRecordRef" IS NULL AND NEW."terminalRecordRef" IS NOT NULL
    AND (OLD."providerRequestId" IS NULL OR NEW."providerRequestId" IS NOT DISTINCT FROM OLD."providerRequestId")
  THEN
    RETURN NEW;
  END IF;
  IF OLD."status" IN ('succeeded', 'failed') AND NEW."status" = OLD."status"
    AND OLD."terminalRecordRef" IS NULL AND NEW."terminalRecordRef" IS NOT NULL
    AND (OLD."providerRequestId" IS NULL OR NEW."providerRequestId" IS NOT DISTINCT FROM OLD."providerRequestId")
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'generation transport execution is append-only after one terminal transition';
END;
$$ LANGUAGE plpgsql;

-- INVARIANT: db-push creates tables but not raw-SQL triggers. Reinstall the
-- trigger explicitly so the latest-schema rehearsal exercises the same guard
-- as a database upgraded through the full migration chain.
DROP TRIGGER IF EXISTS generation_transport_execution_lifecycle
ON "generation_transport_executions";

CREATE TRIGGER generation_transport_execution_lifecycle
BEFORE UPDATE ON "generation_transport_executions"
FOR EACH ROW EXECUTE FUNCTION enforce_generation_transport_execution_lifecycle();

UPDATE "main_outbox_events"
SET
  "id" = regexp_replace("id", '^generation_manifest_', 'generation_terminal_record_'),
  "eventType" = 'generation.terminal_record.accepted.v1',
  "payload" = (
    "payload" - 'completionManifestRef' - 'completionManifestChecksum'
  ) || jsonb_build_object(
    'terminalRecordRef', "payload"->'completionManifestRef',
    'terminalRecordChecksum', "payload"->'completionManifestChecksum'
  )
WHERE "eventType" = 'generation.manifest.accepted.v1';
