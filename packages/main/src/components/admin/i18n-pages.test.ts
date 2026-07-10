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

describe("admin i18n — trio pages have zh", () => {
  it("official characters trio", () => {
    for (const key of OFFICIAL_KEYS) expect(hasAdminZh(key)).toBe(true);
  });

  it("starter templates trio", () => {
    for (const key of STARTERS_KEYS) expect(hasAdminZh(key)).toBe(true);
  });
});
