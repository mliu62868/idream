import { describe, expect, it } from "vitest";
import { hasAdminZh } from "./i18n";
import { navItems, NAV_GROUP_ORDER } from "./nav-config";

// Keys this redesign introduced or renamed — each must have a zh translation.
const OWNED_KEYS = [
  "Characters", "Generation", "Media", // group headers
  "Character Starters", "Character Review", "Model Profiles", "Prompt Recipes",
  "Presets", "Image Production", "Image Library", "Featured",
  "Batch production", "Generate for character", "Character",
  "Visual Identity",
];

describe("admin i18n — redesigned nav has zh", () => {
  it("translates every key this refactor owns", () => {
    for (const key of OWNED_KEYS) expect(hasAdminZh(key)).toBe(true);
  });

  it("translates all three pipeline group headers", () => {
    for (const group of NAV_GROUP_ORDER.filter((g) =>
      ["Characters", "Generation", "Media"].includes(g),
    )) {
      expect(hasAdminZh(group)).toBe(true);
    }
  });

  it("translates the labels of every Characters/Generation/Media nav item", () => {
    const owned = navItems.filter((i) => ["Characters", "Generation", "Media"].includes(i.group));
    for (const item of owned) expect(hasAdminZh(item.label)).toBe(true);
  });
});
