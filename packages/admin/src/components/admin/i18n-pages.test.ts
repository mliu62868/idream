import { describe, expect, it } from "vitest";
import { hasAdminZh } from "./i18n";

// SPEC: 三件套页面自有文案必须有 zh（运营面不漏英文）。每落一个三件套，扩这张表。
// 注意：本数组由 task 18 中文覆盖终检机器扫全量重生成（原列表只覆盖 T11 落地时的一部分，
// OfficialDetailPage 后续新增的 Stats/Image production 联动块从未补进来过）。
export const OFFICIAL_KEYS = [
  "Age", "AI assist", "All", "Appearance & style", "Back to official characters", "Basic info",
  "Cancel", "Character not found.", "Chats", "Create character",
  "Create the first official character to get started.", "Created", "Description",
  "Description & tags", "Edit profile", "Engineering details", "Gender", "Generate with AI",
  "Image production", "Inspiration", "Likes", "Loading…",
  "Manage official character profiles and publishing.", "Name", "Name (≥1)",
  "New official character", "No official characters yet.", "Official Characters",
  "One-line inspiration — AI fills description and tags.", "Open image production", "Profile",
  "Publish", "Publish character", "Reason (≥3)", "reference images", "Request failed",
  "Save changes", "Search by name", "Stats", "Status", "Style", "Tags (comma-sep)",
  "Tags (comma-separated, ≤12)", "Unpublish", "Unpublish character", "Views", "Visibility",
];
// 注意：枚举/状态词（approved/draft/archived/female/…/realistic/…）不进 zh 表——
// 它们走 value()/zhValues 通道（已覆盖，加进 zh 表反而重复破坏 SSoT）。

// SPEC: VisualPassportPanel 挂载于 OfficialDetailPage，独立组件自有一套文案，机器扫单独列出
// （task 18）。trait block 标签 Face/Hair/Body/Signature 特意加了 "traits" 后缀，避免与其他页面
// 已有的同名 key（如 recipes/announcements 的 "Body" = 正文）语义碰撞——同一 zh 表是全局 key→value
// 映射，裸词复用会导致这个面板显示错语境的翻译。
export const VISUAL_PASSPORT_KEYS = [
  "Active version traits (read-only)", "Body traits", "Created at", "Created from",
  "Default seed", "Derived from traits", "Face traits", "Hair traits", "Hand-authored",
  "Identity prompt (leave blank to derive from traits)", "Loading…", "Mint new version",
  "Negative identity prompt",
  "No visual profile versions yet — minting below creates version 1.",
  "Reason (≥3, for audit)", "Refresh", "Signature traits",
  "Stale — traits changed since this was derived", "Status", "Style traits",
  "Type {token} to confirm", "Version", "Version history",
  "Version history and identity prompt editing for this character's visual profile.",
  "Visual Identity", "Visual profile confirmation",
];
// 注意：identitySource/style 等枚举词走 value()/zhValues 通道，不进这张表。

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
  "All", "Approve", "Archive", "Asset details", "Asset not found.", "Assets have no name — type the first 8 characters of the ID to confirm.",
  "Back to image library", "Basic info", "Batch", "Browse and curate generated image assets.",
  "Description", "Description & tags", "Generation job", "Image Library", "Loading…",
  "Media asset", "Missing", "Missing asset", "No platform assets match these filters.",
  "Profile", "Purpose", "Reject", "Request failed", "Save", "Search by tag, description, or asset ID",
  "Size", "Source", "Status", "Tags", "Tags and descriptions make assets searchable for chat reuse.",
  "Target ID", "Target type",
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
  it("official characters trio", () => {
    for (const key of OFFICIAL_KEYS) expect(hasAdminZh(key)).toBe(true);
  });

  it("visual passport panel (embedded in official detail)", () => {
    for (const key of VISUAL_PASSPORT_KEYS) expect(hasAdminZh(key)).toBe(true);
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
