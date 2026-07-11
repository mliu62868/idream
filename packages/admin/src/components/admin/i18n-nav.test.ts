import { describe, expect, it } from "vitest";
import { hasAdminZh } from "./i18n";
import { NAV_DAILY, NAV_FOLDED_GROUPS } from "./nav-config";

// Keys this redesign introduced that aren't derived from nav-config (in-page
// tab/section labels, not sidebar nav items) — each must still have a zh translation.
const OWNED_KEYS = ["Batch production", "Generate for character", "Character", "Visual Identity"];

describe("admin i18n — redesigned nav has zh", () => {
  it("translates every key this refactor owns", () => {
    for (const key of OWNED_KEYS) expect(hasAdminZh(key)).toBe(true);
  });
});

// SPEC: guided nav (task 1: nav-config tiers; task 2: sidebar render) pins 7 daily
// items and folds the remaining 27 behind 7 group headers. Every label and every
// group header actually rendered in the sidebar must have a real zh translation —
// not a silent fallback to English. Replaces the pre-task-2 assertions, which
// filtered nav items by the retired flat group names ["Characters","Generation","Media"]
// and had gone vacuous (only "Media" still exists as a group name).
describe("admin i18n — guided nav (daily + folded groups) has zh", () => {
  it("translates the pinned daily section header", () => {
    expect(hasAdminZh("Daily")).toBe(true);
  });

  it("translates every daily item's label", () => {
    expect(NAV_DAILY.length).toBeGreaterThan(0);
    for (const item of NAV_DAILY) expect(hasAdminZh(item.label)).toBe(true);
  });

  it("translates every folded group's header", () => {
    expect(NAV_FOLDED_GROUPS.length).toBeGreaterThan(0);
    for (const { group } of NAV_FOLDED_GROUPS) expect(hasAdminZh(group)).toBe(true);
  });

  it("translates every folded item's label", () => {
    for (const { items } of NAV_FOLDED_GROUPS) {
      for (const item of items) expect(hasAdminZh(item.label)).toBe(true);
    }
  });
});
