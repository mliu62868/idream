"use client";

import { Check, Crown } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import {
  parseCheckoutResponse,
  parsePlansResponse,
  parseProfileResponse,
  parsePublicApiError,
  parseViewerAuthorityResponse,
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
import { safeInternalAuthRedirect } from "./authRedirect";
import {
  fetchProtectedForViewer,
  type ViewerFetcher,
} from "./viewer-auth";
import {
  configuredEntitlementBenefits,
  FREE_CHAT_SUMMARY,
} from "./entitlement-copy";

type CheckoutResult =
  | { kind: "success"; message: string; plan: Plan }
  | { kind: "redirect"; message: string; url: string }
  | { kind: "error"; message: string };

export function loadUpgradeProfileForViewer(fetcher: ViewerFetcher = fetch) {
  return fetchProtectedForViewer(
    "/api/v1/profile",
    { cache: "no-store" },
    fetcher,
  );
}

export function UpgradeWorkspace() {
  const { accepted: ageGateAccepted } = useAgeGateAccess();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [billingMode, setBillingMode] = useState<BillingMode | null>(null);
  const [checkoutResult, setCheckoutResult] = useState<CheckoutResult | null>(null);
  const [pendingPlan, setPendingPlan] = useState("");
  const [returnTarget, setReturnTarget] = useState("/generate");
  const [returnTargetReady, setReturnTargetReady] = useState(false);
  // Lowercased "name billingPeriod" of the user's active plan; "" when unknown
  // (logged out / free / fetch failed) so no card gets marked as current.
  const [activePlan, setActivePlan] = useState("");
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [viewerResolved, setViewerResolved] = useState(false);
  const [checkoutIntents, setCheckoutIntents] = useState<
    PendingCheckoutIntent[]
  >([]);
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
      setReturnTargetReady(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!ageGateAccepted) return;
    const controller = new AbortController();
    void loadUpgradeViewerId(fetch, controller.signal)
      .then((id) => {
        if (controller.signal.aborted) return;
        setViewerId(id);
        setViewerResolved(true);
        setCheckoutIntents(
          id
            ? readPendingCheckoutIntents(window.sessionStorage, id)
            : [],
        );
      })
      .catch(() => {
        if (!controller.signal.aborted) setViewerResolved(false);
      });
    return () => controller.abort();
  }, [ageGateAccepted]);

  // Best-effort current-plan lookup; any failure simply leaves the cards unmarked.
  useEffect(() => {
    if (!ageGateAccepted) return;
    let alive = true;
    const timer = window.setTimeout(() => {
      void loadUpgradeProfileForViewer()
        .then((result) =>
          result.viewer === "authenticated" && result.response.ok
            ? result.response.json()
            : null,
        )
        .then((payload: unknown) => {
          if (!alive || payload === null) return;
          const plan = parseProfileResponse(payload).subscription?.plan;
          if (plan) {
            setActivePlan(
              `${plan.name} ${plan.billingPeriod}`.toLowerCase(),
            );
          }
        })
        .catch(() => undefined);
    }, 0);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [ageGateAccepted]);

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
      let authorityViewerId = viewerId;
      if (!viewerResolved) {
        authorityViewerId = await loadUpgradeViewerId();
        setViewerId(authorityViewerId);
        setViewerResolved(true);
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

      const response = await fetch("/api/v1/billing/checkout", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": intent.idempotencyKey,
        },
        body: JSON.stringify({
          planId: plan.id,
          autoConfirm,
          returnPath: returnTarget,
        }),
      });
      const rawPayload: unknown = await response.json().catch(() => null);
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
        setActivePlan(`${plan.name} ${plan.billingPeriod}`.toLowerCase());
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
    } catch {
      setCheckoutResult({
        kind: "error",
        message:
          "Checkout state could not be verified or saved. Retry to resume the same purchase intent when the connection and browser storage are available.",
      });
    } finally {
      setPendingPlan("");
    }
  }

  return (
    <section className="px-4 pb-14 md:px-[60px]">
      <p className="mx-auto mb-4 max-w-5xl text-[13px] font-semibold text-[rgb(170,170,170)]">
        {FREE_CHAT_SUMMARY}
      </p>
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
      <div className="mx-auto grid max-w-5xl gap-4 md:grid-cols-2">
        {plans.map((plan, index) => {
          const isActive =
            activePlan !== "" &&
            `${plan.name} ${plan.billingPeriod}`.toLowerCase() === activePlan;
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
          return (
          <article
            className={`rounded-[20px] border p-6 ${
              index === 0
                ? "border-[rgb(253,95,194)] bg-[rgb(36,36,36)]"
                : "border-white/10 bg-[rgb(18,18,18)]"
            }`}
            key={plan.id}
          >
            <div className="flex items-center justify-between">
              <Crown className="h-6 w-6 text-[rgb(253,95,194)]" />
              {isActive && (
                <span className="rounded-full bg-[rgb(253,95,194)] px-3 py-1 text-[11px] font-black uppercase text-[rgb(13,13,13)]">
                  Current plan
                </span>
              )}
            </div>
            <h2 className="mt-4 text-[26px] font-black uppercase">
              {plan.name} {plan.billingPeriod}
            </h2>
            <p className="mt-2 text-[44px] font-black leading-none">
              ${(plan.priceCents / 100).toFixed(2)}
            </p>
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
            <button
              className="mt-6 h-11 w-full rounded-full bg-white text-[14px] font-black text-[rgb(13,13,13)] disabled:opacity-70"
              disabled={
                pendingPlan !== "" ||
                isActive ||
                !returnTargetReady
              }
              onClick={() => checkout(plan)}
              type="button"
            >
              {isActive
                ? "Current plan"
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

function returnTargetActionLabel(returnTarget: string) {
  if (returnTarget.startsWith("/chat/")) return "Continue chat";
  if (returnTarget.startsWith("/generate")) return "Start generating";
  return "Continue";
}

async function loadUpgradeViewerId(
  fetcher: ViewerFetcher = fetch,
  signal?: AbortSignal,
) {
  const response = await fetcher("/api/v1/me", {
    cache: "no-store",
    signal,
  });
  if (!response.ok) throw new Error("Viewer authority unavailable");
  return parseViewerAuthorityResponse(await response.json()).user?.id ?? null;
}
