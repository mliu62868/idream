"use client";

import { Crown } from "lucide-react";
import { useEffect, useState } from "react";

type Plan = {
  id: string;
  slug: string;
  name: string;
  billingPeriod: string;
  priceCents: number;
  includedDreamcoins: number;
};

export function UpgradeWorkspace() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [status, setStatus] = useState("");
  const [pendingPlan, setPendingPlan] = useState("");

  useEffect(() => {
    fetch("/api/v1/plans")
      .then((response) => response.json())
      .then((payload: { data?: { items: Plan[] } }) => setPlans(payload.data?.items ?? []))
      .catch(() => undefined);
  }, []);

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
              Includes {plan.includedDreamcoins.toLocaleString()} dreamcoins and
              mock entitlement activation.
            </p>
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
