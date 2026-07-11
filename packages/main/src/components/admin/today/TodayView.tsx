"use client";

import Link from "next/link";
import { AlertTriangle, ArrowRight, CheckCircle2, Clock3, Eye, Inbox, UserRound } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { apiGet } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";
import type { WorkMode } from "@/components/admin/nav-config";

type Row = Record<string, unknown>;

export type TodayLegacyData = {
  metrics: {
    users: { active: number; suspended: number };
    generation: { queued: number; failed: number; blocked: number; successRate: number };
    moderation: { openReports: number };
    billing: { activeSubscriptions: number };
  };
  featureFlags: Row[];
};

type ActionSignal = {
  id: "jobs" | "reports" | "submissions" | "tickets";
  title: string;
  count: number | null;
  href: string;
  reason: string;
};

const MODE_PRIORITY: Record<WorkMode, readonly ActionSignal["id"][]> = {
  character_producer: ["submissions", "jobs", "reports", "tickets"],
  creative_operator: ["jobs", "submissions", "reports", "tickets"],
  platform_ops: ["jobs", "tickets", "reports", "submissions"],
  support: ["tickets", "jobs", "reports", "submissions"],
  moderator: ["reports", "submissions", "tickets", "jobs"],
  growth_analyst: ["jobs", "tickets", "reports", "submissions"],
  admin: ["jobs", "reports", "submissions", "tickets"],
};

export function TodayView({
  data,
  permissions,
  workMode,
}: {
  data: TodayLegacyData;
  permissions: ReadonlySet<string>;
  workMode: WorkMode;
}) {
  const { t } = useAdminI18n();
  const [pending, setPending] = useState<{ submissions: number | null; tickets: number | null }>({
    submissions: null,
    tickets: null,
  });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [reviewQueue, support] = await Promise.all([
          permissions.has("safety.review.read")
            ? apiGet<{ items: unknown[] }>("/api/v1/admin/content/review-queue?status=pending")
            : Promise.resolve(null),
          permissions.has("support.request.read")
            ? apiGet<{ items: unknown[] }>("/api/v1/admin/support/requests?status=active")
            : Promise.resolve(null),
        ]);
        if (!cancelled) setPending({
          submissions: reviewQueue?.items.length ?? null,
          tickets: support?.items.length ?? null,
        });
      } catch {
        if (!cancelled) setPending({ submissions: null, tickets: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [permissions]);

  const actions = useMemo(() => {
    const signals: ActionSignal[] = [
      {
        id: "jobs",
        title: "Failed or blocked jobs",
        count: data.metrics.generation.failed + data.metrics.generation.blocked,
        href: "/admin/ops/jobs",
        reason: "Technical failures can prevent customer delivery.",
      },
      {
        id: "reports",
        title: "Open moderation cases",
        count: data.metrics.moderation.openReports,
        href: "/admin/cases?view=moderation",
        reason: "Open reports still need an operator decision.",
      },
      {
        id: "submissions",
        title: "Pending character reviews",
        count: pending.submissions,
        href: "/admin/characters/review",
        reason: "Pending submissions can block a planned character release.",
      },
      {
        id: "tickets",
        title: "Active support cases",
        count: pending.tickets,
        href: "/admin/cases?view=support",
        reason: "Customer requests may be waiting for a response.",
      },
    ];
    const rank = MODE_PRIORITY[workMode];
    return signals
      .filter((signal) => {
        if (signal.id === "jobs") return permissions.has("generation.job.read");
        if (signal.id === "reports" || signal.id === "submissions") return permissions.has("safety.review.read");
        return permissions.has("support.request.read");
      })
      .sort((left, right) => rank.indexOf(left.id) - rank.indexOf(right.id));
  }, [data, pending, permissions, workMode]);

  return (
    <div className="space-y-6" data-testid="today-view">
      <section
        aria-label={t("Today data status")}
        className="rounded-lg border border-[var(--ad-yellow-text)]/25 bg-[var(--ad-yellow-bg)] px-4 py-3"
        role="status"
      >
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--ad-yellow-text)]" />
          <div>
            <p className="text-sm font-semibold text-[var(--ad-yellow-text)]">{t("Degraded Today projection")}</p>
            <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
              {t("Source: legacy v1 aggregates. Owner, SLA, impact, ranking confidence, and verification are unavailable until the v2 work-item projection is connected.")}
            </p>
          </div>
        </div>
      </section>

      <UnavailableQueue
        description="Legacy sources do not identify the current actor as owner or approver. Nothing is claimed as My shift."
        icon={UserRound}
        title="My shift"
      />

      <section className="space-y-3" aria-labelledby="next-best-actions-heading">
        <div>
          <h2 className="text-sm font-semibold" id="next-best-actions-heading">{t("Next best actions")}</h2>
          <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
            {t("Ordered for the selected work mode; counts are complete legacy endpoint results, not owner/SLA-aware priorities.")}
          </p>
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {actions.map((action, index) => (
            <Link
              className="group rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 transition-colors hover:border-[var(--ad-ink)]"
              href={action.href}
              key={action.id}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="text-[10px] font-semibold uppercase text-[var(--ad-text-muted)]">
                  {t("Priority {rank}", { rank: index + 1 })}
                </span>
                <ArrowRight className="h-4 w-4 text-[var(--ad-text-muted)] transition-transform group-hover:translate-x-0.5" />
              </div>
              <p className="mt-3 text-2xl font-semibold">{action.count ?? "—"}</p>
              <h3 className="mt-1 text-sm font-semibold">{t(action.title)}</h3>
              <p className="mt-2 text-xs leading-5 text-[var(--ad-text-muted)]">{t(action.reason)}</p>
              <p className="mt-3 text-[10px] uppercase text-[var(--ad-text-muted)]">
                {action.count === null ? t("Legacy source unavailable") : t("Legacy source")}
              </p>
            </Link>
          ))}
        </div>
      </section>

      <div className="grid gap-3 lg:grid-cols-3">
        <UnavailableQueue
          description="Domain roots do not yet expose a unified unassigned projection. Use the domain queues above."
          icon={Inbox}
          title="Unassigned work"
        />
        <UnavailableQueue
          description="Watch preferences and change notifications are not connected in legacy v1."
          icon={Eye}
          title="Watching"
        />
        <UnavailableQueue
          description="Legacy actions do not carry authoritative verification state, so resolved work is not inferred."
          icon={CheckCircle2}
          title="Recently resolved"
        />
      </div>

      <details className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)]">
        <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">{t("Legacy operational context")}</summary>
        <div className="grid gap-px border-t border-[var(--ad-border)] bg-black/[0.05] sm:grid-cols-2 lg:grid-cols-4">
          <ContextValue label="Active users" value={data.metrics.users.active} />
          <ContextValue label="Queued generation jobs" value={data.metrics.generation.queued} />
          <ContextValue label="Active subscriptions" value={data.metrics.billing.activeSubscriptions} />
          <ContextValue label="Feature flags" value={data.featureFlags.length} />
        </div>
      </details>
    </div>
  );
}

function UnavailableQueue({
  description,
  icon: Icon,
  title,
}: {
  description: string;
  icon: typeof Clock3;
  title: string;
}) {
  const { t } = useAdminI18n();
  return (
    <section className="rounded-lg border border-dashed border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-[var(--ad-text-muted)]" />
        <h2 className="text-sm font-semibold">{t(title)}</h2>
        <span className="ml-auto rounded-full bg-black/[0.05] px-2 py-1 text-[10px] uppercase text-[var(--ad-text-muted)]">
          {t("Unavailable")}
        </span>
      </div>
      <p className="mt-2 text-xs leading-5 text-[var(--ad-text-muted)]">{t(description)}</p>
    </section>
  );
}

function ContextValue({ label, value }: { label: string; value: number }) {
  const { t } = useAdminI18n();
  return (
    <div className="bg-[var(--ad-surface)] p-4">
      <p className="text-xs text-[var(--ad-text-muted)]">{t(label)}</p>
      <p className="mt-1 text-lg font-semibold">{value}</p>
    </div>
  );
}
