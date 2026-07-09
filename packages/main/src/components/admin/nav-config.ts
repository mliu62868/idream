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
  Library,
  MessageSquare,
  Play,
  Server,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
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
  { id: "generation/jobs", label: "Jobs & Incidents", href: "/admin/generation/jobs", icon: Activity, group: "Generation Ops" },
  { id: "generation/config", label: "Profiles & Rollout", href: "/admin/generation/config", icon: SlidersHorizontal, group: "Generation Ops" },
  { id: "generation/dead-letter", label: "Dead-letter", href: "/admin/generation/dead-letter", icon: Inbox, group: "Generation Ops" },
  { id: "ops/providers", label: "Provider Health", href: "/admin/ops/providers", icon: Server, group: "Generation Ops" },
  { id: "generation/backends", label: "Backends", href: "/admin/generation/backends", icon: Server, group: "Generation Ops" },
  { id: "generation/workflows", label: "Workflows", href: "/admin/generation/workflows", icon: Workflow, group: "Generation Ops" },
  { id: "generation/metrics", label: "Metrics", href: "/admin/generation/metrics", icon: BarChart3, group: "Generation Ops" },
  { id: "content/production", label: "Production Studio", href: "/admin/content/production", icon: Play, group: "Content Ops" },
  { id: "content/assets", label: "Asset Library", href: "/admin/content/assets", icon: ImageIcon, group: "Content Ops" },
  { id: "content/placements", label: "Placements", href: "/admin/content/placements", icon: Bookmark, group: "Content Ops" },
  { id: "content", label: "Content", href: "/admin/content", icon: Library, group: "Content Ops" },
  { id: "content/official", label: "Official Characters", href: "/admin/content/official", icon: ShieldCheck, group: "Content Ops" },
  { id: "content/templates", label: "Templates", href: "/admin/content/templates", icon: SlidersHorizontal, group: "Content Ops" },
  { id: "content/tags", label: "Tags", href: "/admin/content/tags", icon: Flag, group: "Content Ops" },
  { id: "content/review-queue", label: "Review Queue", href: "/admin/content/review-queue", icon: ClipboardCheck, group: "Content Ops" },
  { id: "cms", label: "CMS / SEO", href: "/admin/cms", icon: FileText, group: "Content Ops" },
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
