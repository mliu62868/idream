-- Automatic duplicate isolation is safe only for legacy mock attempts that
-- never completed. Real-provider or completed duplicates require an explicit
-- operator decision because changing them would rewrite payment history.
DO $legacy_checkout_preflight$
BEGIN
  IF EXISTS (
    WITH ranked AS (
      SELECT
        checkout.id,
        checkout.provider,
        checkout.status,
        row_number() OVER (
          PARTITION BY checkout.provider, checkout."providerSessionId"
          ORDER BY
            CASE
              WHEN EXISTS (
                SELECT 1
                FROM subscriptions subscription
                WHERE subscription."userId" = checkout."userId"
                  AND subscription.provider = checkout.provider
                  AND subscription."providerSubscriptionId" =
                    checkout."providerSessionId"
              ) THEN 0
              ELSE 1
            END,
            CASE checkout.status
              WHEN 'completed' THEN 0
              WHEN 'created' THEN 1
              ELSE 2
            END,
            checkout."createdAt",
            checkout.id
        ) AS duplicate_rank
      FROM checkout_sessions checkout
      WHERE checkout."providerSessionId" IS NOT NULL
    )
    SELECT 1
    FROM ranked
    WHERE duplicate_rank > 1
      AND (provider <> 'mock' OR status = 'completed')
  ) THEN
    RAISE EXCEPTION
      'real-provider or completed duplicate checkout sessions require explicit reconciliation before billing authority migration';
  END IF;
END;
$legacy_checkout_preflight$;
