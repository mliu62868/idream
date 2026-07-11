import {
  Activity,
  BadgeDollarSign,
  BarChart3,
  Bookmark,
  ClipboardCheck,
  Coins,
  FileText,
  Flag,
  Gauge,
  History,
  ImageIcon,
  Inbox,
  Layers,
  Library,
  MessageSquare,
  Play,
  ScrollText,
  Server,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Ticket,
  Users,
  Workflow,
  type LucideIcon,
} from "lucide-react";

export const ADMIN_WORKSPACES = [
  "Today",
  "Character Studio",
  "Creative Studio",
  "Customer Operations",
  "Growth",
  "Platform Operations",
  "System",
] as const;

export type AdminWorkspace = (typeof ADMIN_WORKSPACES)[number];
export type WorkMode =
  | "character_producer"
  | "creative_operator"
  | "platform_ops"
  | "support"
  | "moderator"
  | "growth_analyst"
  | "admin";

export type NavItem = {
  id: string;
  label: string;
  href: string;
  legacyHref: string;
  icon: LucideIcon;
  group: AdminWorkspace;
  permissions: readonly string[];
  tier: "daily" | "folded";
};

type ItemInput = Omit<NavItem, "legacyHref" | "tier">;

function item(input: ItemInput): NavItem {
  return {
    ...input,
    legacyHref: input.id === "dashboard" ? "/admin" : `/admin/${input.id}`,
    tier: input.group === "Today" ? "daily" : "folded",
  };
}

// SSoT for the migration shell. `id` remains the legacy implementation key so all
// 34 shipped capabilities stay reachable; `href` is the canonical decision-workspace URL.
// Permissions are existing effective keys, not client-side role guesses.
export const navItems: NavItem[] = [
  item({ id: "dashboard", label: "Today", href: "/admin/today", icon: Gauge, group: "Today", permissions: ["dashboard.read"] }),

  item({ id: "content/official", label: "Portfolio & Projects", href: "/admin/characters", icon: ShieldCheck, group: "Character Studio", permissions: ["character.project.read", "character.performance.read", "content.read"] }),
  item({ id: "content/review-queue", label: "Character Review", href: "/admin/characters/review", icon: ClipboardCheck, group: "Character Studio", permissions: ["safety.review.read", "content.read"] }),
  item({ id: "content/templates", label: "Character Starters", href: "/admin/characters/starters", icon: Sparkles, group: "Character Studio", permissions: ["content.read"] }),
  item({ id: "content/tags", label: "Taxonomy", href: "/admin/characters/taxonomy", icon: Flag, group: "Character Studio", permissions: ["content.read"] }),

  item({ id: "content/production", label: "Creative Runs", href: "/admin/creative/runs", icon: Play, group: "Creative Studio", permissions: ["creative.run.read", "content.production.write"] }),
  item({ id: "content/assets", label: "Library", href: "/admin/creative/library", icon: ImageIcon, group: "Creative Studio", permissions: ["content.asset.read"] }),
  item({ id: "content/placements", label: "Placements", href: "/admin/creative/placements", icon: Bookmark, group: "Creative Studio", permissions: ["content.asset.read", "content.placement.write"] }),

  item({ id: "cases", label: "Cases", href: "/admin/cases?view=mine", icon: Ticket, group: "Customer Operations", permissions: ["case.read"] }),
  item({ id: "users", label: "Customers", href: "/admin/customers", icon: Users, group: "Customer Operations", permissions: ["user.read"] }),
  item({ id: "billing", label: "Billing Operations", href: "/admin/customer-ops/billing", icon: BadgeDollarSign, group: "Customer Operations", permissions: ["billing.read"] }),
  item({ id: "compliance", label: "Account Requests", href: "/admin/customer-ops/account-requests", icon: ShieldAlert, group: "Customer Operations", permissions: ["compliance.read"] }),

  item({ id: "analytics", label: "Product Health", href: "/admin/growth/health", icon: BarChart3, group: "Growth", permissions: ["analytics.export"] }),
  item({ id: "insights", label: "Funnels & Retention", href: "/admin/growth/funnels", icon: BarChart3, group: "Growth", permissions: ["analytics.export"] }),
  item({ id: "experiments", label: "Flag Monitoring", href: "/admin/growth/experiments", icon: Flag, group: "Growth", permissions: ["analytics.export", "config.feature_flag.write"] }),
  item({ id: "content", label: "Featured Merchandising", href: "/admin/growth/merchandising?view=featured", icon: Library, group: "Growth", permissions: ["content.read"] }),
  item({ id: "announcements", label: "Announcements", href: "/admin/growth/merchandising?view=announcements", icon: MessageSquare, group: "Growth", permissions: ["content.cms.write"] }),
  item({ id: "cms", label: "CMS & SEO", href: "/admin/growth/content", icon: FileText, group: "Growth", permissions: ["content.cms.write"] }),
  item({ id: "pricing", label: "Pricing", href: "/admin/growth/offers?view=pricing", icon: Coins, group: "Growth", permissions: ["config.pricing.write"] }),
  item({ id: "promo", label: "Promotions", href: "/admin/growth/offers?view=promo", icon: Ticket, group: "Growth", permissions: ["growth.promo.read"] }),

  item({ id: "ops/incidents", label: "Incidents", href: "/admin/ops/incidents", icon: ShieldAlert, group: "Platform Operations", permissions: ["ops.incident.read"] }),
  item({ id: "generation/jobs", label: "Generation Jobs", href: "/admin/ops/jobs", icon: Activity, group: "Platform Operations", permissions: ["generation.job.read"] }),
  item({ id: "generation/dead-letter", label: "Dead-letter", href: "/admin/ops/jobs?view=dead-letter", icon: Inbox, group: "Platform Operations", permissions: ["generation.job.requeue", "ops.deadletter.write"] }),
  item({ id: "ops/providers", label: "Providers", href: "/admin/ops/providers", icon: Gauge, group: "Platform Operations", permissions: ["ops.queue.read"] }),
  item({ id: "generation/backends", label: "Backend Diagnostics", href: "/admin/ops/providers?view=backends", icon: Server, group: "Platform Operations", permissions: ["ops.queue.read"] }),
  item({ id: "generation/metrics", label: "Generation Health", href: "/admin/ops/providers?view=generation-metrics", icon: BarChart3, group: "Platform Operations", permissions: ["ops.queue.read"] }),
  item({ id: "generation/config", label: "Profiles & Rollout", href: "/admin/ops/profiles", icon: SlidersHorizontal, group: "Platform Operations", permissions: ["generation.config.read"] }),
  item({ id: "generation/recipes", label: "Prompt Recipes", href: "/admin/ops/recipes", icon: ScrollText, group: "Platform Operations", permissions: ["generation.config.read"] }),
  item({ id: "generation/presets", label: "Presets", href: "/admin/ops/recipes?view=presets", icon: Layers, group: "Platform Operations", permissions: ["generation.config.read"] }),
  item({ id: "generation/workflows", label: "Workflow Diagnostics", href: "/admin/ops/recipes?view=workflows", icon: Workflow, group: "Platform Operations", permissions: ["generation.config.read"] }),
  item({ id: "chat", label: "Chat Operations", href: "/admin/ops/chat", icon: MessageSquare, group: "Platform Operations", permissions: ["chat.ops.read"] }),

  item({ id: "approvals", label: "Approvals", href: "/admin/system/approvals", icon: ClipboardCheck, group: "System", permissions: ["admin.approval.review"] }),
  item({ id: "audit-log", label: "Audit Log", href: "/admin/system/audit", icon: History, group: "System", permissions: ["audit.read"] }),
];

export const NAV_GROUP_ORDER = [...ADMIN_WORKSPACES];
export const NAV_DAILY = navItems.filter((navItem) => navItem.tier === "daily");
export const NAV_FOLDED_GROUPS = ADMIN_WORKSPACES.filter((group) => group !== "Today").map(
  (group) => ({ group, items: navItems.filter((navItem) => navItem.group === group) }),
);

const MODE_GROUP_ORDER: Record<WorkMode, readonly AdminWorkspace[]> = {
  character_producer: ["Today", "Character Studio", "Creative Studio", "Growth", "Platform Operations", "Customer Operations", "System"],
  creative_operator: ["Today", "Creative Studio", "Character Studio", "Platform Operations", "Growth", "Customer Operations", "System"],
  platform_ops: ["Today", "Platform Operations", "Customer Operations", "System", "Creative Studio", "Character Studio", "Growth"],
  support: ["Today", "Customer Operations", "Platform Operations", "System", "Character Studio", "Creative Studio", "Growth"],
  moderator: ["Today", "Customer Operations", "Character Studio", "System", "Platform Operations", "Creative Studio", "Growth"],
  growth_analyst: ["Today", "Growth", "Character Studio", "Creative Studio", "Customer Operations", "Platform Operations", "System"],
  admin: ADMIN_WORKSPACES,
};

export function defaultWorkModeForRole(role: string | undefined): WorkMode {
  if (role === "support") return "support";
  if (role === "moderator") return "moderator";
  if (role === "ops") return "platform_ops";
  if (role === "analyst") return "growth_analyst";
  return "admin";
}

export function sectionIsPermitted(sectionId: string, permissions: ReadonlySet<string>) {
  const navItem = navItems.find((candidate) => candidate.id === sectionId);
  return Boolean(navItem?.permissions.some((permission) => permissions.has(permission)));
}

export function navGroupsForPermissions(permissions: ReadonlySet<string>, mode: WorkMode) {
  return MODE_GROUP_ORDER[mode]
    .map((group) => ({
      group,
      items: navItems.filter(
        (navItem) => navItem.group === group && navItem.permissions.some((key) => permissions.has(key)),
      ),
    }))
    .filter(({ items }) => items.length > 0);
}

const KNOWN_SECTION_IDS = new Set(navItems.map((navItem) => navItem.id));
const SECTION_ALIASES: Record<string, string> = {
  "generation/models": "generation/config",
  moderation: "cases",
  support: "cases",
  risk: "cases",
};

export type AdminSubview =
  | { kind: "list" }
  | { kind: "new" }
  | { kind: "detail"; id: string };
export type AdminPath = { sectionId: string; view: AdminSubview };

const LEGACY_SUBVIEW_SECTIONS = new Set([
  "content/official", "content/templates", "generation/recipes",
  "generation/presets", "content/assets", "content/placements",
]);

const CANONICAL_LIST_SECTIONS: Record<string, string> = {
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
  "growth/characters": "content/official",
  "growth/experiments": "experiments",
  "growth/content": "cms",
  "ops/incidents": "ops/incidents",
  "ops/jobs": "generation/jobs",
  "ops/providers": "ops/providers",
  "ops/profiles": "generation/config",
  "ops/recipes": "generation/recipes",
  "ops/chat": "chat",
  "system/approvals": "approvals",
  "system/access": "users",
  "system/audit": "audit-log",
  "system/config": "generation/config",
};

function canonicalSection(path: string, query: URLSearchParams): AdminPath | null {
  if (path === "cases") {
    return { sectionId: "cases", view: { kind: "list" } };
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
  const sectionId = CANONICAL_LIST_SECTIONS[path];
  return sectionId ? { sectionId, view: { kind: "list" } } : null;
}

export function parseAdminPath(value: string): AdminPath {
  const [rawPath = "", rawQuery = ""] = value.split("?", 2);
  const path = rawPath.replace(/^\/+|\/+$/g, "");
  const canonical = canonicalSection(path, new URLSearchParams(rawQuery));
  if (canonical) return canonical;

  const mapped = SECTION_ALIASES[path] ?? path;
  if (KNOWN_SECTION_IDS.has(mapped)) return { sectionId: mapped, view: { kind: "list" } };
  const segments = mapped.split("/").filter(Boolean);
  if (segments.length >= 2) {
    const last = segments.at(-1) ?? "";
    const prefixRaw = segments.slice(0, -1).join("/");
    const prefix = SECTION_ALIASES[prefixRaw] ?? prefixRaw;
    if (LEGACY_SUBVIEW_SECTIONS.has(prefix) && KNOWN_SECTION_IDS.has(prefix) && last) {
      return last === "new"
        ? { sectionId: prefix, view: { kind: "new" } }
        : { sectionId: prefix, view: { kind: "detail", id: last } };
    }
  }
  return { sectionId: "dashboard", view: { kind: "list" } };
}

export function normalizeSection(value: string) {
  return parseAdminPath(value).sectionId;
}

type SearchValue = string | string[] | undefined;

export function adminEntryRedirect(
  section: readonly string[],
  searchParams: Readonly<Record<string, SearchValue>>,
) {
  if (section.length > 0 && !(section.length === 1 && section[0] === "inbox")) return null;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (Array.isArray(value)) value.forEach((entry) => query.append(key, entry));
    else if (value !== undefined) query.set(key, value);
  }
  const encoded = query.toString();
  return `/admin/today${encoded ? `?${encoded}` : ""}`;
}

export type ConfigSlice = "profiles";

export function configSliceForSection(sectionId: string): ConfigSlice | null {
  return sectionId === "generation/config" ? "profiles" : null;
}
