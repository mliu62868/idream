ALTER TABLE "checkout_sessions"
  ADD COLUMN "providerLastLookupAt" TIMESTAMP(3),
  ADD COLUMN "providerLookupMissCount" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "checkout_sessions"
  ADD CONSTRAINT "checkout_sessions_provider_lookup_miss_count_check"
  CHECK ("providerLookupMissCount" >= 0);

CREATE INDEX "checkout_sessions_needsReconciliation_updatedAt_idx"
  ON "checkout_sessions"("needsReconciliation", "updatedAt");
