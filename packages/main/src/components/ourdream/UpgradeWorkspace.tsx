"use client";

import { Check, Crown } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  parseCheckoutResponse,
  parsePlansResponse,
  parseProfileResponse,
  parsePublicApiError,
  type PublicBillingMode as BillingMode,
  type PublicPlan as Plan,
} from "@/lib/public-api-contracts";
import {
  checkoutIntentFingerprint,
  createPendingCheckoutIntent,
  readPendingCheckoutIntents,
  removePendingCheckoutIntent,
  shouldRemovePendingCheckoutIntent,
  upsertPendingCheckoutIntent,
  writePendingCheckoutIntents,
  type PendingCheckoutIntent,
} from "@/lib/billing-checkout-intent";
import { useAgeGateAccess } from "./AgeGateBoundary";
import { useViewerGate } from "@/hooks/useViewerGate";
import { isAbortError } from "@/lib/viewer-resource-client";
import { safeInternalAuthRedirect } from "./authRedirect";
import { VIEWER_UNCONFIRMED_MESSAGE } from "./viewer-auth";
import {
  configuredEntitlementBenefits,
  FREE_CHAT_SUMMARY,
} from "./entitlement-copy";

type CheckoutResult =
  | { kind: "success"; message: string; plan: Plan }
  | { kind: "redirect"; message: string; url: string }
  | { kind: "error"; message: string };

export function UpgradeWorkspace() {
  const { accepted: ageGateAccepted } = useAgeGateAccess();
  const viewer = useViewerGate({ require: "any" });
  const viewerId = viewer.identity?.kind === "user" ? viewer.identity.userId : null;
  const gatedFetch = viewer.fetch;
  const [plans, setPlans] = useState<Plan[]>([]);
  const [billingMode, setBillingMode] = useState<BillingMode | null>(null);
  const [checkoutResult, setCheckoutResult] = useState<CheckoutResult | null>(null);
  const [pendingPlan, setPendingPlan] = useState("");
  const [selectedPeriod, setSelectedPeriod] = useState<Plan["billingPeriod"]>("monthly");
  const [returnTarget, setReturnTarget] = useState("/generate");
  const [returnTargetReady, setReturnTargetReady] = useState(false);
  // The purchased offer can differ from today's catalog even with the same
  // plan ID. Keep its benefits instead of reducing it to a tier label.
  const [activePlan, setActivePlan] = useState<Plan | null>(null);
  const [checkoutIntents, setCheckoutIntents] = useState<
    PendingCheckoutIntent[]
  >([]);
  const requestSerialRef = useRef(0);
  const writingRef = useRef(false);
  const aliveRef = useRef(true);
  // P1-D: a failed/slow plans fetch must not masquerade as "no plans". Track
  // load lifecycle so we can show a spinner and a retryable error instead of
  // a blank grid.
  const [plansState, setPlansState] = useState<"loading" | "ready" | "error">("loading");

  const loadPlans = useCallback(async () => {
    if (!ageGateAccepted) return;
    setPlansState("loading");
    try {
      const response = await fetch("/api/v1/plans");
      if (!response.ok) throw new Error(`plans request failed (${response.status})`);
      const payload = parsePlansResponse(await response.json());
      setPlans(payload.items);
      setBillingMode(payload.billing);
      setPlansState("ready");
    } catch {
      setPlansState("error");
    }
  }, [ageGateAccepted]);

  useEffect(() => {
    if (!ageGateAccepted) return;
    const timer = window.setTimeout(() => void loadPlans(), 0);
    return () => window.clearTimeout(timer);
  }, [ageGateAccepted, loadPlans]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setReturnTarget(upgradeReturnTarget());
      const period = new URLSearchParams(window.location.search).get("billing");
      if (period === "monthly" || period === "yearly") setSelectedPeriod(period);
      setReturnTargetReady(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; requestSerialRef.current += 1; };
  }, []);
  useEffect(() => viewer.gate.onOwnerChange?.(() => {
    requestSerialRef.current += 1;
    writingRef.current = false;
    setPendingPlan("");
    setActivePlan(null);
    setCheckoutIntents([]);
    setCheckoutResult({ kind: "error", message: "Your account changed. Review the current account before continuing." });
  }), [viewer.gate]);
  useEffect(() => {
    const timer = window.setTimeout(() => setCheckoutIntents(viewerId
      ? readPendingCheckoutIntents(window.sessionStorage, viewerId)
      : []), 0);
    return () => window.clearTimeout(timer);
  }, [viewerId]);

  // Best-effort current-plan lookup; any failure simply leaves the cards unmarked.
  useEffect(() => {
    if (!ageGateAccepted || !viewerId) return;
    let alive = true;
    const timer = window.setTimeout(() => {
      void gatedFetch("/api/v1/profile", { cache: "no-store" })
        .then((response) => response.ok ? response.json() : null)
        .then((payload: unknown) => {
          if (!alive || payload === null) return;
          const profile = parseProfileResponse(payload);
          if (profile.user.id !== viewerId) return;
          setActivePlan(profile.subscription?.plan ?? null);
        })
        .catch(() => undefined);
    }, 0);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [ageGateAccepted, gatedFetch, viewerId, viewer.revalidation]);

  function persistCheckoutIntents(
    authorityViewerId: string,
    next: PendingCheckoutIntent[],
  ) {
    writePendingCheckoutIntents(
      window.sessionStorage,
      authorityViewerId,
      next,
    );
    setCheckoutIntents(next);
  }

  async function checkout(plan: Plan) {
    if (writingRef.current || !viewer.identity) return;
    writingRef.current = true;
    const serial = ++requestSerialRef.current;
    const isCurrent = () => aliveRef.current && serial === requestSerialRef.current;
    setPendingPlan(plan.id);
    setCheckoutResult(null);
    const autoConfirm = billingMode?.autoConfirmAvailable === true;
    const intentInput = {
      planId: plan.id,
      autoConfirm,
      returnPath: returnTarget,
    };
    const intentFingerprint = checkoutIntentFingerprint(intentInput);
    try {
      // The cookie can change before focus. Confirm the displayed owner before
      // writing, and retain that owner's key until its result is confirmed.
      const authority = await viewer.revalidate();
      if (!isCurrent()) return;
      if (!authority) throw new Error(VIEWER_UNCONFIRMED_MESSAGE);
      const authorityViewerId = authority.kind === "user" ? authority.userId : null;
      if (authorityViewerId !== viewerId) {
        setCheckoutResult({ kind: "error", message: "Your account changed. Review the current account before continuing." });
        return;
      }
      if (!authorityViewerId) {
        window.location.assign(signupUrlForCheckout(plan, returnTarget));
        return;
      }

      const restored = readPendingCheckoutIntents(
        window.sessionStorage,
        authorityViewerId,
      );
      const existing = restored.find(
        (intent) => intent.fingerprint === intentFingerprint,
      );
      const intent: PendingCheckoutIntent =
        existing ??
        createPendingCheckoutIntent(intentInput, crypto.randomUUID());
      const pendingIntents = upsertPendingCheckoutIntent(restored, intent);
      persistCheckoutIntents(authorityViewerId, pendingIntents);

      const response = await gatedFetch("/api/v1/billing/checkout", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": intent.idempotencyKey,
          "x-idream-viewer-scope": `user:${authorityViewerId}`,
        },
        body: JSON.stringify({
          planId: plan.id,
          autoConfirm,
          returnPath: returnTarget,
        }),
      });
      const rawPayload: unknown = await response.json().catch(() => null);
      if (!isCurrent()) return;
      const confirmed = await viewer.revalidate();
      if (!isCurrent()) return;
      if (confirmed?.kind !== "user" || confirmed.userId !== authorityViewerId) {
        setCheckoutResult({ kind: "error", message: confirmed
          ? "Your account changed. Review the current account before continuing."
          : VIEWER_UNCONFIRMED_MESSAGE });
        return;
      }
      const error = parsePublicApiError(rawPayload);
      if (response.status === 401 || error?.code === "unauthorized") {
        window.location.assign(signupUrlForCheckout(plan, returnTarget));
        return;
      }
      if (!response.ok) {
        if (
          response.status === 409 &&
          shouldRemovePendingCheckoutIntent(error?.idempotencyAction)
        ) {
          persistCheckoutIntents(
            authorityViewerId,
            removePendingCheckoutIntent(pendingIntents, intentFingerprint),
          );
        }
        setCheckoutResult({
          kind: "error",
          message: error?.message ?? "Checkout failed",
        });
        return;
      }

      const payload = parseCheckoutResponse(rawPayload);
      setBillingMode(payload.billing);
      if (payload.subscription) {
        persistCheckoutIntents(
          authorityViewerId,
          removePendingCheckoutIntent(pendingIntents, intentFingerprint),
        );
        setActivePlan(payload.subscription.plan);
        const endLabel = formatBillingDate(
          payload.billingAccess?.benefitsEndAt ?? null,
        );
        setCheckoutResult({
          kind: "success",
          message:
            payload.billingAccess?.billingModel === "prepaid_period"
              ? `${plan.name} ${plan.billingPeriod} access is active${endLabel ? ` until ${endLabel}` : ""}. It will not renew automatically.`
              : `${plan.name} ${plan.billingPeriod} access is active.`,
          plan,
        });
      } else {
        const continued = {
          ...intent,
          checkoutUrl: payload.invoice.checkoutUrl,
        };
        persistCheckoutIntents(
          authorityViewerId,
          upsertPendingCheckoutIntent(pendingIntents, continued),
        );
        setCheckoutResult({
          kind: "redirect",
          message:
            "One-time checkout created. Continue to the payment provider to activate the selected access period.",
          url: payload.invoice.checkoutUrl,
        });
      }
    } catch (cause) {
      if (!isCurrent() || isAbortError(cause)) return;
      setCheckoutResult({
        kind: "error",
        message:
          "Checkout state could not be verified or saved. Retry to resume the same purchase intent when the connection and browser storage are available.",
      });
    } finally {
      if (isCurrent()) { writingRef.current = false; setPendingPlan(""); }
    }
  }

  const availablePeriods = (["monthly", "yearly"] as const).filter((period) =>
    plans.some((plan) => plan.billingPeriod === period),
  );
  // A published catalog can contain only one period. Never hide its offers
  // because a previous selection or an incoming link requested another one.
  const visiblePeriod = availablePeriods.includes(selectedPeriod)
    ? selectedPeriod
    : availablePeriods[0];
  const visiblePlans = plans
    .filter((plan) => plan.billingPeriod === visiblePeriod)
    .sort((left, right) => left.priceCents - right.priceCents);
  const purchasedBenefits = activePlan
    ? configuredEntitlementBenefits(activePlan.features)
    : [];

  function selectPeriod(period: Plan["billingPeriod"]) {
    // Keep this view recoverable after refresh, including an invoice whose
    // response was lost. Preserve the original task and unrelated link state.
    const url = new URL(window.location.href);
    url.searchParams.set("billing", period);
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    setSelectedPeriod(period);
  }

  return (
    <section className="px-4 pb-14 md:px-[60px]">
      {/* INTENT: 多数人是被聊天或生图的额度提示带到这里的；不买也要能一键回到原处，
          不能只剩浏览器后退。 */}
      {returnTargetReady ? (
        <p className="mx-auto mb-4 max-w-5xl text-sm">
          <Link className="font-bold underline underline-offset-4" data-testid="upgrade-return-link" href={returnTarget}>
            {returnTargetBackLabel(returnTarget)}
          </Link>
        </p>
      ) : null}
      <p className="mx-auto mb-4 max-w-5xl text-[13px] font-semibold text-[rgb(170,170,170)]">
        {FREE_CHAT_SUMMARY}
      </p>
      <p className="mx-auto mb-6 max-w-5xl text-sm text-neutral-300">
        Need more dreamcoins?{" "}
        <Link className="underline underline-offset-4" href={`/coins?returnTo=${encodeURIComponent(returnTarget)}`}>
          Visit the Dreamcoin Store
        </Link>
      </p>
      {viewer.error && <p className="mx-auto mb-5 max-w-5xl text-pink-200" role="alert">{viewer.error} <button className="ml-3 underline" onClick={() => void viewer.revalidate()} type="button">Retry account check</button></p>}
      {plansState === "loading" && (
        <p
          aria-live="polite"
          className="mx-auto max-w-5xl text-[13px] font-medium text-[rgb(170,170,170)]"
          data-testid="upgrade-plans-status"
          role="status"
        >
          Loading plans…
        </p>
      )}
      {plansState === "error" && (
        <div
          aria-live="assertive"
          className="mx-auto max-w-5xl rounded-[12px] border border-white/10 bg-[rgb(18,18,18)] p-6 text-[13px] font-medium text-[rgb(220,220,220)]"
          data-testid="upgrade-plans-status"
          role="alert"
        >
          Could not load plans.
          <button
            className="ml-3 inline-flex h-9 items-center rounded-full bg-white px-4 text-[13px] font-black text-[rgb(13,13,13)]"
            onClick={() => void loadPlans()}
            type="button"
          >
            Retry
          </button>
        </div>
      )}
      {plansState === "ready" && plans.length === 0 && (
        <p
          aria-live="polite"
          className="mx-auto max-w-5xl text-[13px] font-medium text-[rgb(170,170,170)]"
          data-testid="upgrade-plans-status"
          role="status"
        >
          No plans available right now.
        </p>
      )}
      {plansState === "ready" && billingMode?.demoMode && (
        <div
          className="mx-auto mb-5 max-w-5xl rounded-[14px] border border-[rgb(253,95,194)] bg-[rgb(36,36,36)] p-4"
          data-testid="upgrade-demo-checkout-notice"
        >
          <p className="text-[12px] font-black uppercase text-[rgb(253,95,194)]">
            Demo checkout
          </p>
          <p className="mt-2 text-[13px] font-semibold leading-5 text-white">
            Local mock billing activates one selected access period immediately
            for testing. No real payment is collected and there is no automatic
            renewal.
          </p>
        </div>
      )}
      {plansState === "ready" && plans.length > 0 && (
        <div className="mx-auto mb-6 max-w-5xl">
          <h2 className="text-xl font-bold">Choose your access period</h2>
          {availablePeriods.length > 1 ? (
            <div aria-label="Access period" className="mt-3 inline-flex gap-1 rounded-full bg-[rgb(36,36,36)] p-1" role="group">
              {availablePeriods.map((period) => (
                <button
                  aria-pressed={visiblePeriod === period}
                  className={`min-h-11 rounded-full px-6 text-sm font-bold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-[rgb(13,13,13)] disabled:opacity-60 ${visiblePeriod === period ? "bg-white text-[rgb(13,13,13)]" : "text-neutral-300 hover:text-white"}`}
                  disabled={pendingPlan !== ""}
                  key={period}
                  onClick={() => selectPeriod(period)}
                  type="button"
                >
                  {period === "monthly" ? "Monthly" : "Yearly"}
                </button>
              ))}
            </div>
          ) : (
            <p className="mt-2 text-sm text-neutral-300">
              {visiblePeriod === "monthly" ? "Monthly access" : "Yearly access"}
            </p>
          )}
          <p className="mt-3 text-sm leading-6 text-neutral-300">
            Pay once. No automatic renewal. Your existing chats and delivered media stay accessible after your access expires.
          </p>
        </div>
      )}
      {activePlan && (
        <div className="mx-auto mb-6 max-w-5xl text-sm text-neutral-300" data-testid="upgrade-current-access">
          <p>
            Current access: <span className="capitalize font-semibold text-white">{activePlan.name} {activePlan.billingPeriod}</span>.{" "}
            <Link className="underline underline-offset-4" href="/profile#billing">View access details</Link>
          </p>
          {purchasedBenefits.length > 0 && (
            <ul aria-label="Purchased benefits" className="mt-2 flex flex-wrap gap-x-6 gap-y-1">
              {purchasedBenefits.map((benefit) => <li key={benefit}>{benefit}</li>)}
            </ul>
          )}
        </div>
      )}
      <div className="mx-auto grid max-w-5xl gap-4 md:grid-cols-2">
        {visiblePlans.map((plan) => {
          const isActive = activePlan?.id === plan.id;
          const storedIntent = billingMode
            ? checkoutIntents.find(
                (intent) =>
                  intent.fingerprint ===
                  checkoutIntentFingerprint({
                    planId: plan.id,
                    autoConfirm: billingMode.autoConfirmAvailable,
                    returnPath: returnTarget,
                  }),
              )
            : undefined;
          const benefits = configuredEntitlementBenefits(plan.features);
          const matchesPurchasedOffer = isActive && activePlan !== null &&
            activePlan.name === plan.name &&
            activePlan.billingPeriod === plan.billingPeriod &&
            activePlan.priceCents === plan.priceCents &&
            activePlan.includedDreamcoins === plan.includedDreamcoins &&
            benefits.length === purchasedBenefits.length &&
            benefits.every((benefit, index) => benefit === purchasedBenefits[index]);
          return (
          <article
            aria-label={`${plan.name} ${plan.billingPeriod}`}
            className={`flex min-w-0 flex-col rounded-[16px] border p-6 ${
              matchesPurchasedOffer
                ? "border-[rgb(253,95,194)] bg-[rgb(36,36,36)]"
                : "border-white/10 bg-[rgb(18,18,18)]"
            }`}
            key={plan.id}
          >
            <div className="flex items-center justify-between">
              <Crown className="h-6 w-6 text-[rgb(253,95,194)]" />
              {isActive && (
                <span className="rounded-full bg-[rgb(253,95,194)] px-3 py-1 text-[11px] font-black uppercase text-[rgb(13,13,13)]">
                  {matchesPurchasedOffer ? "Current plan" : "Already active"}
                </span>
              )}
            </div>
            <h2 className="mt-4 text-[26px] font-black uppercase">
              {plan.name} {plan.billingPeriod}
            </h2>
            <p className="mt-2 text-[44px] font-black leading-none">
              ${(plan.priceCents / 100).toFixed(2)}
            </p>
            {/* 年付只给总价时无法和月付比较；折算成每月价让两档可以直接对比。 */}
            {plan.billingPeriod === "yearly" ? (
              <p className="mt-2 text-[13px] font-bold text-white/80" data-testid="upgrade-plan-monthly-equivalent">
                ${(Math.round(plan.priceCents / 12) / 100).toFixed(2)} per month, paid once for the year
              </p>
            ) : null}
            <p className="mt-3 text-[14px] leading-6 text-[rgb(170,170,170)]">
              One-time payment for one{" "}
              {plan.billingPeriod === "monthly" ? "month" : "year"} of access.
              No automatic renewal. Includes{" "}
              {plan.includedDreamcoins.toLocaleString()} dreamcoins.
            </p>
            <ul className="mt-3 space-y-1.5">
              {benefits.map((benefit) => (
                <li className="flex items-start gap-2 text-[13px] leading-5 text-white" key={benefit}>
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-[rgb(253,95,194)]" />
                  {benefit}
                </li>
              ))}
            </ul>
            {benefits.length === 0 ? (
              <p className="mt-3 text-[13px] leading-5 text-[rgb(170,170,170)]">
                No additional entitlements are configured for this plan.
              </p>
            ) : null}
            {isActive && !matchesPurchasedOffer && (
              <p className="mt-3 text-[13px] leading-5 text-neutral-300">
                This is today&apos;s offer. Your purchased benefits are listed above.
              </p>
            )}
            <button
              className="mt-6 min-h-11 w-full rounded-full bg-white text-[14px] font-black text-[rgb(13,13,13)] outline-none focus-visible:ring-2 focus-visible:ring-[rgb(253,95,194)] focus-visible:ring-offset-2 focus-visible:ring-offset-[rgb(18,18,18)] disabled:opacity-70"
              disabled={
                pendingPlan !== "" ||
                isActive ||
                !returnTargetReady ||
                !viewer.identity
              }
              onClick={() => checkout(plan)}
              type="button"
            >
              {isActive
                ? matchesPurchasedOffer ? "Current plan" : "Already active"
                : pendingPlan === plan.id
                  ? billingMode?.autoConfirmAvailable
                    ? "Activating..."
                    : "Creating checkout..."
                  : storedIntent
                    ? storedIntent.checkoutUrl
                      ? "Continue payment"
                      : "Resume checkout"
                    : billingMode?.autoConfirmAvailable
                      ? "Demo activate"
                      : "Buy access"}
            </button>
          </article>
          );
        })}
      </div>
      {checkoutResult && (
        <div
          aria-live={checkoutResult.kind === "error" ? "assertive" : "polite"}
          className={`mx-auto mt-5 max-w-5xl rounded-[14px] border p-5 ${
            checkoutResult.kind === "success"
              ? "border-[rgb(253,95,194)] bg-[rgb(36,36,36)]"
              : "border-[rgb(255,140,140)] bg-[rgb(18,18,18)]"
          }`}
          data-testid="upgrade-checkout-result"
          role={checkoutResult.kind === "error" ? "alert" : "status"}
        >
          <p className="text-[14px] font-black text-white">{checkoutResult.message}</p>
          {checkoutResult.kind === "success" && (
            <div className="mt-4 flex flex-wrap gap-2">
              <Link
                className="inline-flex h-10 items-center justify-center rounded-full bg-white px-5 text-[13px] font-black text-[rgb(13,13,13)]"
                href="/profile#billing"
              >
                View billing &amp; access
              </Link>
              <Link
                className="inline-flex h-10 items-center justify-center rounded-full bg-[rgb(253,95,194)] px-5 text-[13px] font-black text-[rgb(13,13,13)]"
                href={returnTarget}
              >
                {returnTargetActionLabel(returnTarget)}
              </Link>
            </div>
          )}
          {checkoutResult.kind === "redirect" && (
            <a
              className="mt-4 inline-flex h-10 items-center justify-center rounded-full bg-white px-5 text-[13px] font-black text-[rgb(13,13,13)]"
              href={checkoutResult.url}
              rel="noreferrer"
            >
              Continue checkout
            </a>
          )}
        </div>
      )}
    </section>
  );
}

function signupUrlForCheckout(plan: Plan, returnTarget: string) {
  const intent = new URLSearchParams({
    plan: plan.slug,
    billing: plan.billingPeriod,
  });
  if (returnTarget !== "/generate") {
    intent.set("returnTo", returnTarget);
  }
  return `/signup?next=${encodeURIComponent(`/upgrade?${intent.toString()}`)}`;
}

function upgradeReturnTarget() {
  if (typeof window === "undefined") return "/generate";
  const rawTarget = new URLSearchParams(window.location.search).get("returnTo");
  const target = safeInternalAuthRedirect(rawTarget, window.location.origin);
  return target === "/" ? "/generate" : target;
}

function formatBillingDate(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(date);
}

function returnTargetBackLabel(returnTarget: string) {
  if (returnTarget.startsWith("/chat/")) return "Back to your chat";
  if (returnTarget.startsWith("/generate")) return "Back to generating";
  return "Back to where you were";
}

function returnTargetActionLabel(returnTarget: string) {
  if (returnTarget.startsWith("/chat/")) return "Continue chat";
  if (returnTarget.startsWith("/generate")) return "Start generating";
  return "Continue";
}
