-- Correct future annual offers to the same rolling-30-day allowance as monthly
-- offers. BillingPeriod controls access expiry, not the voice usage window.
-- Run with psql --set ON_ERROR_STOP=1 against the intended database.
-- Purchased/pending checkout snapshots, accepted Voice terms, ledger entries
-- and independent grants are immutable inputs and are never rewritten here.
BEGIN;

-- Prevent checkout activation/admission from racing this short catalog change.
LOCK TABLE public.plans, public.checkout_sessions, public.subscriptions IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.plans p
    WHERE p.slug IN ('premium', 'deluxe') AND p."billingPeriod" = 'yearly'
      AND NOT COALESCE(p.features->'voiceMinutes' IN (
        CASE p.slug WHEN 'premium' THEN '30'::jsonb ELSE '120'::jsonb END,
        CASE p.slug WHEN 'premium' THEN '360'::jsonb ELSE '1440'::jsonb END
      ), false)
  ) THEN
    RAISE EXCEPTION 'Annual voice allowance differs from the known catalog; reconcile the custom offer before applying this correction';
  END IF;

  -- Legacy subscriptions without a valid purchased snapshot read their mutable
  -- Plan. Refuse to reduce such a plan until its purchase authority is resolved.
  IF EXISTS (
    SELECT 1 FROM public.subscriptions s
    JOIN public.plans p ON p.id = s."planId"
    LEFT JOIN public.checkout_sessions c ON c.provider = s.provider
      AND c."providerSessionId" = s."providerSubscriptionId"
    WHERE p.slug IN ('premium', 'deluxe') AND p."billingPeriod" = 'yearly'
      AND p.features->'voiceMinutes' = CASE p.slug WHEN 'premium' THEN '360'::jsonb ELSE '1440'::jsonb END
      AND NOT COALESCE(
        c."userId" = s."userId" AND c."planId" = s."planId"
        AND c."offerSnapshot"->>'version' = '1'
        AND c."offerSnapshot"->>'planId' = p.id
        AND c."offerSnapshot"->>'billingPeriod' = 'yearly'
        AND c."offerSnapshot"->'priceCents' = to_jsonb(c."amountCents")
        AND lower(c."offerSnapshot"->>'currency') = lower(c.currency)
        AND jsonb_typeof(c."offerSnapshot"->'features') = 'object', false
      )
  ) THEN
    RAISE EXCEPTION 'Annual legacy subscription lacks a valid purchased offer; reconcile its authority before changing the catalog';
  END IF;
END $$;

UPDATE public.plans
SET features = jsonb_set(features, '{voiceMinutes}', CASE slug WHEN 'premium' THEN '30'::jsonb ELSE '120'::jsonb END)
WHERE slug IN ('premium', 'deluxe') AND "billingPeriod" = 'yearly'
  AND features->'voiceMinutes' = CASE slug WHEN 'premium' THEN '360'::jsonb ELSE '1440'::jsonb END;

COMMIT;
