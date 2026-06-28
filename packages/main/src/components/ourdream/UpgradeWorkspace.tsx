"use client";

import { Check, Crown } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

type Plan = {
  id: string;
  slug: string;
  name: string;
  billingPeriod: string;
  priceCents: number;
  includedDreamcoins: number;
};

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

export function UpgradeWorkspace() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [status, setStatus] = useState("");
  const [pendingPlan, setPendingPlan] = useState("");
  // P1-D: a failed/slow plans fetch must not masquerade as "no plans". Track
  // load lifecycle so we can show a spinner and a retryable error instead of
  // a blank grid.
  const [plansState, setPlansState] = useState<"loading" | "ready" | "error">("loading");

  const loadPlans = useCallback(async () => {
    setPlansState("loading");
    try {
      const response = await fetch("/api/v1/plans");
      if (!response.ok) throw new Error(`plans request failed (${response.status})`);
      const payload = (await response.json()) as { data?: { items?: Plan[] } };
      setPlans(payload.data?.items ?? []);
      setPlansState("ready");
    } catch {
      setPlansState("error");
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadPlans(), 0);
    return () => window.clearTimeout(timer);
  }, [loadPlans]);

  async function checkout(plan: Plan) {
    setPendingPlan(plan.id);
    setStatus("");
    try {
      const response = await fetch("/api/v1/billing/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ planId: plan.id, autoConfirm: true }),
      });
      const payload = (await response.json()) as { ok: boolean; error?: { message: string } };
      setStatus(
        response.ok && payload.ok
          ? `${plan.name} activated and dreamcoins granted.`
          : payload.error?.message ?? "Checkout failed",
      );
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
        <p className="mx-auto max-w-5xl text-[13px] font-medium text-[rgb(170,170,170)]">
          Loading plans…
        </p>
      )}
      {plansState === "error" && (
        <div className="mx-auto max-w-5xl rounded-[12px] border border-white/10 bg-[rgb(18,18,18)] p-6 text-[13px] font-medium text-[rgb(220,220,220)]">
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
        <p className="mx-auto max-w-5xl text-[13px] font-medium text-[rgb(170,170,170)]">
          No plans available right now.
        </p>
      )}
      <div className="mx-auto grid max-w-5xl gap-4 md:grid-cols-2">
        {plans.map((plan, index) => (
          <article
            className={`rounded-[20px] border p-6 ${
              index === 0
                ? "border-[rgb(253,95,194)] bg-[rgb(36,36,36)]"
                : "border-white/10 bg-[rgb(18,18,18)]"
            }`}
            key={plan.id}
          >
            <Crown className="h-6 w-6 text-[rgb(253,95,194)]" />
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
              disabled={pendingPlan === plan.id}
              onClick={() => checkout(plan)}
              type="button"
            >
              {pendingPlan === plan.id ? "Activating..." : "Upgrade"}
            </button>
          </article>
        ))}
      </div>
      {status && (
        <p className="mx-auto mt-5 max-w-5xl text-[13px] font-bold text-[rgb(170,170,170)]">
          {status}
        </p>
      )}
    </section>
  );
}
