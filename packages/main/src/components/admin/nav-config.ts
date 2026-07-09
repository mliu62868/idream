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
};

export const navItems: NavItem[] = [
  { id: "dashboard", label: "Dashboard", href: "/admin", icon: Gauge, group: "Overview" },

  // ① 角色 Characters
  { id: "content/official", label: "Official Characters", href: "/admin/content/official", icon: ShieldCheck, group: "Characters" },
  { id: "content/templates", label: "Character Starters", href: "/admin/content/templates", icon: Sparkles, group: "Characters" },
  { id: "content/review-queue", label: "Character Review", href: "/admin/content/review-queue", icon: ClipboardCheck, group: "Characters" },
  { id: "content/tags", label: "Tags", href: "/admin/content/tags", icon: Flag, group: "Characters" },

  // ② 生成 Generation
  { id: "generation/config", label: "Model Profiles", href: "/admin/generation/config", icon: SlidersHorizontal, group: "Generation" },
  { id: "generation/recipes", label: "Prompt Recipes", href: "/admin/generation/recipes", icon: ScrollText, group: "Generation" },
  { id: "generation/presets", label: "Presets", href: "/admin/generation/presets", icon: Layers, group: "Generation" },
  { id: "generation/workflows", label: "Workflows", href: "/admin/generation/workflows", icon: Workflow, group: "Generation" },
  { id: "generation/backends", label: "Backends", href: "/admin/generation/backends", icon: Server, group: "Generation" },
  { id: "ops/providers", label: "Provider Health", href: "/admin/ops/providers", icon: Gauge, group: "Generation" },
  { id: "generation/jobs", label: "Jobs & Incidents", href: "/admin/generation/jobs", icon: Activity, group: "Generation" },
  { id: "generation/dead-letter", label: "Dead-letter", href: "/admin/generation/dead-letter", icon: Inbox, group: "Generation" },
  { id: "generation/metrics", label: "Metrics", href: "/admin/generation/metrics", icon: BarChart3, group: "Generation" },

  // ③ 图片 Media
  { id: "content/production", label: "Image Production", href: "/admin/content/production", icon: Play, group: "Media" },
  { id: "content/assets", label: "Image Library", href: "/admin/content/assets", icon: ImageIcon, group: "Media" },
  { id: "content/placements", label: "Placements", href: "/admin/content/placements", icon: Bookmark, group: "Media" },
  { id: "content", label: "Featured", href: "/admin/content", icon: Library, group: "Media" },
  { id: "cms", label: "CMS / SEO", href: "/admin/cms", icon: FileText, group: "Media" },

  // untouched groups (verbatim)
  { id: "moderation", label: "Moderation", href: "/admin/moderation", icon: ShieldAlert, group: "Trust Ops" },
  { id: "chat", label: "Chat Ops", href: "/admin/chat", icon: MessageSquare, group: "Trust Ops" },
  { id: "support", label: "Support Requests", href: "/admin/support", icon: Ticket, group: "Trust Ops" },
  { id: "users", label: "Users", href: "/admin/users", icon: Users, group: "Business Ops" },
  { id: "billing", label: "Billing", href: "/admin/billing", icon: BadgeDollarSign, group: "Business Ops" },
  { id: "pricing", label: "Pricing", href: "/admin/pricing", icon: Coins, group: "Business Ops" },
  { id: "promo", label: "Promo", href: "/admin/promo", icon: Ticket, group: "Business Ops" },
  { id: "announcements", label: "Announcements", href: "/admin/announcements", icon: MessageSquare, group: "Business Ops" },
  { id: "analytics", label: "Analytics", href: "/admin/analytics", icon: BarChart3, group: "Insights" },
  { id: "insights", label: "Insights", href: "/admin/insights", icon: BarChart3, group: "Insights" },
  { id: "experiments", label: "Experiments", href: "/admin/experiments", icon: Flag, group: "Insights" },
  { id: "risk", label: "Risk & Abuse", href: "/admin/risk", icon: AlertTriangle, group: "Insights" },
  { id: "compliance", label: "Compliance", href: "/admin/compliance", icon: ShieldAlert, group: "System" },
  { id: "approvals", label: "Approvals", href: "/admin/approvals", icon: ClipboardCheck, group: "System" },
  { id: "audit-log", label: "Audit Log", href: "/admin/audit-log", icon: History, group: "System" },
];

export const NAV_GROUP_ORDER: string[] = navItems.reduce<string[]>((groups, item) => {
  if (!groups.includes(item.group)) groups.push(item.group);
  return groups;
}, []);

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
