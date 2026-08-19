import type { TodayProjection, TodayWorkItem } from "@idream/shared/admin";
import { describe, expect, it } from "vitest";
import { formatCount, queueHealth, severityTone, slaState, snoozeOptions, todayCounts } from "./health";

const now = new Date("2026-08-16T12:00:00.000Z");

const item = (overrides: Partial<TodayWorkItem> = {}): TodayWorkItem => ({
  sourceType: "admin_case",
  sourceId: "case-1",
  sourceStatus: "waiting",
  title: "support request case",
  summary: "customer user-1 is waiting",
  severity: "high",
  priority: "high",
  impactSnapshot: {},
  ownerId: null,
  slaDueAt: null,
  recommendedAction: "Review and advance the case",
  openedAt: "2026-08-01T00:00:00.000Z",
  deepLink: "/admin/cases/case-1",
  verificationState: "pending",
  lastChangedAt: "2026-08-10T00:00:00.000Z",
  environment: "test",
  dataClass: "customer",
  pinned: false,
  preferenceVersion: 0,
  claim: null,
  ...overrides,
});

const queue = (items: TodayWorkItem[], totalCount = items.length) => ({ totalCount, items });

const projection = (overrides: Partial<TodayProjection> = {}): TodayProjection => ({
  myShift: queue([]),
  nextBestActions: queue([]),
  unassigned: queue([]),
  watching: queue([]),
  recentlyResolved: queue([]),
  asOf: now.toISOString(),
  freshness: "fresh",
  workMode: "support",
  rankingPolicyVersion: "today-ranking-v1",
  ...overrides,
});

describe("Today queue health", () => {
  it("splits SLA into overdue, due today, and later on the same UTC day boundary the authority uses", () => {
    expect(slaState(null, now)).toBe("none");
    expect(slaState("2026-08-16T11:59:00.000Z", now)).toBe("overdue");
    expect(slaState("2026-08-16T23:59:59.000Z", now)).toBe("due_today");
    expect(slaState("2026-08-17T00:00:01.000Z", now)).toBe("upcoming");
  });

  it("gives every severity its own tone so critical and low cannot look alike", () => {
    const tones = (["critical", "high", "medium", "low"] as const).map(severityTone);
    expect(new Set(tones).size).toBe(4);
  });

  it("counts each overdue item once across queues and marks the count as a floor", () => {
    const overdue = item({ sourceId: "case-2", slaDueAt: "2026-07-20T00:00:00.000Z" });
    const counts = todayCounts(projection({
      myShift: queue([overdue], 1),
      nextBestActions: queue([overdue, item({ sourceId: "case-3" })], 18),
      unassigned: queue([], 4),
      recentlyResolved: queue([], 6),
    }), null, now);

    expect(counts).toMatchObject({ pending: 18, overdue: 1, overdueExact: false, unassigned: 4, resolved24h: 6 });
    expect(formatCount(counts.overdue, counts.overdueExact)).toBe("≥1");
  });

  it("prefers the authoritative overdue total over the visible floor", () => {
    const counts = todayCounts(projection({ nextBestActions: queue([], 18) }), 8, now);

    expect(counts).toMatchObject({ overdue: 8, overdueExact: true });
    expect(formatCount(counts.overdue, counts.overdueExact)).toBe("8");
  });

  it("never reports an all-clear while work is overdue or unowned", () => {
    const overdue = queueHealth(todayCounts(projection({ nextBestActions: queue([], 18) }), 3, now));
    const unowned = queueHealth(todayCounts(projection({ nextBestActions: queue([], 18), unassigned: queue([], 4) }), 0, now));
    const queued = queueHealth(todayCounts(projection({ nextBestActions: queue([], 18) }), 0, now));
    const clear = queueHealth(todayCounts(projection(), 0, now));

    expect(overdue).toMatchObject({ tone: "critical", focus: "overdue" });
    expect(unowned).toMatchObject({ tone: "warning", focus: "unassigned" });
    expect(queued).toMatchObject({ tone: "calm", focus: null });
    expect(clear.headline).toBe("Nothing is waiting for you right now.");
  });
});

describe("Today snooze options", () => {
  it("offers end of day, tomorrow, and next week in ascending order", () => {
    const wednesday = new Date(2026, 7, 12, 9, 0, 0);
    const options = snoozeOptions(wednesday);

    expect(options.map((option) => option.key)).toEqual(["hour", "end_of_day", "tomorrow", "next_week"]);
    const times = options.map((option) => option.until.getTime());
    expect([...times].sort((left, right) => left - right)).toEqual(times);
  });

  it("drops choices that already passed and never offers the same instant twice", () => {
    const sundayEvening = new Date(2026, 7, 16, 20, 0, 0);
    const options = snoozeOptions(sundayEvening);

    // 晚上八点没有"今天下班"；周日的"明早"就是"下周一"，只留一个。
    expect(options.map((option) => option.key)).toEqual(["hour", "tomorrow"]);
    expect(options.every((option) => option.until > sundayEvening)).toBe(true);
  });
});
