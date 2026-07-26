import { describe, expect, it } from "vitest";
import { hasAdminZh } from "./i18n";

// SPEC: 三件套页面自有文案必须有 zh（运营面不漏英文）。每落一个三件套，扩这张表。
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

export const ASSETS_KEYS = [
  "{count} assets archived. The selection was cleared.",
  "{count} selected", "{count} selected assets have active authority dependencies.",
  "All", "Already archived", "Approve", "Archive", "Archive only after every active usage has been replaced or withdrawn.",
  "Archive blocked by a newer authority dependency. No selected asset was changed.",
  "Archive selected", "Archive selected assets", "Asset details", "Asset not found.",
  "Assets have no name — type the first 8 characters of the ID to confirm.",
  "Back to image library", "Basic info", "Batch", "Browse and curate generated image assets.",
  "Bulk archive", "Bulk archive is atomic. If one asset is still in use, none of the selected assets will change.",
  "Checking dependencies…", "Clear selection", "Could not check selected asset dependencies.",
  "Description", "Description & tags", "Generation job", "Image Library", "Loading…",
  "Media asset", "Missing", "Missing asset", "Missing selected assets: {ids}", "Next page",
  "No platform assets match these filters.", "Paste exact asset IDs to confirm",
  "Paste these exact asset IDs to confirm",
  "Preflight checked {count} assets. No active authority dependencies were found.",
  "Profile", "Purpose", "Reject", "Repair each usage before archiving. No selected asset was changed.",
  "Request failed", "Save", "Search by tag, description, or asset ID", "Select", "Select asset {id}",
  "Select page", "Selected", "Size", "Source", "Status", "Tags",
  "Tags and descriptions make assets searchable for chat reuse.", "Target ID", "Target type",
];
// 注意：状态词 generated/approved/rejected/published/archived（status）、targetType 枚举
// （character/route_page/campaign/template/none）与 productionPurposeSchema 枚举
// （character_cover/…/model_eval）都走 value()/zhValues 通道，不进这张表。

export const PLACEMENTS_KEYS = [
  "All", "Archive", "Asset", "Back to placements", "Basic info", "Create placement",
  "Create the first placement to get started.", "Loading…",
  "Manage where approved images are surfaced across the platform.", "Media asset",
  "New placement", "No placements yet.", "Pause", "Placement details", "Placement ID",
  "Placement not found.", "Placements", "Publish", "Published", "Reason (≥3)",
  "Request failed", "Search by slot, target, or asset ID", "Slot", "Status",
  "Target ID", "Target type", "Target",
];
// 注意：状态词 draft/scheduled/published/paused/archived（status）、slot 枚举
// （character_avatar/character_hero/feed_card/homepage_strip/seo_article/template_cover/campaign）
// 与 targetType 枚举（character/template/route_page/campaign）都走 value()/zhValues 通道，不进这张表。

export const CREATIVE_WORKFLOW_KEYS = [
  "Image creation",
  "Create images",
  "Creating Character images?",
  "Open Character Asset Studio",
  "What are you making?",
  "Creative brief",
  "Advanced creation details",
  "Image route",
  "Canvas",
  "Create and launch",
  "Review against the brief",
  "Intended use",
  "Reference images",
  "Campaign destination key",
  "Stage campaign candidate",
  "Verify & activate",
  "First identity portrait",
  "Character asset pack",
  "Establish the face customers will recognize",
  "Create the images customers will remember",
  "Record the visible review evidence",
  "Required visible quality checks",
  "Identity consistency",
  "Evidence and reason",
  "Record superseding approval",
  "Record superseding rejection",
  "Terminal disposition",
  "Withdraw approval",
  "Recent runs and technical lineage",
  "Generation profile",
  "Provider request / Comfy prompt",
  "Immutable review decision",
];

export const TAGS_KEYS = [
  "Cancel", "Category (blank=none)", "category", "characters", "Edit", "label", "Label",
  "Manage the tag vocabulary for characters.", "Merge tags", "Merge",
  "Merged — moved {count} character link(s).",
  "Move every character from the source tag to the target tag, then delete the source tag.",
  "Moves every character from {source} to {target}, then deletes {source}.",
  "muted", "No tags.", "no", "Refresh", "Save changes", "sensitive", "slug",
  "Source and target must differ.", "Source tag", "Source tag…", "Tag taxonomy", "Tags",
  "Target tag", "Target tag…", "yes",
];

// SPEC: ui/ 共享原语（ConfirmDialog/AssetImage 等）自有文案的锁（task 18 评审 follow-up）。
// 这些 key 被多个三件套详情页复用（如 ConfirmDialog 的破坏性确认流程），任何一条从 zh 表
// 消失都会同时在所有 trio 页面漏英文——单独锁一份，不依赖各页面 KEYS 数组恰好也列了它。
export const UI_KEYS = [
  "Cancel", "Missing", "Missing asset", "Reason (≥3)", "Request failed",
  "Type the name to confirm",
];

describe("admin i18n — trio pages have zh", () => {
  it("creative and Character image workflow", () => {
    for (const key of CREATIVE_WORKFLOW_KEYS) expect(hasAdminZh(key)).toBe(true);
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

  it("image library grid + detail", () => {
    for (const key of ASSETS_KEYS) expect(hasAdminZh(key)).toBe(true);
  });

  it("placements trio", () => {
    for (const key of PLACEMENTS_KEYS) expect(hasAdminZh(key)).toBe(true);
  });

  it("tags page", () => {
    for (const key of TAGS_KEYS) expect(hasAdminZh(key)).toBe(true);
  });

  it("shared ui primitives", () => {
    for (const key of UI_KEYS) expect(hasAdminZh(key)).toBe(true);
  });
});
