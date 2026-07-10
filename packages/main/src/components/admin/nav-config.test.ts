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
    expect(NAV_GROUP_ORDER[0]).toBe("Daily");
  });
});

import { configSliceForSection } from "./nav-config";

// Frozen snapshot of the pre-redesign section ids — none may be lost.
const ORIGINAL_IDS = [
  "dashboard", "generation/jobs", "generation/config", "generation/dead-letter",
  "ops/providers", "generation/backends", "generation/workflows", "generation/metrics",
  "content/production", "content/assets", "content/placements", "content",
  "content/official", "content/templates", "content/tags", "content/review-queue",
  "cms", "moderation", "chat", "support", "users", "billing", "pricing", "promo",
  "announcements", "analytics", "insights", "experiments", "risk", "compliance",
  "approvals", "audit-log",
];

function idsInGroup(group: string) {
  return navItems.filter((item) => item.group === group).map((item) => item.id);
}

describe("nav-config (redesigned IA)", () => {
  it("keeps every original screen (nothing lost in migration)", () => {
    const ids = new Set(navItems.map((item) => item.id));
    for (const id of ORIGINAL_IDS) expect(ids.has(id)).toBe(true);
  });

  it("orders groups as Daily followed by the 7 folded groups (guided nav re-tier)", () => {
    expect(NAV_GROUP_ORDER).toEqual([
      "Daily", "CharacterConfig", "Operations", "Media", "Business", "Insights", "GenerationOps", "Engineering", "System",
    ]);
  });

  it("puts each concept in exactly one declared home", () => {
    expect(idsInGroup("CharacterConfig")).toEqual([
      "content/templates", "content/tags",
    ]);
    expect(idsInGroup("Operations")).toEqual(["generation/config", "generation/recipes", "generation/presets"]);
    expect(idsInGroup("GenerationOps")).toEqual([
      "generation/jobs", "generation/dead-letter", "generation/backends", "ops/providers",
    ]);
    expect(idsInGroup("Engineering")).toEqual(["generation/workflows", "generation/metrics"]);
    expect(idsInGroup("Media")).toEqual([
      "content/assets", "content/placements", "cms",
    ]);
  });

  it("uses distinct icons within each pipeline group", () => {
    for (const group of ["CharacterConfig", "Operations", "Media"]) {
      const icons = navItems.filter((i) => i.group === group).map((i) => i.icon);
      expect(new Set(icons).size).toBe(icons.length);
    }
  });

  it("maps generation config sections to slices", () => {
    expect(configSliceForSection("generation/config")).toBe("profiles");
    expect(configSliceForSection("generation/recipes")).toBe("recipes");
    expect(configSliceForSection("generation/presets")).toBe("presets");
    expect(configSliceForSection("content/tags")).toBeNull();
  });
});

import { NAV_DAILY, NAV_FOLDED_GROUPS } from "./nav-config";

describe("nav-config tiers (guided nav)", () => {
  it("pins exactly the 7 daily items in order", () => {
    expect(NAV_DAILY.map((i) => i.id)).toEqual([
      "dashboard", "content/review-queue", "moderation",
      "content/official", "content/production", "content", "support",
    ]);
  });
  it("every daily item has tier daily; every folded item has tier folded", () => {
    for (const i of NAV_DAILY) expect(i.tier).toBe("daily");
    for (const g of NAV_FOLDED_GROUPS) for (const i of g.items) expect(i.tier).toBe("folded");
  });
  it("loses nothing — daily + folded covers all 34 nav ids exactly once", () => {
    const ids = [...NAV_DAILY, ...NAV_FOLDED_GROUPS.flatMap((g) => g.items)].map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(navItems.length);
    expect(new Set(ids)).toEqual(new Set(navItems.map((i) => i.id)));
  });
  it("orders folded groups with Engineering + System last", () => {
    const names = NAV_FOLDED_GROUPS.map((g) => g.group);
    expect(names).toEqual([
      "CharacterConfig", "Operations", "Media", "Business", "Insights", "GenerationOps", "Engineering", "System",
    ]);
  });
});
