"use client";

import type { TodayProjection, TodayWorkItem } from "@idream/shared/admin";
import Link from "next/link";
import { ArrowRight, Bell, CheckCircle2, Clock3, Eye, Inbox, Pin, UserPlus, UserRound } from "lucide-react";
import { useState } from "react";
import { useAdminI18n } from "@/components/admin/i18n";
import type { WorkMode } from "@/components/admin/nav-config";
import { adminV2Request } from "@/lib/admin-v2-api";

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

export function TodayView({ data, onPreferenceChanged, workMode }: { data: TodayData; onPreferenceChanged?: () => void | Promise<void>; workMode: WorkMode }) {
  const { t } = useAdminI18n();
  const { projection } = data;
  const refresh = onPreferenceChanged ?? (() => undefined);

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
        onPreferenceChanged={refresh}
        title="My shift"
      />

      <WorkQueue
        description="The ten highest-ranked authorized items. The total is computed from complete server-side counts."
        icon={Clock3}
        queue={projection.nextBestActions}
        onPreferenceChanged={refresh}
        title="Next best actions"
      />

      <div className="grid items-start gap-3 xl:grid-cols-3">
        <WorkQueue
          compact
          description="Unowned work you are permitted to claim in its source domain."
          icon={Inbox}
          queue={projection.unassigned}
          onPreferenceChanged={refresh}
          title="Unassigned work"
        />
        <WorkQueue
          compact
          description="Authoritative source objects you explicitly watch."
          icon={Eye}
          queue={projection.watching}
          onPreferenceChanged={refresh}
          title="Watching"
        />
        <WorkQueue
          compact
          description="Work completed and verified during the last 24 hours."
          icon={CheckCircle2}
          queue={projection.recentlyResolved}
          onPreferenceChanged={refresh}
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
  onPreferenceChanged,
  title,
}: {
  compact?: boolean;
  description: string;
  icon: typeof Clock3;
  queue: TodayProjection["myShift"];
  onPreferenceChanged: () => void | Promise<void>;
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
          {queue.items.map((item) => <WorkItem compact={compact} item={item} key={`${item.sourceType}:${item.sourceId}`} onPreferenceChanged={onPreferenceChanged} watched={title === "Watching"} />)}
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

function WorkItem({ compact, item, onPreferenceChanged, watched }: { compact: boolean; item: TodayWorkItem; onPreferenceChanged: () => void | Promise<void>; watched: boolean }) {
  const { t } = useAdminI18n();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  async function updatePreference(patch: { watching?: boolean; pinned?: boolean; snoozedUntil?: string | null }, label: string) {
    setBusy(true);
    setStatus("");
    try {
      await adminV2Request("/api/v2/admin/today/preferences", {
        method: "PUT",
        ifMatch: item.preferenceVersion,
        body: { sourceType: item.sourceType, sourceId: item.sourceId, ...patch },
      });
      setStatus(label);
      await onPreferenceChanged();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Preference update failed");
    } finally {
      setBusy(false);
    }
  }
  async function claimItem() {
    if (!item.claim) return;
    setBusy(true);
    setStatus("");
    try {
      await adminV2Request("/api/v2/admin/today/claim", {
        method: "POST",
        idempotencyKey: `today-claim:${item.sourceType}:${item.sourceId}:${item.claim.entityVersion}`,
        body: {
          sourceType: item.sourceType,
          sourceId: item.sourceId,
          entityVersion: item.claim.entityVersion,
        },
      });
      setStatus("Claimed by you");
      await onPreferenceChanged();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Claim failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="p-4 transition-colors hover:bg-black/[0.025]">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded bg-black/[0.05] px-1.5 py-0.5 text-[10px] font-semibold uppercase">{t(item.severity)}</span>
            <span className="text-[10px] uppercase text-[var(--ad-text-muted)]">{t(item.sourceType.replaceAll("_", " "))}</span>
            {item.pinned ? <span className="text-[10px] font-semibold uppercase">{t("Pinned")}</span> : null}
          </div>
          <Link className="group mt-2 flex items-center gap-2 text-sm font-semibold" href={item.deepLink}><span className="truncate">{t(item.title)}</span><ArrowRight className="h-4 w-4 shrink-0 text-[var(--ad-text-muted)] transition-transform group-hover:translate-x-0.5" /></Link>
          <p className="mt-1 text-xs leading-5 text-[var(--ad-text-muted)]">{t(item.summary)}</p>
          {!compact ? <p className="mt-2 text-xs">{t(item.recommendedAction)}</p> : null}
          <p className="mt-2 text-[10px] leading-4 text-[var(--ad-text-muted)]">{t(item.rankingReason)}</p>
          <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-[var(--ad-text-muted)]">
            <span>{t("Owner")}: {item.ownerId ?? t("Unassigned")}</span>
            <span>{t("SLA")}: {item.slaDueAt ? formatDateTime(item.slaDueAt) : t("No deadline")}</span>
            <span>{t("Verification")}: {t(item.verificationState)}</span>
            <span>{item.environment} · {item.dataClass}</span>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button className="inline-flex min-h-9 items-center gap-1 rounded border border-[var(--ad-border)] px-2 text-xs disabled:opacity-50" disabled={busy} onClick={() => void updatePreference({ watching: !watched }, watched ? "Removed from Watching" : "Added to Watching")} type="button"><Eye className="h-3.5 w-3.5" />{watched ? t("Unwatch") : t("Watch")}</button>
            <button className="inline-flex min-h-9 items-center gap-1 rounded border border-[var(--ad-border)] px-2 text-xs disabled:opacity-50" disabled={busy} onClick={() => void updatePreference({ pinned: !item.pinned }, item.pinned ? "Unpinned" : "Pinned")} type="button"><Pin className="h-3.5 w-3.5" />{item.pinned ? t("Unpin") : t("Pin")}</button>
            <button className="inline-flex min-h-9 items-center gap-1 rounded border border-[var(--ad-border)] px-2 text-xs disabled:opacity-50" disabled={busy} onClick={() => void updatePreference({ snoozedUntil: new Date(Date.now() + 60 * 60 * 1_000).toISOString() }, "Snoozed for one hour")} type="button"><Bell className="h-3.5 w-3.5" />{t("Snooze 1h")}</button>
            {item.claim ? <button className="inline-flex min-h-9 items-center gap-1 rounded bg-[var(--ad-accent)] px-2 text-xs font-semibold text-white disabled:opacity-50" disabled={busy} onClick={() => void claimItem()} type="button"><UserPlus className="h-3.5 w-3.5" />{t("Claim")}</button> : null}
          </div>
          {status ? <p className="mt-2 text-xs text-[var(--ad-text-muted)]" role="status">{t(status)}</p> : null}
        </div>
      </div>
    </div>
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
