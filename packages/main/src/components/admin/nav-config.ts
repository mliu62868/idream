import {
  Activity,
  AlertTriangle,
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

export type NavItem = {
  id: string;
  label: string;
  href: string;
  icon: LucideIcon;
  group: string;
  tier: "daily" | "folded";
};

// SPEC: guided nav — a small pinned daily set + the rest folded behind group headers.
// Tier map is the SSoT (docs/superpowers/plans/2026-07-09-admin-guided-nav.md).
// INVARIANT: every id/label/href/icon is unchanged from the pre-tier list; only
// group + tier move. daily + folded groups must cover all ids exactly once (tested).
export const navItems: NavItem[] = [
  // Daily — pinned, always visible (7)
  { id: "dashboard", label: "Dashboard", href: "/admin", icon: Gauge, group: "Daily", tier: "daily" },
  { id: "content/review-queue", label: "Character Review", href: "/admin/content/review-queue", icon: ClipboardCheck, group: "Daily", tier: "daily" },
  { id: "moderation", label: "Moderation", href: "/admin/moderation", icon: ShieldAlert, group: "Daily", tier: "daily" },
  { id: "content/official", label: "Official Characters", href: "/admin/content/official", icon: ShieldCheck, group: "Daily", tier: "daily" },
  { id: "content/production", label: "Image Production", href: "/admin/content/production", icon: Play, group: "Daily", tier: "daily" },
  { id: "content", label: "Featured", href: "/admin/content", icon: Library, group: "Daily", tier: "daily" },
  { id: "support", label: "Support Requests", href: "/admin/support", icon: Ticket, group: "Daily", tier: "daily" },

  // Folded — CharacterConfig (2)
  { id: "content/templates", label: "Character Starters", href: "/admin/content/templates", icon: Sparkles, group: "CharacterConfig", tier: "folded" },
  { id: "content/tags", label: "Tags", href: "/admin/content/tags", icon: Flag, group: "CharacterConfig", tier: "folded" },

  // Folded — GenerationConfig (3)
  { id: "generation/config", label: "Model Profiles", href: "/admin/generation/config", icon: SlidersHorizontal, group: "GenerationConfig", tier: "folded" },
  { id: "generation/recipes", label: "Prompt Recipes", href: "/admin/generation/recipes", icon: ScrollText, group: "GenerationConfig", tier: "folded" },
  { id: "generation/presets", label: "Presets", href: "/admin/generation/presets", icon: Layers, group: "GenerationConfig", tier: "folded" },

  // Folded — Media (3)
  { id: "content/assets", label: "Image Library", href: "/admin/content/assets", icon: ImageIcon, group: "Media", tier: "folded" },
  { id: "content/placements", label: "Placements", href: "/admin/content/placements", icon: Bookmark, group: "Media", tier: "folded" },
  { id: "cms", label: "CMS / SEO", href: "/admin/cms", icon: FileText, group: "Media", tier: "folded" },

  // Folded — Business (5)
  { id: "users", label: "Users", href: "/admin/users", icon: Users, group: "Business", tier: "folded" },
  { id: "billing", label: "Billing", href: "/admin/billing", icon: BadgeDollarSign, group: "Business", tier: "folded" },
  { id: "pricing", label: "Pricing", href: "/admin/pricing", icon: Coins, group: "Business", tier: "folded" },
  { id: "promo", label: "Promo", href: "/admin/promo", icon: Ticket, group: "Business", tier: "folded" },
  { id: "announcements", label: "Announcements", href: "/admin/announcements", icon: MessageSquare, group: "Business", tier: "folded" },

  // Folded — Insights (4)
  { id: "analytics", label: "Analytics", href: "/admin/analytics", icon: BarChart3, group: "Insights", tier: "folded" },
  { id: "insights", label: "Insights", href: "/admin/insights", icon: BarChart3, group: "Insights", tier: "folded" },
  { id: "experiments", label: "Experiments", href: "/admin/experiments", icon: Flag, group: "Insights", tier: "folded" },
  { id: "risk", label: "Risk & Abuse", href: "/admin/risk", icon: AlertTriangle, group: "Insights", tier: "folded" },

  // Folded — Engineering (6, hidden-by-default diagnostics per ADMIN_CONSOLE_PLAN.md)
  { id: "generation/workflows", label: "Workflows", href: "/admin/generation/workflows", icon: Workflow, group: "Engineering", tier: "folded" },
  { id: "generation/backends", label: "Backends", href: "/admin/generation/backends", icon: Server, group: "Engineering", tier: "folded" },
  { id: "ops/providers", label: "Provider Health", href: "/admin/ops/providers", icon: Gauge, group: "Engineering", tier: "folded" },
  { id: "generation/jobs", label: "Jobs & Incidents", href: "/admin/generation/jobs", icon: Activity, group: "Engineering", tier: "folded" },
  { id: "generation/dead-letter", label: "Dead-letter", href: "/admin/generation/dead-letter", icon: Inbox, group: "Engineering", tier: "folded" },
  { id: "generation/metrics", label: "Metrics", href: "/admin/generation/metrics", icon: BarChart3, group: "Engineering", tier: "folded" },

  // Folded — System (4)
  { id: "chat", label: "Chat Ops", href: "/admin/chat", icon: MessageSquare, group: "System", tier: "folded" },
  { id: "compliance", label: "Compliance", href: "/admin/compliance", icon: ShieldAlert, group: "System", tier: "folded" },
  { id: "approvals", label: "Approvals", href: "/admin/approvals", icon: ClipboardCheck, group: "System", tier: "folded" },
  { id: "audit-log", label: "Audit Log", href: "/admin/audit-log", icon: History, group: "System", tier: "folded" },
];

export const NAV_GROUP_ORDER: string[] = navItems.reduce<string[]>((groups, item) => {
  if (!groups.includes(item.group)) groups.push(item.group);
  return groups;
}, []);

export const NAV_DAILY: NavItem[] = navItems.filter((i) => i.tier === "daily");

const FOLDED_GROUP_ORDER = [
  "CharacterConfig", "GenerationConfig", "Media", "Business", "Insights", "Engineering", "System",
] as const;

export const NAV_FOLDED_GROUPS: { group: string; items: NavItem[] }[] = FOLDED_GROUP_ORDER.map(
  (group) => ({ group, items: navItems.filter((i) => i.tier === "folded" && i.group === group) }),
);

const KNOWN_SECTION_IDS = new Set(navItems.map((item) => item.id));

const SECTION_ALIASES: Record<string, string> = {
  "generation/models": "generation/config",
};

// SPEC: normalize an incoming route section to a known nav id; unknown → dashboard.
// INVARIANT: the known-id set is derived from navItems, so navItems is the SSoT.
export function normalizeSection(value: string): string {
  const mapped = SECTION_ALIASES[value] ?? value;
  return KNOWN_SECTION_IDS.has(mapped) ? mapped : "dashboard";
}

export type ConfigSlice = "profiles" | "recipes" | "presets";

// SPEC: which slice of the generation-config data a section renders.
// generation/config → model profiles; /recipes → prompt recipes; /presets → presets.
export function configSliceForSection(sectionId: string): ConfigSlice | null {
  if (sectionId === "generation/config") return "profiles";
  if (sectionId === "generation/recipes") return "recipes";
  if (sectionId === "generation/presets") return "presets";
  return null;
}
