-- Provider-accounted, settled payments are independent of invoice prices and
-- entitlement fulfillment. Received time is not a fabricated settlement time.
CREATE TABLE "cash_capture_facts" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "merchantAccountId" TEXT NOT NULL,
  "paymentMethodId" TEXT NOT NULL,
  "providerPaymentId" TEXT NOT NULL,
  "providerInvoiceId" TEXT NOT NULL,
  "checkoutId" TEXT NOT NULL,
  "amount" TEXT NOT NULL,
  "currency" TEXT NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL,
  "source" TEXT NOT NULL,
  "evidenceHash" TEXT NOT NULL,
  "evidence" JSONB NOT NULL,
  "environment" TEXT NOT NULL,
  "dataClass" TEXT NOT NULL,
  "actorIsInternal" BOOLEAN NOT NULL,
  "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "cash_capture_facts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cash_capture_facts_positive_decimal" CHECK (
    "amount" ~ '^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$' AND "amount" <> '0'
  ),
  CONSTRAINT "cash_capture_facts_provider_authority" CHECK (
    "provider" = 'btcpay' AND "source" = 'btcpay_accounted_invoice_payments'
  ),
  CONSTRAINT "cash_capture_facts_nonempty_identity" CHECK (
    length("merchantAccountId") > 0 AND length("paymentMethodId") > 0
    AND length("providerPaymentId") > 0 AND length("providerInvoiceId") > 0
    AND length("checkoutId") > 0 AND length("currency") > 0
  )
);
CREATE UNIQUE INDEX "cash_capture_facts_payment_identity_key"
  ON "cash_capture_facts"("provider", "merchantAccountId", "paymentMethodId", "providerPaymentId");
CREATE INDEX "cash_capture_facts_checkoutId_idx" ON "cash_capture_facts"("checkoutId");
CREATE INDEX "cash_capture_facts_environment_dataClass_receivedAt_idx"
  ON "cash_capture_facts"("environment", "dataClass", "receivedAt");
CREATE TRIGGER "cash_capture_facts_immutable"
  BEFORE UPDATE ON "cash_capture_facts" FOR EACH ROW EXECUTE FUNCTION reject_admin_evidence_update();
