import { describe, expect, it } from "vitest";
import { navItems, normalizeSection, NAV_GROUP_ORDER } from "./nav-config";

describe("nav-config (baseline SSoT)", () => {
  it("has unique section ids", () => {
    const ids = navItems.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every href matches /admin/<id> (dashboard = /admin)", () => {
    for (const item of navItems) {
      const expected = item.id === "dashboard" ? "/admin" : `/admin/${item.id}`;
      expect(item.href).toBe(expected);
    }
  });

  it("normalizeSection returns each known id unchanged", () => {
    for (const item of navItems) {
      expect(normalizeSection(item.id)).toBe(item.id);
    }
  });

  it("normalizeSection aliases generation/models to generation/config", () => {
    expect(normalizeSection("generation/models")).toBe("generation/config");
  });

  it("normalizeSection falls back to dashboard for unknown ids", () => {
    expect(normalizeSection("nope/nope")).toBe("dashboard");
  });

  it("NAV_GROUP_ORDER lists each group once, in first-seen order", () => {
    expect(new Set(NAV_GROUP_ORDER).size).toBe(NAV_GROUP_ORDER.length);
    expect(NAV_GROUP_ORDER[0]).toBe("Overview");
  });
});
