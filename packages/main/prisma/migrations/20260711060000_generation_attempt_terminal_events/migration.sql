-- Attempt-linked append-only event authority. A nullable constant terminalScope
-- gives PostgreSQL a simple, race-safe one-terminal-event constraint per Attempt.
CREATE TABLE "generation_attempt_events" (
  "id" TEXT NOT NULL,
  "attemptId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "eventType" TEXT NOT NULL,
  "outcome" TEXT,
  "terminalScope" TEXT,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "payload" JSONB NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "generation_attempt_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "generation_attempt_events_sequence_check" CHECK ("sequence" > 0),
  CONSTRAINT "generation_attempt_events_hash_check" CHECK ("payloadHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "generation_attempt_events_terminal_check" CHECK (
    ("terminalScope" IS NULL AND "outcome" IS NULL)
    OR (
      "terminalScope" = 'terminal'
      AND "outcome" IN ('succeeded', 'failed', 'cancelled', 'unknown')
      AND "eventType" = ('generation.attempt.' || "outcome" || '.v1')
    )
  )
);

CREATE UNIQUE INDEX "generation_attempt_events_attemptId_sequence_key"
  ON "generation_attempt_events"("attemptId", "sequence");
CREATE UNIQUE INDEX "generation_attempt_events_attemptId_terminalScope_key"
  ON "generation_attempt_events"("attemptId", "terminalScope");
CREATE INDEX "generation_attempt_events_eventType_occurredAt_idx"
  ON "generation_attempt_events"("eventType", "occurredAt");

ALTER TABLE "generation_attempt_events"
  ADD CONSTRAINT "generation_attempt_events_attemptId_fkey"
  FOREIGN KEY ("attemptId") REFERENCES "generation_attempts"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Event facts are immutable. Deleting an Attempt still cascades for retention and
-- test teardown, but no event fact can be rewritten in place.
CREATE FUNCTION reject_generation_attempt_event_update()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'generation_attempt_events are immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER generation_attempt_events_immutable
BEFORE UPDATE ON "generation_attempt_events"
FOR EACH ROW EXECUTE FUNCTION reject_generation_attempt_event_update();

-- Existing terminal rows are reconciled by the evidence backfill. From this
-- migration forward, no new terminal Attempt state may bypass its matching event.
CREATE FUNCTION enforce_generation_attempt_terminal_event()
RETURNS trigger AS $$
BEGIN
  IF NEW."status" IN ('succeeded', 'failed', 'cancelled', 'unknown') AND NOT EXISTS (
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

CREATE TRIGGER generation_attempt_terminal_event_required
AFTER INSERT OR UPDATE OF "status", "terminalSequence" ON "generation_attempts"
FOR EACH ROW EXECUTE FUNCTION enforce_generation_attempt_terminal_event();
