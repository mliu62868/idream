-- A legacy completed checkout is idempotently terminal, but missing purchase
-- evidence must remain visible to operators rather than being treated as a
-- fully reconstructed modern intent.
UPDATE checkout_sessions
SET
  "needsReconciliation" = TRUE,
  "failureCode" = COALESCE(
    "failureCode",
    'legacy_completed_checkout_evidence_incomplete'
  ),
  "reconciliationEvidence" =
    COALESCE("reconciliationEvidence", '{}'::jsonb)
      || jsonb_build_object(
        'schemaVersion', 'checkout-reconciliation-evidence-v1',
        'reason', 'legacy_completed_checkout_evidence_incomplete',
        'missingPlanId', "planId" IS NULL,
        'missingOfferSnapshot', "offerSnapshot" IS NULL
      )
WHERE status = 'completed'
  AND ("planId" IS NULL OR "offerSnapshot" IS NULL);
