import type { TodayProjection, TodayWorkItem } from "@idream/shared/admin";

export type SlaState = "overdue" | "due_today" | "upcoming" | "none";

// INVARIANT: 与服务端 all-work 的 sla 过滤同口径（UTC 日界），否则 KPI 点进去的列表
// 会和数字对不上。
export function slaState(slaDueAt: string | null, now: Date): SlaState {
  if (!slaDueAt) return "none";
  const dueAt = new Date(slaDueAt).getTime();
  if (dueAt < now.getTime()) return "overdue";
  const endOfToday = new Date(now);
  endOfToday.setUTCHours(23, 59, 59, 999);
  return dueAt <= endOfToday.getTime() ? "due_today" : "upcoming";
}

export type WorkTone = "danger" | "warning" | "info" | "neutral";

// SPEC: 严重度必须一眼可分 —— 它是这一页的第一排序依据。
export function severityTone(severity: TodayWorkItem["severity"]): WorkTone {
  if (severity === "critical") return "danger";
  if (severity === "high") return "warning";
  if (severity === "medium") return "info";
  return "neutral";
}

export type TodayCounts = {
  pending: number;
  overdue: number;
  /** false 表示 overdue 只是可见队列里数出来的下限（每个队列服务端只发前十条）。 */
  overdueExact: boolean;
  unassigned: number;
  mine: number;
  resolved24h: number;
};

/**
 * SPEC: 首屏五个数字。
 * INTENT: 除 overdue 外都取投影自带的精确 totalCount —— 不为一个数字多打一次接口。
 *         overdue 是唯一算不出来的：每个队列只发前十条，第 11 条起是否超时前端无从得知，
 *         所以由 all-work?sla=overdue 的 totalCount 补齐，没到之前先用可见下限。
 */
export function todayCounts(projection: TodayProjection, overdueTotal: number | null, now: Date): TodayCounts {
  return {
    pending: projection.nextBestActions.totalCount,
    overdue: overdueTotal ?? visibleOverdueCount(projection, now),
    overdueExact: overdueTotal !== null,
    unassigned: projection.unassigned.totalCount,
    mine: projection.myShift.totalCount,
    resolved24h: projection.recentlyResolved.totalCount,
  };
}

function visibleOverdueCount(projection: TodayProjection, now: Date) {
  const seen = new Set<string>();
  for (const queue of [projection.myShift, projection.nextBestActions, projection.unassigned, projection.watching]) {
    for (const item of queue.items) {
      if (slaState(item.slaDueAt, now) === "overdue") seen.add(`${item.sourceType}:${item.sourceId}`);
    }
  }
  return seen.size;
}

export function formatCount(value: number, exact: boolean) {
  return exact ? String(value) : `≥${value}`;
}

export type QueueHealth = {
  tone: "critical" | "warning" | "calm";
  headline: string;
  values: Record<string, string | number>;
  /** 横幅上那一个动作按钮指向的筛选；null = 现在没有需要成批处理的东西。 */
  focus: "overdue" | "unassigned" | null;
};

/**
 * SPEC: 横幅说的是队列健康，由数字算出来。
 * INTENT: 这里原本是一条恒绿、写死"Today's queue is up to date"的横幅 —— 下面躺着
 *         十八条 critical、最久的超期三周，运营第一眼收到的信号却是"没事"。
 */
export function queueHealth(counts: TodayCounts): QueueHealth {
  if (counts.overdue > 0) {
    return {
      tone: "critical",
      headline: "{count} items are past their SLA",
      values: { count: formatCount(counts.overdue, counts.overdueExact) },
      focus: "overdue",
    };
  }
  if (counts.unassigned > 0) {
    return { tone: "warning", headline: "{count} items have no owner", values: { count: counts.unassigned }, focus: "unassigned" };
  }
  if (counts.pending > 0) {
    return { tone: "calm", headline: "Nothing overdue. {count} items are queued.", values: { count: counts.pending }, focus: null };
  }
  return { tone: "calm", headline: "Nothing is waiting for you right now.", values: {}, focus: null };
}

/** 服务端已经排好序了：我的班次第一条，没有就是全局第一条。 */
export function focusWorkItem(projection: TodayProjection): TodayWorkItem | null {
  return projection.myShift.items[0] ?? projection.nextBestActions.items[0] ?? null;
}

export type SnoozeOption = { key: string; label: string; until: Date };

/**
 * SPEC: 推迟到运营真正会回来看的时刻，而不是机械的一小时。
 * INTENT: 时刻按本地时区算 —— "下班"和"明早"说的是人的作息，不是 UTC 日界。
 */
export function snoozeOptions(now: Date): SnoozeOption[] {
  const at = (dayOffset: number, hour: number) => {
    const date = new Date(now);
    date.setDate(date.getDate() + dayOffset);
    date.setHours(hour, 0, 0, 0);
    return date;
  };
  const nextMonday = () => {
    const days = ((8 - now.getDay()) % 7) || 7;
    return at(days, 9);
  };
  const options: SnoozeOption[] = [
    { key: "hour", label: "Snooze for an hour", until: new Date(now.getTime() + 3_600_000) },
    { key: "end_of_day", label: "Snooze until end of day", until: at(0, 18) },
    { key: "tomorrow", label: "Snooze until tomorrow morning", until: at(1, 9) },
    { key: "next_week", label: "Snooze until next week", until: nextMonday() },
  ];
  // 已经过去的档位不给点 —— 晚上八点还提供"推迟到今天下班"就是立刻回到队列。
  // 周日的"明早"和"下周一"是同一刻，同一个时间点只留一个档。
  const seen = new Set<number>();
  return options.filter((option) => {
    if (option.until.getTime() <= now.getTime() + 60_000 || seen.has(option.until.getTime())) return false;
    seen.add(option.until.getTime());
    return true;
  });
}
