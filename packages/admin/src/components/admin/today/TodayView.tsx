"use client";

import { todayAllWorkResponseSchema, type TodayAllWorkResponse, type TodayProjection, type TodaySourceType } from "@idream/shared/admin";
import { AlertTriangle, CheckCircle2, Clock3, Eye, Inbox, SlidersHorizontal, UserRound, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useAdminI18n } from "@/components/admin/i18n";
import type { WorkMode } from "@/components/admin/nav-config";
import { formatDateTime, formatRelativeTime } from "@/components/admin/ui/format";
import { Pagination } from "@/components/admin/ui/Pagination";
import { adminV2Request } from "@/lib/admin-v2-api";
import { useActionFeedback } from "./feedback";
import { focusWorkItem, formatCount, queueHealth, slaState, todayCounts, type QueueHealth, type TodayCounts } from "./health";
import {
  activeTodayFilters,
  parseTodayUrl,
  todayAllWorkPath,
  todayBrowserPath,
  todayStatusGroups,
  withoutTodayFilters,
  type TodayFilterKey,
  type TodayUrlState,
} from "./query";
import { WorkQueue, type WorkDensity } from "./WorkQueue";

type Row = Record<string, unknown>;

const DENSITY_STORAGE_KEY = "idream.admin.today.density";

// SPEC: 走过的游标挂在 history entry 上，不只挂在组件 state 里。
// INTENT: 刷新和「后退」都会重建组件，只靠 state 就把页码清成 1 —— 地址栏还带着第 4 页的游标，
//         分页条却说「第 1 页 · 第 1–25 条」，那是编出来的数字。history.state 跟着这条
//         history entry 走，刷新和前进后退都还在。
type TodayHistoryState = { pageCursors?: readonly string[] };

function restoredPageCursors(): readonly string[] {
  const state = window.history.state as TodayHistoryState | null;
  return Array.isArray(state?.pageCursors) ? state.pageCursors : [];
}

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

export function TodayView({ data, onPreferenceChanged, workMode }: { data: TodayData; onPreferenceChanged?: () => void | Promise<void>; workMode: WorkMode }) {
  const { t } = useAdminI18n();
  const { projection } = data;
  const refresh = onPreferenceChanged ?? (() => undefined);
  const [urlState, setUrlState] = useState<TodayUrlState>({ tab: "summary", limit: 25 });
  const [allWork, setAllWork] = useState<TodayAllWorkResponse | null>(null);
  const [allWorkError, setAllWorkError] = useState("");
  const [reloadVersion, setReloadVersion] = useState(0);
  const [overdueTotal, setOverdueTotal] = useState<number | null>(null);
  const [density, setDensity] = useState<WorkDensity>("compact");
  const [pageCursors, setPageCursors] = useState<readonly string[]>([]);
  const report = useActionFeedback();
  const now = new Date();
  const counts = todayCounts(projection, overdueTotal, now);
  const health = queueHealth(counts);
  const focus = focusWorkItem(projection);

  useEffect(() => {
    const restore = () => {
      setAllWork(null);
      setAllWorkError("");
      const cursors = restoredPageCursors();
      setPageCursors(cursors);
      const next = parseTodayUrl(new URLSearchParams(window.location.search));
      // 游标是别人分享过来的（history.state 不跟着 URL 走），我们放不下它在第几页 ——
      // 与其显示一个猜出来的页码，不如带着同一组筛选回到第一页。
      setUrlState(cursors.length === 0 ? { ...next, cursor: undefined } : next);
    };
    const initialRestore = window.setTimeout(() => {
      restore();
      const stored = window.localStorage.getItem(DENSITY_STORAGE_KEY);
      if (stored === "comfortable" || stored === "compact") setDensity(stored);
    }, 0);
    window.addEventListener("popstate", restore);
    return () => {
      window.clearTimeout(initialRestore);
      window.removeEventListener("popstate", restore);
    };
  }, []);

  // SPEC: 精确的超时条数。
  // INTENT: 投影每个队列只发前十条，第十一条起是否超时前端无从知道 —— 这是首屏唯一
  //         算不出来的数字，用 all-work 的 totalCount 补齐（limit=1，只要那个计数）。
  useEffect(() => {
    let active = true;
    void adminV2Request(todayAllWorkPath({ tab: "all", limit: 1, sla: "overdue" }, workMode), { schema: todayAllWorkResponseSchema })
      .then((value) => { if (active) setOverdueTotal(value.totalCount); })
      .catch(() => { if (active) setOverdueTotal(null); });
    return () => { active = false; };
  }, [projection, workMode]);

  useEffect(() => {
    if (urlState.tab !== "all") return;
    let active = true;
    void adminV2Request(todayAllWorkPath(urlState, workMode), { schema: todayAllWorkResponseSchema })
      .then((value) => { if (active) { setAllWork(value); setAllWorkError(""); } })
      .catch((error: unknown) => { if (active) setAllWorkError(error instanceof Error ? error.message : "All Work failed to load"); })
    return () => { active = false; };
  }, [reloadVersion, urlState, workMode]);

  /** 任何改查询的动作都把游标栈清空（cursors 默认空），否则页码会挂在旧结果上。 */
  function navigate(next: TodayUrlState, cursors: readonly string[] = []) {
    window.history.pushState({ pageCursors: cursors } satisfies TodayHistoryState, "", todayBrowserPath(next));
    setPageCursors(cursors);
    setAllWork(null);
    setAllWorkError("");
    setUrlState(next);
  }

  function updateFilter(patch: Partial<TodayUrlState>) {
    navigate({ ...urlState, ...patch, tab: "all", cursor: undefined });
  }

  /** KPI 与横幅按钮进来的是"只看这一类"，不是在既有筛选上再叠一层。 */
  function openAllWork(patch: Partial<TodayUrlState>) {
    navigate({ tab: "all", limit: urlState.limit, ...patch });
  }

  function changeDensity(next: WorkDensity) {
    setDensity(next);
    window.localStorage.setItem(DENSITY_STORAGE_KEY, next);
  }

  async function refreshAll() {
    await refresh();
    setReloadVersion((value) => value + 1);
  }

  const queueProps = { density, onFeedback: report, onPreferenceChanged: refreshAll };
  const filters = activeTodayFilters(urlState);

  return (
    <div className="space-y-4" data-testid="today-view">
      <HealthBanner
        asOf={projection.asOf}
        counts={counts}
        focus={focus}
        health={health}
        now={now}
        onFocus={(target) => openAllWork(target === "overdue" ? { sla: "overdue" } : { owner: "unassigned" })}
      />

      <KpiBand counts={counts} onSelect={openAllWork} />

      <div className="flex flex-wrap items-center gap-2">
        <div aria-label={t("Today view")} className="flex gap-1 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-1" role="tablist">
          <button aria-selected={urlState.tab === "summary"} className="min-h-10 rounded-md px-4 text-sm font-semibold aria-selected:bg-[var(--ad-ink)] aria-selected:text-white" onClick={() => navigate({ tab: "summary", limit: 25 })} role="tab" type="button">{t("Summary")}</button>
          <button aria-selected={urlState.tab === "all"} className="min-h-10 rounded-md px-4 text-sm font-semibold aria-selected:bg-[var(--ad-ink)] aria-selected:text-white" onClick={() => navigate({ ...urlState, tab: "all" })} role="tab" type="button">{t("All work")}</button>
        </div>
        <div aria-label={t("Row density")} className="ml-auto flex gap-1 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-1" role="group">
          <button aria-pressed={density === "compact"} className="min-h-10 rounded-md px-3 text-xs font-semibold aria-pressed:bg-[var(--ad-ink)] aria-pressed:text-white" onClick={() => changeDensity("compact")} type="button">{t("Compact")}</button>
          <button aria-pressed={density === "comfortable"} className="min-h-10 rounded-md px-3 text-xs font-semibold aria-pressed:bg-[var(--ad-ink)] aria-pressed:text-white" onClick={() => changeDensity("comfortable")} type="button">{t("Comfortable")}</button>
        </div>
      </div>

      {urlState.tab === "summary" ? <>
        <WorkQueue
          {...queueProps}
          description={t("Overdue or due-today work owned by you, plus commands awaiting completion or verification.")}
          icon={UserRound}
          queue={projection.myShift}
          queueName="My shift"
        />

        <WorkQueue
          {...queueProps}
          description={t("The ten highest-ranked items you are authorized to work on.")}
          groupRelatedCreativeRuns
          icon={Clock3}
          queue={projection.nextBestActions}
          queueName="Next best actions"
        />

        <div className="grid items-start gap-3 xl:grid-cols-3">
          <WorkQueue
            {...queueProps}
            description={t("Unowned work you are permitted to claim in its source domain.")}
            icon={Inbox}
            queue={projection.unassigned}
            queueName="Unassigned work"
          />
          <WorkQueue
            {...queueProps}
            description={t("Items you explicitly watch.")}
            icon={Eye}
            queue={projection.watching}
            queueName="Watching"
            watchedQueue
          />
          <WorkQueue
            {...queueProps}
            actionable={false}
            description={t("Work completed and verified during the last 24 hours.")}
            icon={CheckCircle2}
            queue={projection.recentlyResolved}
            queueName="Recently resolved"
          />
        </div>

        {/* 这四个数字不产生本页的任何动作，是平台背景 —— 保持折叠，也不再自称"运营上下文"。 */}
        <details className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)]">
          <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">{t("Platform background")}</summary>
          <div className="grid gap-px border-t border-[var(--ad-border)] bg-black/[0.05] sm:grid-cols-2 lg:grid-cols-4">
            <ContextValue label={t("Active users")} value={data.legacy.metrics.users.active} />
            <ContextValue label={t("Queued generation jobs")} value={data.legacy.metrics.generation.queued} />
            <ContextValue label={t("Active subscriptions")} value={data.legacy.metrics.billing.activeSubscriptions} />
            <ContextValue label={t("Feature flags")} value={data.legacy.featureFlags.length} />
          </div>
        </details>
      </> : <section className="space-y-3" data-testid="today-all-work">
        <div className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)]">
          <details>
            <summary className="flex min-h-11 cursor-pointer items-center gap-2 px-4 text-sm font-semibold">
              <SlidersHorizontal aria-hidden className="h-4 w-4 text-[var(--ad-text-muted)]" />
              {t("Filters")}
              {allWork ? <span className="ml-auto text-xs font-normal tabular-nums text-[var(--ad-text-muted)]">{t("{count} results", { count: allWork.totalCount })}</span> : null}
            </summary>
            <div className="grid gap-3 border-t border-[var(--ad-border)] p-4 sm:grid-cols-2 xl:grid-cols-6">
              <TodayFilter label="Domain" onChange={(value) => updateFilter({ domain: value as TodayUrlState["domain"], status: undefined })} value={urlState.domain} values={["admin_case", "ops_incident", "control_plane_command", "collaboration_mention", "character_release", "creative_run"]} />
              <TodayFilter label="Severity" onChange={(value) => updateFilter({ severity: value as TodayUrlState["severity"] })} value={urlState.severity} values={["critical", "high", "medium", "low"]} />
              <TodayFilter label="SLA" onChange={(value) => updateFilter({ sla: value as TodayUrlState["sla"] })} value={urlState.sla} values={["overdue", "due_today", "upcoming", "none"]} />
              <TodayFilter label="Owner" onChange={(value) => updateFilter({ owner: value as TodayUrlState["owner"] })} value={urlState.owner} values={["mine", "unassigned", "any"]} />
              <StatusFilter domain={urlState.domain} onChange={(value) => updateFilter({ status: value as TodayUrlState["status"] })} value={urlState.status} />
              <TodayFilter label="Environment" onChange={(value) => updateFilter({ environment: value as TodayUrlState["environment"] })} value={urlState.environment} values={["production", "staging", "development", "test"]} />
            </div>
          </details>
          {filters.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2 border-t border-[var(--ad-border)] px-4 py-2">
              {filters.map((filter) => (
                <button
                  className="inline-flex min-h-9 items-center gap-1 rounded-full bg-black/[0.05] px-2.5 text-xs"
                  key={filter.key}
                  onClick={() => updateFilter({ [filter.key]: undefined })}
                  type="button"
                >
                  <FilterChipLabel filterKey={filter.key} value={filter.value} />
                  <X aria-hidden className="h-3 w-3" />
                </button>
              ))}
              <button className="min-h-9 text-xs text-[var(--ad-text-muted)] underline underline-offset-2" onClick={() => navigate(withoutTodayFilters(urlState))} type="button">
                {t("Clear filters")}
              </button>
            </div>
          ) : null}
        </div>
        {allWorkError ? <p className="rounded-lg bg-[var(--ad-red-bg)] p-4 text-sm text-[var(--ad-red-text)]" role="alert">{t(allWorkError)}</p> : null}
        {!allWork && !allWorkError ? (
          <div aria-label={t("Loading work")} className="space-y-2 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4" role="status">
            {[0, 1, 2, 3, 4].map((row) => <div className="h-8 animate-pulse rounded bg-black/[0.05]" key={row} />)}
          </div>
        ) : null}
        {allWork ? <>
          <WorkQueue
            {...queueProps}
            description={t("Every item you are authorized to work on, filtered and ranked as in Summary.")}
            emptyMessage={filters.length > 0 ? t("No work matches these filters.") : undefined}
            icon={Inbox}
            queue={{ totalCount: allWork.totalCount, items: allWork.items }}
            queueName="All work"
          />
          <Pagination
            hasNext={Boolean(allWork.pageInfo.hasNextPage && allWork.pageInfo.endCursor)}
            // 「上一页」走本地游标栈，不是 pageInfo.hasPreviousPage —— all-work 还是单向
            // keyset，栈是我们自己走过来的路，比缺席的反向游标更可靠。
            hasPrevious={pageCursors.length > 0}
            onNext={() => {
              const cursor = allWork.pageInfo.endCursor ?? undefined;
              navigate({ ...urlState, cursor }, cursor ? [...pageCursors, cursor] : pageCursors);
            }}
            onPrevious={() => {
              const previous = pageCursors.slice(0, -1);
              navigate({ ...urlState, cursor: previous.at(-1) }, previous);
            }}
            page={pageCursors.length + 1}
            pageSize={urlState.limit}
            rowCount={allWork.items.length}
            totalCount={allWork.totalCount}
          />
        </> : null}
      </section>}
    </div>
  );
}

const BANNER_TONE = {
  critical: { border: "border-[var(--ad-red-text)]/25", surface: "bg-[var(--ad-red-bg)]", text: "text-[var(--ad-red-text)]" },
  warning: { border: "border-[var(--ad-yellow-text)]/25", surface: "bg-[var(--ad-yellow-bg)]", text: "text-[var(--ad-yellow-text)]" },
  calm: { border: "border-[var(--ad-green-text)]/25", surface: "bg-[var(--ad-green-bg)]", text: "text-[var(--ad-green-text)]" },
} as const;

function HealthBanner({
  asOf,
  counts,
  focus,
  health,
  now,
  onFocus,
}: {
  asOf: string;
  counts: TodayCounts;
  focus: ReturnType<typeof focusWorkItem>;
  health: QueueHealth;
  now: Date;
  onFocus: (target: "overdue" | "unassigned") => void;
}) {
  const { locale, t } = useAdminI18n();
  const tone = BANNER_TONE[health.tone];
  const overdueFocus = focus && slaState(focus.slaDueAt, now) === "overdue" ? focus.slaDueAt : null;
  return (
    <section aria-label={t("Queue health")} className={`rounded-lg border ${tone.border} ${tone.surface} px-4 py-3`} data-testid="today-health" role="status">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {health.tone === "calm"
          ? <CheckCircle2 aria-hidden className={`h-4 w-4 ${tone.text}`} />
          : <AlertTriangle aria-hidden className={`h-4 w-4 ${tone.text}`} />}
        <p className={`text-sm font-semibold ${tone.text}`}>{t(health.headline, health.values)}</p>
        <span className="text-xs text-[var(--ad-text-muted)]">{t("Fresh as of {time}", { time: formatDateTime(asOf, locale) })}</span>
        {health.focus ? (
          <button className={`ml-auto min-h-9 rounded-md border border-current px-3 text-xs font-semibold ${tone.text}`} onClick={() => onFocus(health.focus!)} type="button">
            {health.focus === "overdue" ? t("Review overdue work") : t("Review unclaimed work")}
          </button>
        ) : null}
      </div>
      {focus ? (
        <p className="mt-2 flex flex-wrap items-baseline gap-x-2 text-xs">
          <span className="font-semibold text-[var(--ad-text-muted)]">{t("Start here")}</span>
          <Link className="font-semibold underline underline-offset-2" href={focus.deepLink}>{t(focus.title)}</Link>
          {overdueFocus ? <span className="text-[var(--ad-red-text)]">{t("SLA due {elapsed}", { elapsed: formatRelativeTime(overdueFocus, now.toISOString(), locale) })}</span> : null}
        </p>
      ) : null}
      {counts.mine === 0 && counts.unassigned > 0 ? (
        <p className="mt-1 text-xs text-[var(--ad-text-muted)]">{t("Your shift is empty while {count} items have no owner. Claim one to start.", { count: counts.unassigned })}</p>
      ) : null}
    </section>
  );
}

function KpiBand({ counts, onSelect }: { counts: TodayCounts; onSelect: (patch: Partial<TodayUrlState>) => void }) {
  const { t } = useAdminI18n();
  return (
    <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-5" data-testid="today-kpis">
      <Kpi label={t("Open work")} onClick={() => onSelect({})} value={String(counts.pending)} />
      <Kpi
        alert={counts.overdue > 0}
        label={t("SLA overdue")}
        onClick={() => onSelect({ sla: "overdue" })}
        title={counts.overdueExact ? undefined : t("At least this many — the authoritative count has not loaded")}
        value={formatCount(counts.overdue, counts.overdueExact)}
      />
      <Kpi label={t("Unclaimed")} onClick={() => onSelect({ owner: "unassigned" })} value={String(counts.unassigned)} />
      <Kpi label={t("Mine today")} onClick={() => onSelect({ owner: "mine" })} value={String(counts.mine)} />
      {/* 已解决的工作不在 All Work（只返回活跃项）里，给不出可点的去处，就不假装可点。 */}
      <Kpi label={t("Resolved in 24h")} value={String(counts.resolved24h)} />
    </div>
  );
}

function Kpi({ alert = false, label, onClick, title, value }: { alert?: boolean; label: string; onClick?: () => void; title?: string; value: string }) {
  const className = `rounded-lg border px-4 py-3 text-left ${alert ? "border-[var(--ad-red-text)]/25 bg-[var(--ad-red-bg)]" : "border-[var(--ad-border)] bg-[var(--ad-surface)]"}`;
  const body = (
    <>
      <p className={`text-xs ${alert ? "text-[var(--ad-red-text)]" : "text-[var(--ad-text-muted)]"}`}>{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${alert ? "text-[var(--ad-red-text)]" : ""}`}>{value}</p>
    </>
  );
  if (!onClick) return <div className={className} title={title}>{body}</div>;
  return (
    <button className={`${className} transition-shadow hover:shadow-[var(--ad-shadow-hover)]`} onClick={onClick} title={title} type="button">
      {body}
    </button>
  );
}

const FILTER_LABELS: Record<TodayFilterKey, string> = {
  domain: "Domain",
  severity: "Severity",
  sla: "SLA",
  owner: "Owner",
  ownerId: "Owner",
  status: "Status",
  environment: "Environment",
};

function FilterChipLabel({ filterKey, value }: { filterKey: TodayFilterKey; value: string }) {
  const { t } = useAdminI18n();
  return <span>{t(FILTER_LABELS[filterKey])}: {t(value)}</span>;
}

function TodayFilter({ label, onChange, value, values }: { label: string; onChange: (value: string | undefined) => void; value?: string; values: readonly string[] }) {
  const { t } = useAdminI18n();
  return (
    <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
      {t(label)}
      <select className="mt-1 min-h-10 w-full rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-2 text-sm text-[var(--ad-text)]" onChange={(event) => onChange(event.target.value || undefined)} value={value ?? ""}>
        <option value="">{t("All")}</option>
        {values.map((option) => <option key={option} value={option}>{t(option)}</option>)}
      </select>
    </label>
  );
}

function StatusFilter({ domain, onChange, value }: { domain?: TodaySourceType; onChange: (value: string | undefined) => void; value?: string }) {
  const { t } = useAdminI18n();
  const groups = todayStatusGroups(domain);
  return (
    <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
      {t("Status")}
      <select className="mt-1 min-h-10 w-full rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-2 text-sm text-[var(--ad-text)]" onChange={(event) => onChange(event.target.value || undefined)} value={value ?? ""}>
        <option value="">{t("All")}</option>
        {domain
          ? groups[0].statuses.map((status) => <option key={status} value={status}>{t(status)}</option>)
          : groups.map((group) => (
            <optgroup key={group.domain} label={t(group.domain)}>
              {group.statuses.map((status) => <option key={`${group.domain}:${status}`} value={status}>{t(status)}</option>)}
            </optgroup>
          ))}
      </select>
    </label>
  );
}

function ContextValue({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-[var(--ad-surface)] p-4">
      <p className="text-xs text-[var(--ad-text-muted)]">{label}</p>
      <p className="mt-1 text-lg font-semibold">{value}</p>
    </div>
  );
}
