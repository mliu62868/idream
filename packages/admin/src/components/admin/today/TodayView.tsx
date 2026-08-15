"use client";

import { todayAllWorkResponseSchema, type TodayAllWorkResponse, type TodayProjection, type TodayWorkItem } from "@idream/shared/admin";
import Link from "next/link";
import { ArrowRight, Bell, CheckCircle2, Clock3, Eye, Inbox, Pin, UserPlus, UserRound } from "lucide-react";
import { useEffect, useState } from "react";
import { translateAdmin, useAdminI18n, type AdminLocale } from "@/components/admin/i18n";
import type { WorkMode } from "@/components/admin/nav-config";
import { adminV2Request } from "@/lib/admin-v2-api";
import { parseTodayUrl, todayAllWorkPath, todayBrowserPath, type TodayUrlState } from "./query";

type Row = Record<string, unknown>;

export type TodayLegacyData = {
  metrics: {
    users: { active: number; suspended: number };
    generation: {
      queued: number;
      failed: number;
      blocked: number;
      successRate: number | null;
    };
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
  const { locale, t } = useAdminI18n();
  const { projection } = data;
  const refresh = onPreferenceChanged ?? (() => undefined);
  const [urlState, setUrlState] = useState<TodayUrlState>({ tab: "summary", limit: 25 });
  const [allWork, setAllWork] = useState<TodayAllWorkResponse | null>(null);
  const [allWorkError, setAllWorkError] = useState("");
  const [reloadVersion, setReloadVersion] = useState(0);

  useEffect(() => {
    const restore = () => {
      setAllWork(null);
      setAllWorkError("");
      setUrlState(parseTodayUrl(new URLSearchParams(window.location.search)));
    };
    const initialRestore = window.setTimeout(restore, 0);
    window.addEventListener("popstate", restore);
    return () => {
      window.clearTimeout(initialRestore);
      window.removeEventListener("popstate", restore);
    };
  }, []);

  useEffect(() => {
    if (urlState.tab !== "all") return;
    let active = true;
    void adminV2Request(todayAllWorkPath(urlState, workMode), { schema: todayAllWorkResponseSchema })
      .then((value) => { if (active) { setAllWork(value); setAllWorkError(""); } })
      .catch((error: unknown) => { if (active) setAllWorkError(error instanceof Error ? error.message : "All Work failed to load"); })
    return () => { active = false; };
  }, [reloadVersion, urlState, workMode]);

  function navigate(next: TodayUrlState) {
    window.history.pushState(null, "", todayBrowserPath(next));
    setAllWork(null);
    setAllWorkError("");
    setUrlState(next);
  }

  function updateFilter(patch: Partial<TodayUrlState>) {
    navigate({ ...urlState, ...patch, tab: "all", cursor: undefined });
  }

  async function refreshAllWork() {
    await refresh();
    setReloadVersion((value) => value + 1);
  }

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
            {t("Fresh as of {time}", { time: formatDateTime(projection.asOf, locale) })}
          </span>
        </div>
        <p className="mt-1 pl-7 text-xs text-[var(--ad-text-muted)]">
          {t(modeContext[workMode])} {t("Ranking policy: {version}", { version: projection.rankingPolicyVersion })}
        </p>
      </section>

      <div aria-label={t("Today view")} className="flex gap-1 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-1" role="tablist">
        <button aria-selected={urlState.tab === "summary"} className="min-h-10 rounded-md px-4 text-sm font-semibold aria-selected:bg-[var(--ad-ink)] aria-selected:text-white" onClick={() => navigate({ tab: "summary", limit: 25 })} role="tab" type="button">{t("Summary")}</button>
        <button aria-selected={urlState.tab === "all"} className="min-h-10 rounded-md px-4 text-sm font-semibold aria-selected:bg-[var(--ad-ink)] aria-selected:text-white" onClick={() => navigate({ ...urlState, tab: "all" })} role="tab" type="button">{t("All work")}</button>
      </div>

      {urlState.tab === "summary" ? <>
      <WorkQueue
        description={t("Overdue or due-today work owned by you, plus commands awaiting completion or verification.")}
        icon={UserRound}
        queue={projection.myShift}
        onPreferenceChanged={refresh}
        title={t("My shift")}
      />

      <WorkQueue
        description={t("The ten highest-ranked authorized items. The total is computed from complete server-side counts.")}
        groupRelatedCreativeRuns
        icon={Clock3}
        queue={projection.nextBestActions}
        onPreferenceChanged={refresh}
        title={t("Next best actions")}
      />

      <div className="grid items-start gap-3 xl:grid-cols-3">
        <WorkQueue
          compact
          description={t("Unowned work you are permitted to claim in its source domain.")}
          icon={Inbox}
          queue={projection.unassigned}
          onPreferenceChanged={refresh}
          title={t("Unassigned work")}
        />
        <WorkQueue
          compact
          description={t("Authoritative source objects you explicitly watch.")}
          icon={Eye}
          queue={projection.watching}
          onPreferenceChanged={refresh}
          title={t("Watching")}
        />
        <WorkQueue
          compact
          description={t("Work completed and verified during the last 24 hours.")}
          icon={CheckCircle2}
          queue={projection.recentlyResolved}
          onPreferenceChanged={refresh}
          title={t("Recently resolved")}
        />
      </div>

      <details className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)]">
        <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">{t("Operational context")}</summary>
        <div className="grid gap-px border-t border-[var(--ad-border)] bg-black/[0.05] sm:grid-cols-2 lg:grid-cols-4">
          <ContextValue label={t("Active users")} value={data.legacy.metrics.users.active} />
          <ContextValue label={t("Queued generation jobs")} value={data.legacy.metrics.generation.queued} />
          <ContextValue label={t("Active subscriptions")} value={data.legacy.metrics.billing.activeSubscriptions} />
          <ContextValue label={t("Feature flags")} value={data.legacy.featureFlags.length} />
        </div>
      </details>
      </> : <section className="space-y-4" data-testid="today-all-work">
        <div className="grid gap-3 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 sm:grid-cols-2 xl:grid-cols-6">
          <TodayFilter label={t("Domain")} onChange={(value) => updateFilter({ domain: value as TodayUrlState["domain"] })} value={urlState.domain} values={["admin_case", "ops_incident", "control_plane_command", "collaboration_mention", "character_release", "creative_run"]} />
          <TodayFilter label={t("Severity")} onChange={(value) => updateFilter({ severity: value as TodayUrlState["severity"] })} value={urlState.severity} values={["critical", "high", "medium", "low"]} />
          <TodayFilter label={t("SLA")} onChange={(value) => updateFilter({ sla: value as TodayUrlState["sla"] })} value={urlState.sla} values={["overdue", "due_today", "upcoming", "none"]} />
          <TodayFilter label={t("Owner")} onChange={(value) => updateFilter({ owner: value as TodayUrlState["owner"] })} value={urlState.owner} values={["mine", "unassigned", "any"]} />
          <TodayFilter label={t("Status")} onChange={(value) => updateFilter({ status: value as TodayUrlState["status"] })} value={urlState.status} values={["active", "new", "triaged", "in_progress", "waiting", "detected", "mitigating", "monitoring", "accepted", "running", "verifying", "failed", "draft", "validating", "in_review", "approved"]} />
          <TodayFilter label={t("Environment")} onChange={(value) => updateFilter({ environment: value as TodayUrlState["environment"] })} value={urlState.environment} values={["production", "staging", "development", "test"]} />
        </div>
        {allWorkError ? <p className="rounded-lg bg-[var(--ad-red-bg)] p-4 text-sm text-[var(--ad-red-text)]" role="alert">{t(allWorkError)}</p> : null}
        {!allWork && !allWorkError ? <p className="p-4 text-sm text-[var(--ad-text-muted)]">{t("Loading All Work…")}</p> : null}
        {allWork ? <>
          <WorkQueue description={t("Complete authorized work, filtered and ranked by the same authority as Summary.")} icon={Inbox} onPreferenceChanged={refreshAllWork} queue={{ totalCount: allWork.totalCount, items: allWork.items }} title={t("All work")} />
          {allWork.pageInfo.hasNextPage && allWork.pageInfo.endCursor ? <button className="min-h-11 rounded-md border border-[var(--ad-border)] px-4 text-sm font-semibold" onClick={() => navigate({ ...urlState, cursor: allWork.pageInfo.endCursor ?? undefined })} type="button">{t("Next page")}</button> : null}
        </> : null}
      </section>}
    </div>
  );
}

function TodayFilter({ label, onChange, value, values }: { label: string; onChange: (value: string | undefined) => void; value?: string; values: readonly string[] }) {
  const { t } = useAdminI18n();
  return <label className="text-xs font-semibold text-[var(--ad-text-muted)]">{t(label)}<select className="mt-1 min-h-10 w-full rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-2 text-sm text-[var(--ad-text)]" onChange={(event) => onChange(event.target.value || undefined)} value={value ?? ""}><option value="">{t("All")}</option>{values.map((option) => <option key={option} value={option}>{t(option.replaceAll("_", " "))}</option>)}</select></label>;
}

function WorkQueue({
  compact = false,
  description,
  groupRelatedCreativeRuns = false,
  icon: Icon,
  queue,
  onPreferenceChanged,
  title,
}: {
  compact?: boolean;
  description: string;
  groupRelatedCreativeRuns?: boolean;
  icon: typeof Clock3;
  queue: TodayProjection["myShift"];
  onPreferenceChanged: () => void | Promise<void>;
  title: string;
}) {
  const { t } = useAdminI18n();
  const groups = groupRelatedCreativeRuns
    ? groupTodayQueueItems(queue.items)
    : queue.items.map((item) => ({ key: `${item.sourceType}:${item.sourceId}`, items: [item] }));
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
          {groups.map((group) => group.items.length === 1 ? (
            <WorkItem compact={compact} item={group.items[0]} key={group.key} onPreferenceChanged={onPreferenceChanged} watched={title === "Watching"} />
          ) : (
            <RelatedCreativeRuns
              compact={compact}
              items={group.items}
              key={group.key}
              onPreferenceChanged={onPreferenceChanged}
            />
          ))}
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

type TodayQueueItemGroup = {
  key: string;
  items: TodayWorkItem[];
  creativeKey: string | null;
};

function creativeRunGroupKey(item: TodayWorkItem) {
  if (item.sourceType !== "creative_run") return null;
  const { purpose, targetId, targetType } = item.impactSnapshot;
  if (
    typeof purpose !== "string" || !purpose ||
    typeof targetId !== "string" || !targetId ||
    typeof targetType !== "string" || !targetType
  ) return null;
  return `${targetType}:${targetId}:${purpose}`;
}

// INTENT: Keep the server's rank order intact. Only adjacent runs can collapse;
// grouping across another ranked item would visually move lower-priority work upward.
export function groupTodayQueueItems(items: readonly TodayWorkItem[]): TodayQueueItemGroup[] {
  const groups: TodayQueueItemGroup[] = [];
  for (const item of items) {
    const creativeKey = creativeRunGroupKey(item);
    const previous = groups.at(-1);
    if (creativeKey && previous?.creativeKey === creativeKey) {
      previous.items.push(item);
      continue;
    }
    groups.push({
      key: creativeKey ? `creative:${creativeKey}:${item.sourceId}` : `${item.sourceType}:${item.sourceId}`,
      items: [item],
      creativeKey,
    });
  }
  return groups;
}

function RelatedCreativeRuns({
  compact,
  items,
  onPreferenceChanged,
}: {
  compact: boolean;
  items: TodayWorkItem[];
  onPreferenceChanged: () => void | Promise<void>;
}) {
  const { locale, t } = useAdminI18n();
  const first = items[0];
  const targetId = String(first.impactSnapshot.targetId).replaceAll("_", " ");
  const purpose = todayOperationalText(
    String(first.impactSnapshot.purpose).replaceAll("_", " "),
    locale,
  );
  return (
    <div data-testid="today-related-creative-runs">
      <div className="border-b border-[var(--ad-border)] bg-black/[0.02] px-4 py-2">
        <p className="text-xs font-semibold">
          {t("{count} related Creative Runs", { count: items.length })}
        </p>
        <p className="mt-0.5 text-[10px] text-[var(--ad-text-muted)]">
          {targetId} · {purpose}
        </p>
      </div>
      <WorkItem compact={compact} item={first} onPreferenceChanged={onPreferenceChanged} watched={false} />
      <details className="border-t border-[var(--ad-border)]">
        <summary className="cursor-pointer px-4 py-3 text-xs font-semibold text-[var(--ad-text-muted)]">
          {t("Review {count} more", { count: items.length - 1 })}
        </summary>
        <div className="divide-y divide-[var(--ad-border)] border-t border-[var(--ad-border)] bg-black/[0.015]">
          {items.slice(1).map((item) => (
            <WorkItem compact={compact} item={item} key={item.sourceId} onPreferenceChanged={onPreferenceChanged} watched={false} />
          ))}
        </div>
      </details>
    </div>
  );
}

function WorkItem({ compact, item, onPreferenceChanged, watched }: { compact: boolean; item: TodayWorkItem; onPreferenceChanged: () => void | Promise<void>; watched: boolean }) {
  const { locale, t } = useAdminI18n();
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
          <p className="mt-1 text-xs leading-5 text-[var(--ad-text-muted)]">{todayOperationalText(item.summary, locale)}</p>
          {!compact ? <p className="mt-2 text-xs">{todayOperationalText(item.recommendedAction, locale)}</p> : null}
          <p className="mt-2 text-[10px] leading-4 text-[var(--ad-text-muted)]">{todayOperationalText(item.rankingReason, locale)}</p>
          <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-[var(--ad-text-muted)]">
            <span>{t("Owner")}: {item.ownerId ?? t("Unassigned")}</span>
            <span>{t("SLA")}: {item.slaDueAt ? formatDateTime(item.slaDueAt, locale) : t("No deadline")}</span>
            <span>{t("Verification")}: {t(item.verificationState)}</span>
            <span>{t(item.environment)} · {t(item.dataClass)}</span>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button className="inline-flex min-h-9 items-center gap-1 rounded border border-[var(--ad-border)] px-2 text-xs disabled:opacity-50" disabled={busy} onClick={() => void updatePreference({ watching: !watched }, watched ? "Removed from Watching" : "Added to Watching")} type="button"><Eye className="h-3.5 w-3.5" />{watched ? t("Unwatch") : t("Watch")}</button>
            <button className="inline-flex min-h-9 items-center gap-1 rounded border border-[var(--ad-border)] px-2 text-xs disabled:opacity-50" disabled={busy} onClick={() => void updatePreference({ pinned: !item.pinned }, item.pinned ? "Unpinned" : "Pinned")} type="button"><Pin className="h-3.5 w-3.5" />{item.pinned ? t("Unpin") : t("Pin")}</button>
            <button className="inline-flex min-h-9 items-center gap-1 rounded border border-[var(--ad-border)] px-2 text-xs disabled:opacity-50" disabled={busy} onClick={() => void updatePreference({ snoozedUntil: new Date(Date.now() + 60 * 60 * 1_000).toISOString() }, "Snoozed for one hour")} type="button"><Bell className="h-3.5 w-3.5" />{t("Snooze 1h")}</button>
            {item.claim ? <button className="inline-flex min-h-9 items-center gap-1 rounded bg-[var(--ad-ink)] px-2 text-xs font-semibold text-white disabled:opacity-50" disabled={busy} onClick={() => void claimItem()} type="button"><UserPlus className="h-3.5 w-3.5" />{t("Claim")}</button> : null}
          </div>
          {status ? <p className="mt-2 text-xs text-[var(--ad-text-muted)]" role="status">{t(status)}</p> : null}
        </div>
      </div>
    </div>
  );
}

export function todayOperationalText(text: string, locale: AdminLocale) {
  if (locale === "en") return text;

  const entityState = /^([a-z_]+) (.+) is ([a-z_]+)$/i.exec(text);
  if (entityState) {
    const [, entityType, entityId, state] = entityState;
    const [targetType, ...targetId] = entityId.split(":");
    const target = targetId.length
      ? `${translateAdmin(locale, targetType)}:${targetId.join(":")}`
      : entityId;
    return `${translateAdmin(locale, entityType.replaceAll("_", " "))} ${target} · ${translateAdmin(locale, state)}`;
  }

  const incidentState = /^Incident is ([a-z_]+)$/i.exec(text);
  if (incidentState) {
    return `${translateAdmin(locale, "Incident")} · ${translateAdmin(locale, incidentState[1])}`;
  }

  if (text.includes(" · ")) {
    return text.split(" · ").map((segment) => todayOperationalSegment(segment, locale)).join(" · ");
  }
  return translateAdmin(locale, text);
}

function todayOperationalSegment(segment: string, locale: AdminLocale) {
  const severity = /^([a-z_]+) severity$/i.exec(segment);
  if (severity) {
    return `${translateAdmin(locale, "Severity")}：${translateAdmin(locale, severity[1])}`;
  }
  const sla = /^SLA (.+)$/i.exec(segment);
  if (sla) return `SLA：${formatOperationalDate(sla[1], locale)}`;
  const openSince = /^open since (.+)$/i.exec(segment);
  if (openSince) return `开始于 ${formatOperationalDate(openSince[1], locale)}`;
  const readiness = /^readiness ([a-z_]+)$/i.exec(segment);
  if (readiness) {
    return `${translateAdmin(locale, "Readiness")}：${translateAdmin(locale, readiness[1])}`;
  }
  return translateAdmin(locale, segment);
}

function formatOperationalDate(value: string, locale: AdminLocale) {
  return Number.isNaN(new Date(value).getTime()) ? value : formatDateTime(value, locale);
}

function formatDateTime(value: string, locale: "en" | "zh") {
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
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
