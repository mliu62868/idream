ALTER TABLE "generation_transport_executions"
  ADD COLUMN "latencyMs" INTEGER,
  ADD COLUMN "pricingVersion" TEXT;

ALTER TABLE "generation_transport_executions"
  ADD CONSTRAINT "generation_transport_executions_latency_nonnegative"
  CHECK ("latencyMs" IS NULL OR "latencyMs" >= 0);

ALTER TABLE "generation_transport_executions"
  ADD CONSTRAINT "generation_transport_executions_cost_pricing_pair"
  CHECK ("costMicros" IS NULL OR "pricingVersion" IS NOT NULL);

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
  IF OLD."status" = 'unknown' AND NEW."status" = 'succeeded'
    AND OLD."manifestRef" IS NULL AND NEW."manifestRef" IS NOT NULL
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'generation transport execution is append-only after one terminal transition';
END;
$$ LANGUAGE plpgsql;
