// SPEC: 后台 URL → section id + 子视图 的纯解析层。不 import React、不 import 任何工作台组件。
// INTENT: proxy.ts 要在响应体开始流式输出之前判断"这条路径存不存在"（见 proxy.ts 的注释）。
//         如果它直接调 nav-config 的 parseAdminPath，整棵后台组件树会被打进 proxy 包——实测
//         dev 的 import trace 里 IncidentWorkspace 和整个 @idream/shared 都进去了。解析本身
//         一个 React 组件都用不到，拆出来即可。
// INVARIANT: section id 的清单以本文件为准。nav-config 的 NavItem["id"] 直接取自 AdminSectionId，
//            拼错的 id 是编译错误；反过来"列了 id 却没有对应导航项"由 nav-config.test.ts 拦。
//            这条对称性必须成立——proxy 说"存在"而页面解析不出来，就又回到了 200/404 不一致。

export const ADMIN_SECTION_IDS = [
  "dashboard",
  "content/official", "content/review-queue", "content/templates", "content/tags",
  "content/production", "content/assets", "content/placements",
  "cases", "users", "billing", "compliance",
  "analytics", "insights", "growth/characters", "experiments", "content",
  "announcements", "cms", "pricing", "promo",
  "ops/incidents", "generation/jobs", "generation/dead-letter", "ops/providers",
  "generation/backends", "generation/metrics", "generation/config",
  "generation/recipes", "generation/presets", "generation/workflows", "chat",
  "approvals", "system/access", "audit-log",
  // 不在导航里、但仍可直达的兼容目的地。
  "moderation", "support", "risk",
] as const;

export type AdminSectionId = (typeof ADMIN_SECTION_IDS)[number];

const SECTION_IDS: ReadonlySet<string> = new Set(ADMIN_SECTION_IDS);

export type AdminSubview =
  | { kind: "list" }
  | { kind: "new" }
  | { kind: "detail"; id: string };

export type AdminRouteMatch = { sectionId: AdminSectionId; view: AdminSubview };

const SECTION_ALIASES: Record<string, string> = {
  "generation/models": "generation/config",
};

const LEGACY_SUBVIEW_SECTIONS = new Set([
  "content/official", "content/templates", "generation/recipes",
  "generation/presets", "content/assets", "content/placements",
]);

const CANONICAL_LIST_SECTIONS: Record<string, AdminSectionId> = {
  today: "dashboard",
  characters: "content/official",
  "characters/releases": "content/official",
  "characters/calendar": "content/official",
  "characters/review": "content/review-queue",
  "characters/starters": "content/templates",
  "characters/taxonomy": "content/tags",
  "creative/runs": "content/production",
  "creative/review": "content/production",
  "creative/library": "content/assets",
  "creative/placements": "content/placements",
  customers: "users",
  "customer-ops/billing": "billing",
  "customer-ops/account-requests": "compliance",
  "growth/health": "analytics",
  "growth/funnels": "insights",
  "growth/characters": "growth/characters",
  "growth/experiments": "experiments",
  "growth/content": "cms",
  "ops/incidents": "ops/incidents",
  "ops/jobs": "generation/jobs",
  "ops/providers": "ops/providers",
  "ops/profiles": "generation/config",
  "ops/recipes": "generation/recipes",
  "ops/chat": "chat",
  "system/approvals": "approvals",
  "system/access": "system/access",
  "system/audit": "audit-log",
  "system/config": "generation/config",
};

function canonicalSection(path: string, query: URLSearchParams): AdminRouteMatch | null {
  if (path.startsWith("cases/") && path.split("/").length === 2) {
    return { sectionId: "cases", view: { kind: "detail", id: path.slice("cases/".length) } };
  }
  if (path === "cases") {
    return { sectionId: "cases", view: { kind: "list" } };
  }
  if (path.startsWith("customers/") && path.split("/").length === 2) {
    return { sectionId: "users", view: { kind: "detail", id: path.slice("customers/".length) } };
  }
  if (path.startsWith("ops/incidents/") && path.split("/").length === 3) {
    return { sectionId: "ops/incidents", view: { kind: "detail", id: path.slice("ops/incidents/".length) } };
  }
  if (path === "growth/merchandising") {
    return {
      sectionId: query.get("view") === "announcements" ? "announcements" : "content",
      view: { kind: "list" },
    };
  }
  if (path === "growth/offers") {
    return { sectionId: query.get("view") === "promo" ? "promo" : "pricing", view: { kind: "list" } };
  }
  if (path === "ops/jobs" && query.get("view") === "dead-letter") {
    return { sectionId: "generation/dead-letter", view: { kind: "list" } };
  }
  if (path === "ops/providers") {
    const sectionId = query.get("view") === "backends"
      ? "generation/backends"
      : query.get("view") === "generation-metrics"
        ? "generation/metrics"
        : "ops/providers";
    return { sectionId, view: { kind: "list" } };
  }
  if (path === "ops/recipes") {
    const sectionId = query.get("view") === "presets"
      ? "generation/presets"
      : query.get("view") === "workflows"
        ? "generation/workflows"
        : "generation/recipes";
    return { sectionId, view: { kind: "list" } };
  }
  const listSectionId = CANONICAL_LIST_SECTIONS[path];
  if (listSectionId) return { sectionId: listSectionId, view: { kind: "list" } };
  if (path === "characters/new") return { sectionId: "content/official", view: { kind: "new" } };
  if (path.startsWith("characters/") && path.split("/").length === 2) {
    return { sectionId: "content/official", view: { kind: "detail", id: path.slice("characters/".length) } };
  }
  if (path.startsWith("creative/runs/") && path.split("/").length === 3) {
    return { sectionId: "content/production", view: { kind: "detail", id: path.slice("creative/runs/".length) } };
  }
  for (const [prefix, sectionId] of [
    ["creative/library/", "content/assets"],
    ["creative/placements/", "content/placements"],
  ] as const) {
    if (path === `${prefix}new`) return { sectionId, view: { kind: "new" } };
    if (path.startsWith(prefix)) return { sectionId, view: { kind: "detail", id: path.slice(prefix.length) } };
  }
  return null;
}

// SPEC: 认得的路径解析成 { section id, 子视图 }；认不得就是 null。
export function matchAdminRoute(value: string): AdminRouteMatch | null {
  const [rawPath = "", rawQuery = ""] = value.split("?", 2);
  const path = rawPath.replace(/^\/+|\/+$/g, "");
  const canonical = canonicalSection(path, new URLSearchParams(rawQuery));
  if (canonical) return canonical;

  const mapped = SECTION_ALIASES[path] ?? path;
  if (SECTION_IDS.has(mapped)) return { sectionId: mapped as AdminSectionId, view: { kind: "list" } };
  const segments = mapped.split("/").filter(Boolean);
  if (segments.length >= 2) {
    const last = segments.at(-1) ?? "";
    const prefixRaw = segments.slice(0, -1).join("/");
    const prefix = SECTION_ALIASES[prefixRaw] ?? prefixRaw;
    if (LEGACY_SUBVIEW_SECTIONS.has(prefix) && SECTION_IDS.has(prefix) && last) {
      return last === "new"
        ? { sectionId: prefix as AdminSectionId, view: { kind: "new" } }
        : { sectionId: prefix as AdminSectionId, view: { kind: "detail", id: last } };
    }
  }
  return null;
}

/** proxy 用的存在性判定——只要"认不认得"，不需要导航项本身。 */
export function adminRouteExists(value: string) {
  return matchAdminRoute(value) !== null;
}
