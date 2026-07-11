"use client";

import type { TodayProjection, TodayWorkItem } from "@idream/shared/admin";
import Link from "next/link";
import { ArrowRight, CheckCircle2, Clock3, Eye, Inbox, UserRound } from "lucide-react";
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

export type TodayData = {
  legacy: TodayLegacyData;
  projection: TodayProjection;
};

const modeContext: Record<WorkMode, string> = {
  character_producer: "Character releases and verification blockers are ranked first when present.",
  creative_operator: "Creative execution and placement blockers are ranked first when present.",
  platform_ops: "Incidents and failed control-plane commands are ranked first.",
  support: "Assigned support cases and their linked operational work are in scope.",
  moderator: "Moderation cases and verification failures are ranked first.",
  growth_analyst: "Only work authorized by your effective permissions is shown.",
  admin: "All authorized operational domains participate in ranking.",
};

export function TodayView({ data, workMode }: { data: TodayData; workMode: WorkMode }) {
  const { t } = useAdminI18n();
  const { projection } = data;

  return (
    <div className="space-y-6" data-testid="today-view">
      <section
        aria-label={t("Today data status")}
        className="rounded-lg border border-[var(--ad-green-text)]/25 bg-[var(--ad-green-bg)] px-4 py-3"
        role="status"
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <CheckCircle2 className="h-4 w-4 text-[var(--ad-green-text)]" />
          <p className="text-sm font-semibold text-[var(--ad-green-text)]">{t("Authoritative Today projection")}</p>
          <span className="text-xs text-[var(--ad-text-muted)]">
            {t("Fresh as of {time}", { time: formatDateTime(projection.asOf) })}
          </span>
        </div>
        <p className="mt-1 pl-7 text-xs text-[var(--ad-text-muted)]">
          {t(modeContext[workMode])} {t("Ranking policy: {version}", { version: projection.rankingPolicyVersion })}
        </p>
      </section>

      <WorkQueue
        description="Overdue or due-today work owned by you, plus commands awaiting completion or verification."
        icon={UserRound}
        queue={projection.myShift}
        title="My shift"
      />

      <WorkQueue
        description="The ten highest-ranked authorized items. The total is computed from complete server-side counts."
        icon={Clock3}
        queue={projection.nextBestActions}
        title="Next best actions"
      />

      <div className="grid items-start gap-3 xl:grid-cols-3">
        <WorkQueue
          compact
          description="Unowned work you are permitted to claim in its source domain."
          icon={Inbox}
          queue={projection.unassigned}
          title="Unassigned work"
        />
        <WorkQueue
          compact
          description="Authoritative source objects you explicitly watch."
          icon={Eye}
          queue={projection.watching}
          title="Watching"
        />
        <WorkQueue
          compact
          description="Work completed and verified during the last 24 hours."
          icon={CheckCircle2}
          queue={projection.recentlyResolved}
          title="Recently resolved"
        />
      </div>

      <details className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)]">
        <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">{t("Operational context")}</summary>
        <div className="grid gap-px border-t border-[var(--ad-border)] bg-black/[0.05] sm:grid-cols-2 lg:grid-cols-4">
          <ContextValue label="Active users" value={data.legacy.metrics.users.active} />
          <ContextValue label="Queued generation jobs" value={data.legacy.metrics.generation.queued} />
          <ContextValue label="Active subscriptions" value={data.legacy.metrics.billing.activeSubscriptions} />
          <ContextValue label="Feature flags" value={data.legacy.featureFlags.length} />
        </div>
      </details>
    </div>
  );
}

function WorkQueue({
  compact = false,
  description,
  icon: Icon,
  queue,
  title,
}: {
  compact?: boolean;
  description: string;
  icon: typeof Clock3;
  queue: TodayProjection["myShift"];
  title: string;
}) {
  const { t } = useAdminI18n();
  return (
    <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)]" data-testid={`today-queue-${title.toLowerCase().replaceAll(" ", "-")}`}>
      <div className="border-b border-[var(--ad-border)] p-4">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-[var(--ad-text-muted)]" />
          <h2 className="text-sm font-semibold">{t(title)}</h2>
          <span className="ml-auto rounded-full bg-black/[0.05] px-2 py-1 text-xs font-semibold tabular-nums">
            {queue.totalCount}
          </span>
        </div>
        <p className="mt-1 text-xs leading-5 text-[var(--ad-text-muted)]">{t(description)}</p>
      </div>
      {queue.items.length === 0 ? (
        <p className="p-4 text-xs text-[var(--ad-text-muted)]">{t("No matching work right now.")}</p>
      ) : (
        <div className="divide-y divide-[var(--ad-border)]">
          {queue.items.map((item) => <WorkItem compact={compact} item={item} key={`${item.sourceType}:${item.sourceId}`} />)}
        </div>
      )}
      {queue.totalCount > queue.items.length ? (
        <p className="border-t border-[var(--ad-border)] px-4 py-2 text-[10px] text-[var(--ad-text-muted)]">
          {t("Showing {shown} of {total} authoritative items", { shown: queue.items.length, total: queue.totalCount })}
        </p>
      ) : null}
    </section>
  );
}

function WorkItem({ compact, item }: { compact: boolean; item: TodayWorkItem }) {
  const { t } = useAdminI18n();
  return (
    <Link className="group block p-4 transition-colors hover:bg-black/[0.025]" href={item.deepLink}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded bg-black/[0.05] px-1.5 py-0.5 text-[10px] font-semibold uppercase">{t(item.severity)}</span>
            <span className="text-[10px] uppercase text-[var(--ad-text-muted)]">{t(item.sourceType.replaceAll("_", " "))}</span>
            {item.pinned ? <span className="text-[10px] font-semibold uppercase">{t("Pinned")}</span> : null}
          </div>
          <h3 className="mt-2 truncate text-sm font-semibold">{t(item.title)}</h3>
          <p className="mt-1 text-xs leading-5 text-[var(--ad-text-muted)]">{t(item.summary)}</p>
          {!compact ? <p className="mt-2 text-xs">{t(item.recommendedAction)}</p> : null}
          <p className="mt-2 text-[10px] leading-4 text-[var(--ad-text-muted)]">{t(item.rankingReason)}</p>
          <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-[var(--ad-text-muted)]">
            <span>{t("Owner")}: {item.ownerId ?? t("Unassigned")}</span>
            <span>{t("SLA")}: {item.slaDueAt ? formatDateTime(item.slaDueAt) : t("No deadline")}</span>
            <span>{t("Verification")}: {t(item.verificationState)}</span>
            <span>{item.environment} · {item.dataClass}</span>
          </div>
        </div>
        <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-[var(--ad-text-muted)] transition-transform group-hover:translate-x-0.5" />
      </div>
    </Link>
  );
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(value));
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
