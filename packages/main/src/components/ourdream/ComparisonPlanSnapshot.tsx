"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import {
  parsePlansResponse,
  type PublicPlan as Plan,
} from "@/lib/public-api-contracts";
import { useAgeGateAccess } from "./AgeGateBoundary";

type PlansState = "loading" | "ready" | "error";

export function ComparisonPlanSnapshot() {
  const { accepted: ageGateAccepted } = useAgeGateAccess();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [state, setState] = useState<PlansState>("loading");

  useEffect(() => {
    if (!ageGateAccepted) return;
    const timer = window.setTimeout(() => {
      void fetch("/api/v1/plans")
        .then(async (response) => {
          if (!response.ok) throw new Error("plans unavailable");
          const payload = parsePlansResponse(await response.json());
          setPlans(payload.items);
          setState("ready");
        })
        .catch(() => {
          setPlans([]);
          setState("error");
        });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [ageGateAccepted]);

  return (
    <section className="px-4 py-10 md:px-[60px] md:py-12">
      <div className="mx-auto max-w-6xl">
        <div className="max-w-3xl">
          <p className="text-[12px] font-black uppercase leading-4 text-[rgb(253,95,194)]">
            Live plan snapshot
          </p>
          <h2 className="mt-3 text-[32px] font-black uppercase leading-9 text-white md:text-[42px] md:leading-[44px]">
            Current prices and included dreamcoins
          </h2>
          <p className="mt-4 text-[14px] font-medium leading-7 text-[rgb(170,170,170)]">
            This snapshot is loaded from the same plan authority used by
            Upgrade and checkout.
          </p>
        </div>

        {state === "loading" ? (
          <p
            aria-live="polite"
            className="mt-7 rounded-[14px] border border-white/10 bg-[rgb(18,18,18)] p-6 text-[13px] font-medium text-[rgb(170,170,170)]"
            data-testid="comparison-plans-status"
            role="status"
          >
            Loading current plans...
          </p>
        ) : null}

        {state === "ready" && plans.length === 0 ? (
          <div
            aria-live="polite"
            className="mt-7 rounded-[14px] border border-white/10 bg-[rgb(18,18,18)] p-6 md:flex md:items-center md:justify-between md:gap-8"
            data-testid="comparison-plans-status"
            role="status"
          >
            <div>
              <h3 className="text-[20px] font-black uppercase leading-6 text-white">
                No upgrade plans are available right now.
              </h3>
              <p className="mt-2 text-[13px] font-medium leading-6 text-[rgb(170,170,170)]">
                The comparison guide remains available, and Upgrade will show
                new plans as soon as they are published.
              </p>
            </div>
            <Link
              className="mt-5 inline-flex h-10 shrink-0 items-center justify-center rounded-full bg-white px-5 text-[13px] font-black text-[rgb(13,13,13)] md:mt-0"
              href="/upgrade"
            >
              Open Upgrade
            </Link>
          </div>
        ) : null}

        {state === "error" ? (
          <div
            aria-live="assertive"
            className="mt-7 rounded-[14px] border border-white/10 bg-[rgb(18,18,18)] p-6 md:flex md:items-center md:justify-between md:gap-8"
            data-testid="comparison-plans-status"
            role="alert"
          >
            <div>
              <h3 className="text-[20px] font-black uppercase leading-6 text-white">
                Plan details are temporarily unavailable.
              </h3>
              <p className="mt-2 text-[13px] font-medium leading-6 text-[rgb(170,170,170)]">
                We are not substituting stale prices. Open Upgrade to retry
                against the current plan catalog.
              </p>
            </div>
            <Link
              className="mt-5 inline-flex h-10 shrink-0 items-center justify-center rounded-full bg-white px-5 text-[13px] font-black text-[rgb(13,13,13)] md:mt-0"
              href="/upgrade"
            >
              Open Upgrade
            </Link>
          </div>
        ) : null}

        {state === "ready" && plans.length > 0 ? (
          <div className="mt-7 grid gap-3 md:grid-cols-2">
            {plans.map((plan) => (
              <article
                className="rounded-[14px] border border-white/10 bg-[rgb(18,18,18)] p-5"
                data-testid="comparison-plan-card"
                key={plan.id}
              >
                <p className="text-[12px] font-black uppercase leading-4 text-[rgb(253,95,194)]">
                  {plan.name} {plan.billingPeriod}
                </p>
                <h3 className="mt-4 text-[34px] font-black uppercase leading-none text-white">
                  ${(plan.priceCents / 100).toFixed(2)}
                </h3>
                <p className="mt-4 min-h-14 text-[14px] font-medium leading-7 text-[rgb(170,170,170)]">
                  Includes {plan.includedDreamcoins.toLocaleString()} dreamcoins
                  with this {plan.billingPeriod} plan.
                </p>
                <Link
                  className="mt-5 inline-flex h-10 items-center justify-center gap-2 rounded-full bg-white px-5 text-[13px] font-black text-[rgb(13,13,13)] hover:bg-white/90"
                  href={`/upgrade?plan=${encodeURIComponent(plan.slug)}&billing=${encodeURIComponent(plan.billingPeriod)}`}
                >
                  View {plan.name}
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </article>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
