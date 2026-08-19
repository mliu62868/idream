import { describe, expect, it } from "vitest";
import {
  ADMIN_LOCALE_COOKIE,
  ADMIN_NAV_GROUPS_COOKIE,
  ADMIN_WORK_MODE_COOKIE,
  readAdminShellPreferences,
  serializeOpenNavGroups,
} from "./shell-preferences";

function fromCookies(values: Record<string, string>) {
  return readAdminShellPreferences((name) => values[name]);
}

describe("admin shell preferences", () => {
  it("falls back to English with nothing chosen when no cookie is present", () => {
    expect(fromCookies({})).toEqual({
      locale: "en",
      workMode: null,
      openNavGroups: null,
    });
  });

  it("reads the operator's stored language, work mode, and expanded groups", () => {
    expect(fromCookies({
      [ADMIN_LOCALE_COOKIE]: "zh",
      [ADMIN_WORK_MODE_COOKIE]: "platform_ops",
      [ADMIN_NAV_GROUPS_COOKIE]: encodeURIComponent(
        serializeOpenNavGroups(["Character Studio", "Growth"]),
      ),
    })).toEqual({
      locale: "zh",
      workMode: "platform_ops",
      openNavGroups: ["Character Studio", "Growth"],
    });
  });

  // SPEC: 分组名带空格，cookie 值必须 percent-encode；两端都不做编码时也要能读回来。
  it("reads an unencoded group list rather than dropping it", () => {
    expect(fromCookies({
      [ADMIN_NAV_GROUPS_COOKIE]: '["Growth"]',
    }).openNavGroups).toEqual(["Growth"]);
  });

  // SPEC: "全都折上了" 和 "从来没选过" 是两件事——前者如实全折，后者用冷启动默认集合。
  it("separates an explicitly emptied group list from an absent one", () => {
    expect(fromCookies({ [ADMIN_NAV_GROUPS_COOKIE]: encodeURIComponent("[]") }).openNavGroups)
      .toEqual([]);
    expect(fromCookies({}).openNavGroups).toBeNull();
  });

  it("treats an unreadable preference as never chosen instead of guessing", () => {
    expect(fromCookies({
      [ADMIN_LOCALE_COOKIE]: "de",
      [ADMIN_WORK_MODE_COOKIE]: "root",
      [ADMIN_NAV_GROUPS_COOKIE]: "not-json",
    })).toEqual({
      locale: "en",
      workMode: null,
      openNavGroups: null,
    });
    expect(fromCookies({ [ADMIN_NAV_GROUPS_COOKIE]: encodeURIComponent('{"a":1}') }).openNavGroups)
      .toBeNull();
    expect(fromCookies({ [ADMIN_NAV_GROUPS_COOKIE]: encodeURIComponent('["Growth",7]') }).openNavGroups)
      .toEqual(["Growth"]);
  });
});
