import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  displayValue,
  formatDate,
  formatDateTime,
  formatMoney,
  formatRelativeTime,
  formatTime,
  text,
} from "./format";

const labels = { yes: "yes", no: "no" };
const moment = "2026-08-16T09:30:00.000Z";

describe("text", () => {
  it("keeps strings and swallows everything else", () => {
    expect(text("abc")).toBe("abc");
    expect(text(7)).toBe("");
    expect(text(null)).toBe("");
    expect(text({ a: 1 })).toBe("");
  });
});

describe("displayValue", () => {
  it("shows a dash for the three shapes of missing", () => {
    for (const missing of [null, undefined, ""]) {
      expect(displayValue(missing, labels)).toBe("—");
    }
  });

  it("says yes and no rather than true and false", () => {
    expect(displayValue(true, labels)).toBe("yes");
    expect(displayValue(false, labels)).toBe("no");
  });

  // SPEC: 对象也要能看见 —— 复制版本里最差的一种直接把它显示成 "—"，等于把数据藏了。
  it("folds an object into readable JSON instead of hiding it", () => {
    const html = renderToStaticMarkup(<>{displayValue({ reason: "duplicate" }, labels)}</>);
    expect(html).toContain("{&quot;reason&quot;:&quot;duplicate&quot;}");
    expect(html).toContain("truncate");
  });

  it("passes scalars straight through", () => {
    expect(displayValue(0, labels)).toBe("0");
    expect(displayValue("queued", labels)).toBe("queued");
  });
});

describe("date formatting", () => {
  // SPEC: 每个时间函数都跟随后台的 locale，不跟浏览器 locale。
  // INTENT: 复制版本里有 18 处裸 toLocaleString / toLocaleTimeString —— 中文界面显示英文日期。
  it("follows the admin locale rather than the browser's", () => {
    expect(formatDate(moment, "zh")).toContain("2026");
    expect(formatDate(moment, "zh")).not.toMatch(/Aug/);
    expect(formatDateTime(moment, "en")).toMatch(/Aug/);
  });

  it("distinguishes day, day+time, and time-of-day", () => {
    expect(formatDate(moment, "en")).not.toMatch(/\d:\d\d/);
    expect(formatDateTime(moment, "en")).toMatch(/\d:\d\d/);
    expect(formatTime(moment, "en")).not.toMatch(/Aug/);
  });

  it("returns a dash for missing and unparseable values", () => {
    for (const bad of [null, undefined, "", "not a date"]) {
      expect(formatDateTime(bad, "en")).toBe("—");
    }
  });
});

describe("formatRelativeTime", () => {
  // SPEC: 取最大的整数单位，只给一位 —— 队列里唯一在变的量是积压了多久。
  it("picks the largest whole unit", () => {
    expect(formatRelativeTime("2026-08-19T09:30:00.000Z", moment, "en")).toBe("in 3 days");
    expect(formatRelativeTime("2026-08-16T05:30:00.000Z", moment, "en")).toBe("4 hours ago");
    expect(formatRelativeTime("2026-08-16T09:20:00.000Z", moment, "en")).toBe("10 minutes ago");
  });

  it("does not round a 90-minute gap up to two hours", () => {
    expect(formatRelativeTime("2026-08-16T11:00:00.000Z", moment, "en")).toBe("in 1 hour");
  });

  it("returns a dash when either end is missing", () => {
    expect(formatRelativeTime(null, moment, "en")).toBe("—");
    expect(formatRelativeTime(moment, "", "en")).toBe("—");
  });
});

describe("formatMoney", () => {
  it("renders cents as the currency", () => {
    expect(formatMoney(1999, "USD", "en")).toBe("$19.99");
  });

  // 后端偶尔给出非 ISO 的币种码；宁可显示原始数值也不要整行崩掉。
  it("falls back to the raw amount for an unknown currency code", () => {
    expect(formatMoney(1999, "not-a-currency", "en")).toBe("1999 not-a-currency");
  });
});
