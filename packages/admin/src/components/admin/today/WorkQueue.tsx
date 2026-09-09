"use client";

import { operationalWorkPreferenceSchema, type TodayProjection, type TodayWorkItem } from "@idream/shared/admin";
import { ArrowLeft, ArrowRight, Bell, Eye, MoreHorizontal, Pin, UserPlus } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useAdminI18n } from "@/components/admin/i18n";
import { adminV2Request } from "@/lib/admin-v2-api";
import { formatDateTime, formatRelativeTime } from "@/components/admin/ui/format";
import { failureFeedback, type ActionFeedback } from "./feedback";
import { formatTime, todayOperationalText } from "./format";
import { severityTone, slaState, snoozeOptions, type WorkTone } from "./health";

export type WorkDensity = "compact" | "comfortable";

const TONE_CLASSES: Record<WorkTone, string> = {
  danger: "bg-[var(--ad-red-bg)] text-[var(--ad-red-text)]",
  warning: "bg-[var(--ad-yellow-bg)] text-[var(--ad-yellow-text)]",
  info: "bg-[var(--ad-blue-bg)] text-[var(--ad-blue-text)]",
  neutral: "bg-black/[0.05] text-[var(--ad-text-muted)]",
};

type PreferencePatch = { watching?: boolean; pinned?: boolean; snoozedUntil?: string | null };
type FeedbackSink = (feedback: ActionFeedback) => void;

export function workItemKey(item: TodayWorkItem) {
  return `${item.sourceType}:${item.sourceId}`;
}

type Translate = (key: string, values?: Record<string, string | number>) => string;

// SPEC: Today 生成的系统标题必须跟随界面语言；运营人员自己写的标题保持原文。
// INTENT: 事故严重度已经由紧邻标题的色标表达，标题再重复 medium/high 只增加扫读噪音。
export function todayWorkItemTitle(item: TodayWorkItem, t: Translate) {
  if (item.sourceType === "ops_incident") {
    const incident = /^(?:critical|high|medium|low) incident:\s*(.+)$/i.exec(item.title);
    if (incident) return /^[a-f0-9]{32,}$/i.test(incident[1]) ? t("Operational incident") : t("Incident: {signature}", { signature: incident[1] });
  }
  return t(item.title);
}

function writePreference(item: TodayWorkItem, patch: PreferencePatch, expectedVersion: number) {
  return adminV2Request("/api/v2/admin/today/preferences", {
    method: "PUT",
    ifMatch: expectedVersion,
    body: { sourceType: item.sourceType, sourceId: item.sourceId, ...patch },
    schema: operationalWorkPreferenceSchema,
  });
}

function claimWorkItem(item: TodayWorkItem) {
  if (!item.claim) throw new Error("Work item is not claimable");
  return adminV2Request("/api/v2/admin/today/claim", {
    method: "POST",
    idempotencyKey: `today-claim:${item.sourceType}:${item.sourceId}:${item.claim.entityVersion}`,
    body: { sourceType: item.sourceType, sourceId: item.sourceId, entityVersion: item.claim.entityVersion },
  });
}

export function WorkQueue({
  actionable = true,
  density,
  description,
  emptyMessage,
  groupRelatedCreativeRuns = false,
  icon: Icon,
  onFeedback,
  onPreferenceChanged,
  queue,
  queueName,
  watchedQueue = false,
}: {
  actionable?: boolean;
  density: WorkDensity;
  description: string;
  emptyMessage?: string;
  groupRelatedCreativeRuns?: boolean;
  icon: typeof Eye;
  onFeedback: FeedbackSink;
  onPreferenceChanged: () => void | Promise<void>;
  queue: TodayProjection["myShift"];
  /** 英文原名：既是 i18n key，也是 data-testid 的来源（testid 不能随语言变）。 */
  queueName: string;
  watchedQueue?: boolean;
}) {
  const { locale, t } = useAdminI18n();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [mobilePreview, setMobilePreview] = useState(false);
  const previewRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (mobilePreview && window.matchMedia("(max-width: 1023px)").matches) {
      previewRef.current?.focus({ preventScroll: true });
      previewRef.current?.scrollIntoView({ block: "start" });
    }
  }, [mobilePreview, previewKey]);
  const preview = queue.items.find((item) => workItemKey(item) === previewKey) ?? queue.items[0];
  function openPreview(item: TodayWorkItem) {
    setPreviewKey(workItemKey(item));
    setMobilePreview(true);
  }
  const [busy, setBusy] = useState(false);
  const now = new Date();
  const groups = groupRelatedCreativeRuns
    ? groupTodayQueueItems(queue.items)
    : queue.items.map((item) => ({ key: workItemKey(item), items: [item] }));
  const selectedItems = queue.items.filter((item) => selected.has(workItemKey(item)));
  const claimable = selectedItems.filter((item) => item.claim);

  function toggle(item: TodayWorkItem, checked: boolean) {
    const next = new Set(selected);
    if (checked) next.add(workItemKey(item));
    else next.delete(workItemKey(item));
    setSelected(next);
  }

  // SPEC: 批量逐条串行执行，把 N 次结果收敛成一条反馈。
  // INTENT: 串行是为了让每条都带着自己那一版 preferenceVersion / entityVersion 提交；
  //         并发发出去只会互相把版本号打旧，换来一批 409。
  async function runBulk(successMessage: string, run: (item: TodayWorkItem) => Promise<unknown>, items = selectedItems) {
    if (items.length === 0) return;
    setBusy(true);
    let done = 0;
    let lastError: unknown = null;
    for (const item of items) {
      try {
        await run(item);
        done += 1;
      } catch (error) {
        lastError = error;
      }
    }
    const failed = items.length - done;
    if (failed > 0) {
      const failure = failureFeedback(lastError);
      onFeedback({ ...failure, message: "{done} succeeded, {failed} failed", values: { done, failed } });
    } else {
      onFeedback({ tone: "success", message: successMessage, values: { count: done } });
    }
    setSelected(new Set());
    await onPreferenceChanged();
    setBusy(false);
  }

  const itemProps = {
    density,
    locale,
    now,
    onFeedback,
    onPreferenceChanged,
    watchedQueue,
    onPreview: openPreview,
    previewKey: preview ? workItemKey(preview) : null,
  };

  return (
    <section className="min-w-0 grid items-start gap-3 lg:grid-cols-[minmax(280px,0.85fr)_minmax(320px,1fr)]" data-testid={`today-queue-${queueName.toLowerCase().replaceAll(" ", "-")}`}>
      <div className={`${mobilePreview && preview ? "hidden lg:block" : ""} min-w-0 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)]`}>
      {/* 空队列压成一行：它的说明文字对"这里没有活"没有增量，却要在首屏占掉一条工作项的位置。 */}
      <div className={`px-4 py-3 ${queue.items.length > 0 ? "border-b border-[var(--ad-border)]" : ""}`}>
        <div className="flex items-center gap-2">
          <Icon aria-hidden className="h-4 w-4 text-[var(--ad-text-muted)]" />
          <h2 className="text-sm font-semibold">{t(queueName)}</h2>
          {queue.items.length === 0 ? (
            <span className="truncate text-xs text-[var(--ad-text-muted)]">{emptyMessage ?? t("No matching work right now.")}</span>
          ) : null}
          <span className="ml-auto rounded-full bg-black/[0.05] px-2 py-1 text-xs font-semibold tabular-nums">{queue.totalCount}</span>
        </div>
        {queue.items.length > 0 ? <p className="mt-1 text-xs leading-5 text-[var(--ad-text-muted)]">{t(description)}</p> : null}
      </div>
      {selectedItems.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--ad-border)] bg-[var(--ad-surface-subtle)] px-4 py-2" data-testid="today-bulk-actions">
          <span className="text-xs font-semibold">{t("{count} selected", { count: selectedItems.length })}</span>
          <button
            className="inline-flex min-h-9 items-center gap-1 rounded bg-[var(--ad-ink)] px-2 text-xs font-semibold text-white disabled:opacity-40"
            disabled={busy || claimable.length === 0}
            onClick={() => void runBulk("Claimed {count} items", (item) => claimWorkItem(item), claimable)}
            type="button"
          >
            <UserPlus aria-hidden className="h-3.5 w-3.5" />
            {t("Claim")}
          </button>
          <button
            className="inline-flex min-h-9 items-center gap-1 rounded border border-[var(--ad-border)] px-2 text-xs disabled:opacity-40"
            disabled={busy}
            onClick={() => void runBulk("Watching {count} items", (item) => writePreference(item, { watching: true }, item.preferenceVersion))}
            type="button"
          >
            <Eye aria-hidden className="h-3.5 w-3.5" />
            {t("Watch")}
          </button>
          <SnoozeMenu
            busy={busy}
            label={t("Snooze")}
            now={now}
            onSelect={(option) => void runBulk("Snoozed {count} items", (item) => writePreference(item, { snoozedUntil: option.until.toISOString() }, item.preferenceVersion))}
          />
          <button className="ml-auto min-h-9 text-xs text-[var(--ad-text-muted)] underline underline-offset-2" onClick={() => setSelected(new Set())} type="button">
            {t("Clear selection")}
          </button>
        </div>
      ) : null}
      {queue.items.length === 0 ? null : (
        <div className="divide-y divide-[var(--ad-border)] lg:max-h-[calc(100dvh-360px)] lg:overflow-y-auto">
          {groups.map((group) => group.items.length === 1 ? (
            <WorkItem
              {...itemProps}
              item={group.items[0]}
              key={group.key}
              onToggleSelected={actionable ? toggle : undefined}
              selected={selected.has(workItemKey(group.items[0]))}
            />
          ) : (
            <RelatedCreativeRuns
              {...itemProps}
              items={group.items}
              key={group.key}
              onToggleSelected={actionable ? toggle : undefined}
              selected={selected}
            />
          ))}
        </div>
      )}
      {queue.totalCount > queue.items.length ? (
        <p className="border-t border-[var(--ad-border)] px-4 py-2 text-[10px] text-[var(--ad-text-muted)]">
          {t("Showing {shown} of {total}", { shown: queue.items.length, total: queue.totalCount })}
        </p>
      ) : null}
      </div>
      {preview ? <div className={`${mobilePreview ? "" : "hidden lg:block"} min-w-0 scroll-mt-28 outline-none lg:sticky lg:top-4`} ref={previewRef} tabIndex={-1}>
        <button className="mb-3 inline-flex min-h-10 items-center gap-2 text-sm lg:hidden" onClick={() => { setMobilePreview(false); requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('[data-today-preview][aria-pressed="true"]')?.focus()); }} type="button"><ArrowLeft className="h-4 w-4" />{t("Back to work list")}</button>
        <WorkItem {...itemProps} detail item={preview} key={workItemKey(preview)} onToggleSelected={actionable ? toggle : undefined} selected={false} />
      </div> : <div className="hidden min-h-96 items-center justify-center rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-8 text-sm text-[var(--ad-text-muted)] lg:flex">{t("Select a work item to preview its details.")}</div>}
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
      key: creativeKey ? `creative:${creativeKey}:${item.sourceId}` : workItemKey(item),
      items: [item],
      creativeKey,
    });
  }
  return groups;
}

type WorkItemProps = {
  density: WorkDensity;
  detail?: boolean;
  onPreview?: (item: TodayWorkItem) => void;
  previewKey?: string | null;
  item: TodayWorkItem;
  locale: "en" | "zh";
  now: Date;
  onFeedback: FeedbackSink;
  onPreferenceChanged: () => void | Promise<void>;
  onToggleSelected?: (item: TodayWorkItem, checked: boolean) => void;
  selected: boolean;
  watchedQueue: boolean;
};

function RelatedCreativeRuns({
  items,
  selected,
  ...shared
}: Omit<WorkItemProps, "item" | "selected"> & { items: TodayWorkItem[]; selected: ReadonlySet<string> }) {
  const { t } = useAdminI18n();
  const first = items[0];
  const targetId = String(first.impactSnapshot.targetId).replaceAll("_", " ");
  const purpose = todayOperationalText(String(first.impactSnapshot.purpose).replaceAll("_", " "), shared.locale);
  return (
    <div data-testid="today-related-creative-runs">
      <div className="border-b border-[var(--ad-border)] bg-black/[0.02] px-4 py-2">
        <p className="text-xs font-semibold">{t("{count} related Creative Runs", { count: items.length })}</p>
        <p className="mt-0.5 text-[10px] text-[var(--ad-text-muted)]">{targetId} · {purpose}</p>
      </div>
      <WorkItem {...shared} item={first} selected={selected.has(workItemKey(first))} />
      <details className="border-t border-[var(--ad-border)]">
        <summary className="cursor-pointer px-4 py-2 text-xs font-semibold text-[var(--ad-text-muted)]">
          {t("Review {count} more", { count: items.length - 1 })}
        </summary>
        <div className="divide-y divide-[var(--ad-border)] border-t border-[var(--ad-border)] bg-black/[0.015]">
          {items.slice(1).map((item) => (
            <WorkItem {...shared} item={item} key={item.sourceId} selected={selected.has(workItemKey(item))} />
          ))}
        </div>
      </details>
    </div>
  );
}

function WorkItem({ density, detail, onPreview, previewKey, item, locale, now, onFeedback, onPreferenceChanged, onToggleSelected, selected, watchedQueue }: WorkItemProps) {
  const { t } = useAdminI18n();
  const title = todayWorkItemTitle(item, t);
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  async function run(action: () => Promise<ActionFeedback>) {
    setBusy(true);
    setMenuOpen(false);
    try {
      onFeedback(await action());
      await onPreferenceChanged();
    } catch (error) {
      onFeedback(failureFeedback(error));
    } finally {
      setBusy(false);
    }
  }

  const setPreference = (patch: PreferencePatch, message: string) => run(async () => {
    await writePreference(item, patch, item.preferenceVersion);
    return { tone: "success", message };
  });

  const snooze = (until: Date) => run(async () => {
    const preference = await writePreference(item, { snoozedUntil: until.toISOString() }, item.preferenceVersion);
    return {
      tone: "success",
      message: "Snoozed until {time}",
      values: { time: formatTime(until.toISOString(), locale) },
      // 推迟是唯一会让工作项从视线里消失的操作，必须给得回来。
      undo: {
        label: "Undo",
        run: () => run(async () => {
          await writePreference(item, { snoozedUntil: null }, preference.version);
          return { tone: "success", message: "Snooze cleared" };
        }),
      },
    };
  });

  const claim = () => run(async () => {
    await claimWorkItem(item);
    return { tone: "success", message: "Claimed by you" };
  });

  const actions = onToggleSelected ? (
    <div className="flex shrink-0 items-center gap-1">
      {item.claim ? (
        <button
          className="inline-flex min-h-9 items-center gap-1 rounded bg-[var(--ad-ink)] px-2 text-xs font-semibold text-white disabled:opacity-40"
          disabled={busy}
          onClick={() => void claim()}
          type="button"
        >
          <UserPlus aria-hidden className="h-3.5 w-3.5" />
          {t("Claim")}
        </button>
      ) : null}
      <details
        className="relative"
        onToggle={(event) => setMenuOpen(event.currentTarget.open)}
        open={menuOpen}
      >
        <summary aria-label={t("More actions")} className="flex min-h-9 min-w-9 cursor-pointer list-none items-center justify-center rounded border border-[var(--ad-border)] text-[var(--ad-text-muted)]">
          <MoreHorizontal aria-hidden className="h-4 w-4" />
        </summary>
        <div className="absolute right-0 top-full z-20 mt-1 w-56 rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] p-1 shadow-[var(--ad-shadow-hover)]">
          <MenuAction
            disabled={busy}
            icon={Eye}
            label={watchedQueue ? t("Unwatch") : t("Watch")}
            onClick={() => void setPreference({ watching: !watchedQueue }, watchedQueue ? "Removed from Watching" : "Added to Watching")}
          />
          <MenuAction
            disabled={busy}
            icon={Pin}
            label={item.pinned ? t("Unpin") : t("Pin")}
            onClick={() => void setPreference({ pinned: !item.pinned }, item.pinned ? "Unpinned" : "Pinned")}
          />
          {snoozeOptions(now).map((option) => (
            <MenuAction
              disabled={busy}
              icon={Bell}
              key={option.key}
              label={t(option.label)}
              onClick={() => void snooze(option.until)}
            />
          ))}
        </div>
      </details>
    </div>
  ) : null;

  if (detail) {
    const facts = [
      [t("Record ID"), item.sourceId],
      [t("Domain"), t(item.sourceType)],
      [t("Owner"), item.ownerId ?? t("Unassigned")],
      [t("Opened"), formatDateTime(item.openedAt, locale)],
      [t("Last changed"), formatDateTime(item.lastChangedAt, locale)],
      [t("SLA"), item.slaDueAt ? formatDateTime(item.slaDueAt, locale) : t("No deadline")],
      [t("Verification"), t(item.verificationState)],
    ];
    return <article className="flex min-h-[650px] flex-col rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-6 xl:p-8" data-testid="today-preview" aria-label={t("Work preview")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 className="min-w-0 break-words text-xl font-semibold leading-snug text-[var(--ad-ink)]">{title}</h2>
        <SeverityChip severity={item.severity} />
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3 text-sm"><span>{t(item.sourceStatus)}</span><SlaChip item={item} locale={locale} now={now} /></div>
      <p className="mt-5 break-words text-sm leading-6 text-[var(--ad-text-muted)]">{todayOperationalText(item.summary, locale)}</p>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        {onToggleSelected ? <button className="inline-flex min-h-10 items-center gap-2 text-sm disabled:opacity-40" disabled={busy} onClick={() => void setPreference({ watching: !watchedQueue }, watchedQueue ? "Removed from Watching" : "Added to Watching")} type="button"><Eye className="h-4 w-4" />{t(watchedQueue ? "Unwatch" : "Watch")}</button> : null}
        {actions}
      </div>
      <div className="my-6 border-t border-[var(--ad-border)]" />
      <h3 className="text-sm font-semibold">{t("Work details")}</h3>
      <dl className="mt-5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-4 text-sm leading-6">{facts.map(([label, value]) => <div className="contents" key={label}><dt className="text-[var(--ad-text-muted)]">{label}</dt><dd className="break-words [overflow-wrap:anywhere]">{value}</dd></div>)}</dl>
      <div className="mt-auto pt-8">
        <p className="mb-4 text-sm leading-6 text-[var(--ad-text-muted)]">{todayOperationalText(item.recommendedAction, locale)}</p>
        <Link className="flex min-h-12 items-center justify-center gap-2 rounded-md bg-[var(--ad-ink)] px-5 text-sm font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-4" href={item.deepLink}>{t("Open source record")}<ArrowRight className="h-4 w-4" /></Link>
        <p className="mt-3 text-center text-xs text-[var(--ad-text-muted)]">{t("Continue in the original workspace.")}</p>
      </div>
    </article>;
  }

  return <div className={`flex items-start gap-3 px-4 ${density === "compact" ? "py-4" : "py-6"} ${previewKey === workItemKey(item) ? "bg-[var(--ad-red-bg)]/50" : "hover:bg-black/[0.025]"}`}>
    {onToggleSelected ? <input aria-label={t("Select {title}", { title })} checked={selected} className="mt-1 h-4 w-4 shrink-0" onChange={(event) => onToggleSelected(item, event.target.checked)} type="checkbox" /> : null}
    <button data-today-preview aria-pressed={previewKey === workItemKey(item)} aria-label={t("Preview {title}", { title })} className="min-w-0 flex-1 text-left focus-visible:outline-2 focus-visible:outline-offset-4" onClick={() => onPreview?.(item)} type="button">
      <span className="flex items-start gap-2"><SeverityChip severity={item.severity} /><span className="min-w-0 break-words text-sm font-semibold leading-5">{item.pinned ? <Pin aria-hidden className="mr-1 inline h-3 w-3" /> : null}{title}</span></span>
      <span className="mt-3 block truncate text-sm text-[var(--ad-text-muted)]">{todayOperationalText(item.summary, locale)}</span>
      <span className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--ad-text-muted)]"><span className="max-w-full truncate">{item.ownerId ?? t("Unassigned")}{item.sourceType === "ops_incident" ? ` · ${item.sourceId.slice(-8)}` : ""}</span><SlaChip item={item} locale={locale} now={now} /></span>
    </button>
  </div>;
}

function MenuAction({ disabled, icon: Icon, label, onClick }: { disabled: boolean; icon: typeof Eye; label: string; onClick: () => void }) {
  return (
    <button
      className="flex min-h-9 w-full items-center gap-2 rounded px-2 text-left text-xs hover:bg-black/[0.04] disabled:opacity-40"
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      <Icon aria-hidden className="h-3.5 w-3.5 text-[var(--ad-text-muted)]" />
      {label}
    </button>
  );
}

function SnoozeMenu({ busy, label, now, onSelect }: { busy: boolean; label: string; now: Date; onSelect: (option: { until: Date }) => void }) {
  const { t } = useAdminI18n();
  const [open, setOpen] = useState(false);
  return (
    <details className="relative" onToggle={(event) => setOpen(event.currentTarget.open)} open={open}>
      <summary className="flex min-h-9 cursor-pointer list-none items-center gap-1 rounded border border-[var(--ad-border)] px-2 text-xs">
        <Bell aria-hidden className="h-3.5 w-3.5" />
        {label}
      </summary>
      <div className="absolute left-0 top-full z-20 mt-1 w-56 rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] p-1 shadow-[var(--ad-shadow-hover)]">
        {snoozeOptions(now).map((option) => (
          <MenuAction
            disabled={busy}
            icon={Bell}
            key={option.key}
            label={t(option.label)}
            onClick={() => {
              setOpen(false);
              onSelect(option);
            }}
          />
        ))}
      </div>
    </details>
  );
}

function SeverityChip({ severity }: { severity: TodayWorkItem["severity"] }) {
  const { t } = useAdminI18n();
  return (
    <span className={`inline-flex min-w-9 shrink-0 justify-center rounded px-1.5 py-0.5 text-xs font-semibold ${TONE_CLASSES[severityTone(severity)]}`}>
      {t(severity)}
    </span>
  );
}

// SPEC: 超时和"还早"不能长得一样。超时说超了多久，今天到期说今天，其余不占位置。
function SlaChip({ item, locale, now }: { item: TodayWorkItem; locale: "en" | "zh"; now: Date }) {
  const { t } = useAdminI18n();
  const state = slaState(item.slaDueAt, now);
  if (state === "overdue" && item.slaDueAt) {
    return (
      <span className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-semibold text-[var(--ad-red-text)] bg-[var(--ad-red-bg)]">
        {t("SLA due {elapsed}", { elapsed: formatRelativeTime(item.slaDueAt, now.toISOString(), locale) })}
      </span>
    );
  }
  if (state === "due_today") {
    return (
      <span className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-semibold text-[var(--ad-yellow-text)] bg-[var(--ad-yellow-bg)]">
        {t("Due today")}
      </span>
    );
  }
  return null;
}
