-- Preserve the provider's invoice state independently from the local checkout
-- workflow. Recovery must distinguish payable, confirming, settled, expired,
-- and invalid invoices instead of coercing every lookup result to "created".
ALTER TABLE "checkout_sessions"
  ADD COLUMN "providerInvoiceStatus" TEXT,
  ADD COLUMN "providerInvoiceAdditionalStatus" TEXT;

UPDATE "checkout_sessions"
SET
  "providerInvoiceStatus" = CASE
    WHEN "status" = 'completed' THEN 'settled'
    ELSE NULL
  END,
  -- The legacy schema never persisted the provider's additional status.
  -- NULL is truthful; "none" would be manufactured evidence.
  "providerInvoiceAdditionalStatus" = NULL,
  "needsReconciliation" = CASE
    WHEN "status" = 'completed' THEN "needsReconciliation"
    ELSE TRUE
  END,
  "failureCode" = CASE
    WHEN "status" = 'completed' THEN "failureCode"
    ELSE COALESCE("failureCode", 'legacy_provider_invoice_status_unknown')
  END,
  "reconciliationEvidence" = CASE
    WHEN "status" = 'completed' THEN "reconciliationEvidence"
    ELSE
      COALESCE("reconciliationEvidence", '{}'::jsonb)
        || jsonb_build_object(
          'schemaVersion', 'checkout-reconciliation-evidence-v1',
          'reason', 'legacy_provider_invoice_status_unknown'
        )
  END
WHERE "providerSessionId" IS NOT NULL;

ALTER TABLE "checkout_sessions"
  ADD CONSTRAINT "checkout_sessions_provider_invoice_status_check"
    CHECK (
      "providerInvoiceStatus" IS NULL
      OR "providerInvoiceStatus" IN (
        'created',
        'processing',
        'settled',
        'expired',
        'invalid'
      )
    ),
  ADD CONSTRAINT "checkout_sessions_provider_invoice_additional_status_check"
    CHECK (
      "providerInvoiceAdditionalStatus" IS NULL
      OR "providerInvoiceAdditionalStatus" IN (
        'none',
        'marked',
        'paid_late',
        'paid_over',
        'paid_partial'
      )
    );
