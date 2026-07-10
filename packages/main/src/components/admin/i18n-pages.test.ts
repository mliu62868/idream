import { describe, expect, it } from "vitest";
import { hasAdminZh } from "./i18n";

// SPEC: 三件套页面自有文案必须有 zh（运营面不漏英文）。每落一个三件套，扩这张表。
export const OFFICIAL_KEYS = [
  "New official character", "Manage official character profiles and publishing.",
  "Search by name", "reference images", "Create the first official character to get started.",
  "No official characters yet.", "Back to official characters", "AI assist",
  "One-line inspiration — AI fills description and tags.", "Inspiration",
  "Basic info", "Appearance & style", "Description & tags", "Create character",
  "Character not found.", "Edit profile", "Save changes",
];
// 注意：枚举/状态词（approved/draft/archived/female/…/realistic/…）不进 zh 表——
// 它们走 value()/zhValues 通道（已覆盖，加进 zh 表反而重复破坏 SSoT）。

describe("admin i18n — trio pages have zh", () => {
  it("official characters trio", () => {
    for (const key of OFFICIAL_KEYS) expect(hasAdminZh(key)).toBe(true);
  });
});
