"use client";

import { Check, Crown } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { safeInternalAuthRedirect } from "./authRedirect";
import {
  fetchProtectedForViewer,
  type ViewerFetcher,
} from "./viewer-auth";

type Plan = {
  id: string;
  slug: string;
  name: string;
  billingPeriod: string;
  priceCents: number;
  includedDreamcoins: number;
};

type BillingMode = {
  provider: "mock" | "btcpay";
  demoMode: boolean;
  autoConfirmAvailable: boolean;
};

type CheckoutResult =
  | { kind: "success"; message: string; plan: Plan }
  | { kind: "redirect"; message: string; url: string }
  | { kind: "error"; message: string };

// P1-D: spell out the concrete chat entitlement per tier — never just
// "account-wide benefits". Mirrors the server-enforced policy (design §5.5).
function chatBenefits(slug: string): string[] {
  const s = slug.toLowerCase();
  if (s.includes("deluxe")) {
    return [
      "Unlimited text messages & audio",
      "Premium chat model (highest quality replies)",
      "3× chat memory depth",
      "Longest context window + highest rate limit",
    ];
  }
  if (s.includes("premium")) {
    return [
      "Unlimited text messages & audio",
      "Longer conversation context",
      "Advanced generation controls",
    ];
  }
  return [
    "Unlimited text messages & audio",
    "Longer context and richer memory",
  ];
}

const FREE_CHAT_SUMMARY = "Free: 30 text messages per day · basic chat model · base memory.";

export function loadUpgradeProfileForViewer(fetcher: ViewerFetcher = fetch) {
  return fetchProtectedForViewer(
    "/api/v1/profile",
    { cache: "no-store" },
    fetcher,
  );
}

export function UpgradeWorkspace() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [billingMode, setBillingMode] = useState<BillingMode | null>(null);
  const [checkoutResult, setCheckoutResult] = useState<CheckoutResult | null>(null);
  const [pendingPlan, setPendingPlan] = useState("");
  const [returnTarget, setReturnTarget] = useState("/generate");
  // Lowercased "name billingPeriod" of the user's active plan; "" when unknown
  // (logged out / free / fetch failed) so no card gets marked as current.
  const [activePlan, setActivePlan] = useState("");
  // P1-D: a failed/slow plans fetch must not masquerade as "no plans". Track
  // load lifecycle so we can show a spinner and a retryable error instead of
  // a blank grid.
  const [plansState, setPlansState] = useState<"loading" | "ready" | "error">("loading");

  const loadPlans = useCallback(async () => {
    setPlansState("loading");
    try {
      const response = await fetch("/api/v1/plans");
      if (!response.ok) throw new Error(`plans request failed (${response.status})`);
      const payload = (await response.json()) as {
        data?: { items?: Plan[]; billing?: BillingMode };
      };
      setPlans(payload.data?.items ?? []);
      setBillingMode(payload.data?.billing ?? null);
      setPlansState("ready");
    } catch {
      setPlansState("error");
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadPlans(), 0);
    return () => window.clearTimeout(timer);
  }, [loadPlans]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setReturnTarget(upgradeReturnTarget());
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  // Best-effort current-plan lookup; any failure simply leaves the cards unmarked.
  useEffect(() => {
    let alive = true;
    const timer = window.setTimeout(() => {
      void loadUpgradeProfileForViewer()
        .then((result) =>
          result.viewer === "authenticated" && result.response.ok
            ? result.response.json()
            : null,
        )
        .then(
          (
            payload: {
              data?: {
                subscription?: { plan?: { name: string; billingPeriod: string } } | null;
              };
            } | null,
          ) => {
            if (!alive) return;
            const plan = payload?.data?.subscription?.plan;
            if (plan) setActivePlan(`${plan.name} ${plan.billingPeriod}`.toLowerCase());
          },
        )
        .catch(() => undefined);
    }, 0);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, []);

  async function checkout(plan: Plan) {
    setPendingPlan(plan.id);
    setCheckoutResult(null);
    try {
      const response = await fetch("/api/v1/billing/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ planId: plan.id, autoConfirm: billingMode?.autoConfirmAvailable === true }),
      });
      const payload = (await response.json()) as {
        ok: boolean;
        data?: {
          invoice?: { checkoutUrl?: string };
          subscription?: unknown;
          billing?: BillingMode;
        };
        error?: { code?: string; message: string };
      };
      if (response.status === 401 || payload.error?.code === "unauthorized") {
        window.location.assign(signupUrlForCheckout(plan, returnTarget));
        return;
      }
      if (payload.data?.billing) setBillingMode(payload.data.billing);
      if (response.ok && payload.ok && payload.data?.subscription) {
        setActivePlan(`${plan.name} ${plan.billingPeriod}`.toLowerCase());
        setCheckoutResult({
          kind: "success",
          message: `${plan.name} ${plan.billingPeriod} is active. ${plan.includedDreamcoins.toLocaleString()} dreamcoins were added.`,
          plan,
        });
      } else if (response.ok && payload.ok && payload.data?.invoice?.checkoutUrl) {
        setCheckoutResult({
          kind: "redirect",
          message: "Checkout created. Continue to the payment provider to finish activation.",
          url: payload.data.invoice.checkoutUrl,
        });
      } else {
        setCheckoutResult({ kind: "error", message: payload.error?.message ?? "Checkout failed" });
      }
    } catch {
      setCheckoutResult({
        kind: "error",
        message: "Checkout failed. Please check your connection and try again.",
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
            Local mock billing activates plans immediately for testing. No real payment is collected.
          </p>
        </div>
      )}
      <div className="mx-auto grid max-w-5xl gap-4 md:grid-cols-2">
        {plans.map((plan, index) => {
          const isActive =
            activePlan !== "" &&
            `${plan.name} ${plan.billingPeriod}`.toLowerCase() === activePlan;
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
              Includes {plan.includedDreamcoins.toLocaleString()} dreamcoins.
            </p>
            <ul className="mt-3 space-y-1.5">
              {chatBenefits(plan.slug).map((benefit) => (
                <li className="flex items-start gap-2 text-[13px] leading-5 text-white" key={benefit}>
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-[rgb(253,95,194)]" />
                  {benefit}
                </li>
              ))}
            </ul>
            <button
              className="mt-6 h-11 w-full rounded-full bg-white text-[14px] font-black text-[rgb(13,13,13)] disabled:opacity-70"
              disabled={pendingPlan === plan.id || isActive}
              onClick={() => checkout(plan)}
              type="button"
            >
              {isActive
                ? "Current plan"
                : pendingPlan === plan.id
                  ? billingMode?.autoConfirmAvailable
                    ? "Activating..."
                    : "Creating checkout..."
                  : billingMode?.autoConfirmAvailable
                    ? "Demo upgrade"
                    : "Continue checkout"}
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
                View billing
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

function returnTargetActionLabel(returnTarget: string) {
  if (returnTarget.startsWith("/chat/")) return "Continue chat";
  if (returnTarget.startsWith("/generate")) return "Start generating";
  return "Continue";
}
