import { describe, expect, it } from "vitest";
import {
  ADMIN_LOCALE_COOKIE,
  ADMIN_WORK_MODE_COOKIE,
  readAdminShellPreferences,
} from "./shell-preferences";

function fromCookies(values: Record<string, string>) {
  return readAdminShellPreferences((name) => values[name]);
}

describe("admin shell preferences", () => {
  it("falls back to English with nothing chosen when no cookie is present", () => {
    expect(fromCookies({})).toEqual({
      locale: "en",
      workMode: null,
    });
  });

  it("reads the operator's stored language and work mode", () => {
    expect(fromCookies({
      [ADMIN_LOCALE_COOKIE]: "zh",
      [ADMIN_WORK_MODE_COOKIE]: "platform_ops",
    })).toEqual({
      locale: "zh",
      workMode: "platform_ops",
    });
  });

  it("treats an unreadable preference as never chosen instead of guessing", () => {
    expect(fromCookies({
      [ADMIN_LOCALE_COOKIE]: "de",
      [ADMIN_WORK_MODE_COOKIE]: "root",
    })).toEqual({
      locale: "en",
      workMode: null,
    });
  });
});
