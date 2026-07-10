import { describe, expect, it } from "vitest";
import { hasAdminZh } from "./i18n";

// SPEC: 三件套页面自有文案必须有 zh（运营面不漏英文）。每落一个三件套，扩这张表。
export const OFFICIAL_KEYS = [
  "New official character", "Manage official character profiles and publishing.",
  "Search by name", "reference images", "Create the first official character to get started.",
  "No official characters yet.", "Back to official characters", "AI assist",
  "One-line inspiration — AI fills description and tags.", "Inspiration",
  "Basic info", "Appearance & style", "Description & tags", "Create character",
  "Character not found.", "Edit profile", "Save changes", "Age", "Description",
];
// 注意：枚举/状态词（approved/draft/archived/female/…/realistic/…）不进 zh 表——
// 它们走 value()/zhValues 通道（已覆盖，加进 zh 表反而重复破坏 SSoT）。

export const STARTERS_KEYS = [
  "{count} tags", "AI assist", "All", "Back to starter templates", "Basic info",
  "Cancel", "Category", "Character not found.", "Character Starters", "Create character template",
  "Create the first starter template to get started.", "Description & tags", "Edit profile",
  "Engineering details", "Gender", "Generate with AI", "Inactive", "Inspiration", "Loading…",
  "Manage starter templates for user character creation.", "Name (≥1)", "New starter template",
  "No starter templates yet.", "Offline", "One-line inspiration — AI fills description and tags.",
  "Publish", "Published", "Reason (≥3)", "Request failed", "Save changes", "Scope",
  "Search by name", "Sort order", "Status", "Style", "Summary (≤200)",
  "Tags (comma-separated, ≤12)",
];

export const RECIPES_KEYS = [
  "All", "Back to prompt recipes", "Basic info", "Body", "Cancel",
  "Create Draft", "Create the first prompt recipe to get started.", "Edit profile",
  "Label", "Loading…", "Manage prompt recipes for image generation.", "Mode",
  "Name", "Negative Base", "New prompt recipe", "No prompt recipes yet.",
  "Only draft recipes can be edited.", "Prompt Recipes", "Publish", "Publish recipe",
  "Recipe details", "Recipe ID", "Recipe Key", "Recipe not found.", "Request failed",
  "Rollback", "Rollback recipe", "Save changes", "Search by name", "Status", "Updated",
  "Use Case", "Version",
];
// 注意：状态词 draft/active/archived 走 recipeStateLabelKey → "Ready to publish"/"Published"/
// "Archived"（已有 zh），不进这张表；同理 mode/useCase 枚举值走 value()/zhValues 通道。

export const PRESETS_KEYS = [
  "All", "Archive preset", "Back to presets", "Basic info", "Cancel", "Category",
  "Controls (JSON)", "Create preset", "Create the first preset to get started.",
  "Edit profile", "Label", "Loading…", "Manage built-in generation presets.", "New preset",
  "No built-in presets are seeded yet.", "Preset details", "Preset ID", "Preset not found.",
  "Preset type", "Presets", "Request failed", "Restore", "Save changes", "Search by name",
  "Status", "Type", "Visibility",
];
// 注意：枚举词 background/pose/outfit/mode（type）与 public/private/unlisted（visibility）与
// active/archived（status，StatusPill 缺省走 value()）都走 value()/zhValues 通道，不进这张表。

describe("admin i18n — trio pages have zh", () => {
  it("official characters trio", () => {
    for (const key of OFFICIAL_KEYS) expect(hasAdminZh(key)).toBe(true);
  });

  it("starter templates trio", () => {
    for (const key of STARTERS_KEYS) expect(hasAdminZh(key)).toBe(true);
  });

  it("prompt recipes trio", () => {
    for (const key of RECIPES_KEYS) expect(hasAdminZh(key)).toBe(true);
  });

  it("generation presets trio", () => {
    for (const key of PRESETS_KEYS) expect(hasAdminZh(key)).toBe(true);
  });
});
