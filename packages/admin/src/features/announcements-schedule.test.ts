import { describe, expect, it } from "vitest";
import { announcementWindowOrdered, localInputToIso } from "./announcements-schedule";

describe("announcement schedule inputs", () => {
  // INVARIANT: datetime-local 是本地墙上时间。把它当成 UTC 会整体偏移一个时区，
  //            而这条链路不报错——公告只会在错误的时刻出现或消失。
  it("reads a datetime-local value as local wall time, not UTC", () => {
    const iso = localInputToIso("2026-09-20T09:00");
    expect(iso).not.toBeNull();
    expect(new Date(iso!).getTime()).toBe(new Date(2026, 8, 20, 9, 0).getTime());
  });

  it("treats an empty or unparsable value as no bound", () => {
    expect(localInputToIso("")).toBeNull();
    expect(localInputToIso("   ")).toBeNull();
    expect(localInputToIso("not a date")).toBeNull();
  });

  // 权威只做两个独立比较，不校验先后；反向窗口存得下来却永远不会展示。
  it("rejects a window whose end precedes its start", () => {
    expect(announcementWindowOrdered("2026-09-20T09:00", "2026-09-19T09:00")).toBe(false);
    expect(announcementWindowOrdered("2026-09-20T09:00", "2026-09-20T09:00")).toBe(false);
    expect(announcementWindowOrdered("2026-09-20T09:00", "2026-09-21T09:00")).toBe(true);
  });

  it("accepts a one-sided window and no window at all", () => {
    expect(announcementWindowOrdered("2026-09-20T09:00", "")).toBe(true);
    expect(announcementWindowOrdered("", "2026-09-20T09:00")).toBe(true);
    expect(announcementWindowOrdered("", "")).toBe(true);
  });
});
