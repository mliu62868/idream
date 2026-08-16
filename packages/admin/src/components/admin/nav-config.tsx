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
import type { ReactNode } from "react";
import {
  ADMIN_V2_WORKSPACE_ACCESS,
  type AdminV2WorkspaceAccessKey,
} from "./workspace-access";
import type { WorkMode } from "./shell-preferences";
import type { AdminPermissionKey } from "@idream/shared/admin/permissions";
import { BackendsView } from "@/components/admin/BackendsView";
import { GenerationMetricsView } from "@/components/admin/GenerationMetricsView";
import { WorkflowsView } from "@/components/admin/WorkflowsView";
import { StartersSection } from "@/components/admin/starters/StartersSection";
import { RecipesSection } from "@/components/admin/recipes/RecipesSection";
import { PresetsSection } from "@/components/admin/presets/PresetsSection";
import { AssetsSection } from "@/components/admin/assets/AssetsSection";
import { TagsView } from "@/components/admin/TagsView";
import { ReviewQueueView } from "@/components/admin/ReviewQueueView";
import { CmsView } from "@/components/admin/CmsView";
import { ComplianceView } from "@/components/admin/ComplianceView";
import { InsightsView } from "@/components/admin/InsightsView";
import { AnnouncementsView } from "@/components/admin/AnnouncementsView";
import { ExperimentsView } from "@/components/admin/ExperimentsView";
import { TodayWorkspace } from "@/components/admin/today/TodayWorkspace";
import { PlacementsSection } from "@/components/admin/placements/PlacementsSection";
import { IncidentWorkspace } from "@/features/incidents/IncidentWorkspace";
import { CaseWorkspace } from "@/features/cases/CaseWorkspace";
import { CustomerWorkspace } from "@/features/customers/CustomerWorkspace";
import { CharacterPerformanceWorkspace, CharacterWorkspace } from "@/features/characters/CharacterWorkspace";
import { CreativeRunWorkspace } from "@/features/creative/CreativeRunWorkspace";
import { JobsView as GenerationJobsWorkspace } from "@/features/jobs/JobsView";
import { AuditWorkspace } from "@/features/audit/AuditWorkspace";
import { PricingWorkspace } from "@/features/pricing/PricingWorkspace";
import { BillingWorkspace } from "@/features/billing/BillingWorkspace";
import { GenerationConfigWorkspace } from "@/features/config/GenerationConfigWorkspace";
import { DeadLetterWorkspace } from "@/features/dead-letter/DeadLetterWorkspace";
import { AccessWorkspace } from "@/features/access/AccessWorkspace";
import { ModerationWorkspace } from "@/features/moderation/ModerationWorkspace";
import { SupportWorkspace } from "@/features/support/SupportWorkspace";
import { PromoWorkspace } from "@/features/promo/PromoWorkspace";
import { ApprovalsWorkspace } from "@/features/approvals/ApprovalsWorkspace";
import { ChatOpsWorkspace } from "@/features/chat-ops/ChatOpsWorkspace";
import { adminV2OperationAllowed } from "@/lib/admin-v2-operation";
import { ContentMerchandisingWorkspace } from "@/features/content-merchandising/ContentMerchandisingWorkspace";
import {
  AnalyticsWorkspace,
  ProviderOverviewWorkspace,
  RiskWorkspace,
} from "@/features/overviews/OverviewWorkspaces";

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
// WorkMode 的取值域住在 shell-preferences.ts —— 那是服务端也能安全 import 的叶子模块，
// 读 cookie 时要按它校验。这里转出去，既有引用方（today/*）不必改 import 路径。
export type { WorkMode };

// SPEC: 一个 section 渲染自己所需的全部上下文；除此之外 shell 不再向下传任何东西。
// INTENT: 权限只以 ReadonlySet 下发，section 自己 has() 出需要的写权限——曾经每加一个
//         工作台就要在 shell 的 renderSection 里拼一个 permissions 对象，那层拼装没有
//         任何编译期约束，加错 key 也只是少一个按钮。
export type SectionContext = {
  readonly permissions: ReadonlySet<AdminPermissionKey>;
  readonly canRead: boolean;
  readonly workMode: WorkMode;
  readonly actorId: string;
  readonly view: AdminSubview;
};

export type NavItem = {
  id: string;
  label: string;
  href: string;
  legacyHref: string | null;
  icon: LucideIcon;
  group: AdminWorkspace;
  read: { allOf: readonly AdminPermissionKey[] };
  apiWorkspace: AdminV2WorkspaceAccessKey | null;
  tier: "daily" | "folded";
  // SPEC: 这一页需要外壳给多厚的外框。compact = 工作台自己画页面级标题，外壳只出面包屑。
  // INTENT: 这以前是外壳里 `sectionId === "content/official"` 的硬编码特判，在副标题、全局搜索、
  //         工作模式选择器、来源条四处各 null 一次——结果角色页成了全站唯一没有全局搜索的页面，
  //         一个纯粹的孤岛。真正的差别只有一条：角色工作台顶着 96px 头像和角色名的大标题，
  //         外壳再叠一个 h1 就是两层标题。让导航项自己声明这一条，特判从外壳里消失。
  chrome: "default" | "compact";
  // SPEC: 导航项自带渲染方式，必填。
  // INVARIANT: 这是"新增导航项必须同时配好组件"的唯一强制点——漏了就是编译错误，
  //            而不是像过去那样在 renderSection 的 if 链末尾静默落到角色审核队列。
  render: (context: SectionContext) => ReactNode;
};

type ItemInput = Omit<NavItem, "apiWorkspace" | "legacyHref" | "tier" | "chrome"> & {
  apiWorkspace?: AdminV2WorkspaceAccessKey;
  chrome?: NavItem["chrome"];
};

function read(...allOf: AdminPermissionKey[]): NavItem["read"] {
  return { allOf };
}

function item(input: ItemInput): NavItem {
  return {
    ...input,
    apiWorkspace: input.apiWorkspace ?? null,
    chrome: input.chrome ?? "default",
    legacyHref: input.id === "dashboard" ? "/admin" : `/admin/${input.id}`,
    tier: input.group === "Today" ? "daily" : "folded",
  };
}

function targetItem(input: ItemInput): NavItem {
  return {
    ...input,
    apiWorkspace: input.apiWorkspace ?? null,
    chrome: input.chrome ?? "default",
    legacyHref: null,
    tier: input.group === "Today" ? "daily" : "folded",
  };
}

function apiItem(
  input: Omit<ItemInput, "read"> & { apiWorkspace: AdminV2WorkspaceAccessKey },
): NavItem {
  return item({ ...input, read: ADMIN_V2_WORKSPACE_ACCESS[input.apiWorkspace] });
}

function apiTargetItem(
  input: Omit<ItemInput, "read"> & { apiWorkspace: AdminV2WorkspaceAccessKey },
): NavItem {
  return targetItem({ ...input, read: ADMIN_V2_WORKSPACE_ACCESS[input.apiWorkspace] });
}

// SSoT for the migration shell. `id` remains the legacy implementation key so all
// 34 shipped capabilities stay reachable; `href` is the canonical decision-workspace URL.
// Permissions are existing effective keys, not client-side role guesses.
export const navItems: NavItem[] = [
  apiItem({ id: "dashboard", label: "Today", href: "/admin/today", icon: Gauge, group: "Today", apiWorkspace: "today",
    render: (ctx) => <TodayWorkspace workMode={ctx.workMode} /> }),

  apiItem({ id: "content/official", label: "Characters", href: "/admin/characters", icon: ShieldCheck, group: "Character Studio", apiWorkspace: "character_workspace", chrome: "compact",
    render: (ctx) => <CharacterWorkspace actorId={ctx.actorId} permissions={ctx.permissions} view={ctx.view} /> }),
  item({ id: "content/review-queue", label: "Character Review", href: "/admin/characters/review", icon: ClipboardCheck, group: "Character Studio", read: read("safety.review.read"),
    render: () => <ReviewQueueView /> }),
  item({ id: "content/templates", label: "Character Starters", href: "/admin/characters/starters", icon: Sparkles, group: "Character Studio", read: read("content.read"),
    render: (ctx) => <StartersSection view={ctx.view} /> }),
  item({ id: "content/tags", label: "Taxonomy", href: "/admin/characters/taxonomy", icon: Flag, group: "Character Studio", read: read("content.read"),
    render: () => <TagsView /> }),

  apiItem({ id: "content/production", label: "Creative Runs", href: "/admin/creative/runs", icon: Play, group: "Creative Studio", apiWorkspace: "creative_runs",
    render: (ctx) => <CreativeRunWorkspace actorId={ctx.actorId} permissions={{
      read: ctx.canRead,
      write: ctx.permissions.has("creative.run.write"),
      review: ctx.permissions.has("creative.run.review"),
      place: ctx.permissions.has("creative.placement.publish"),
      manageIncident: ctx.permissions.has("ops.incident.manage"),
    }} view={ctx.view} /> }),
  item({ id: "content/assets", label: "Library", href: "/admin/creative/library", icon: ImageIcon, group: "Creative Studio", read: read("creative.asset.read"),
    render: (ctx) => <AssetsSection canReview={ctx.permissions.has("content.asset.review")} view={ctx.view} /> }),
  item({ id: "content/placements", label: "Placements", href: "/admin/creative/placements", icon: Bookmark, group: "Creative Studio", read: read("creative.placement.read"),
    render: (ctx) => <PlacementsSection canPublish={ctx.permissions.has("creative.placement.publish")} view={ctx.view} /> }),

  apiItem({ id: "cases", label: "Cases", href: "/admin/cases?view=mine", icon: Ticket, group: "Customer Operations", apiWorkspace: "cases",
    render: (ctx) => <CaseWorkspace
      canAssign={ctx.permissions.has("case.assign")}
      canDecide={ctx.permissions.has("case.decide")}
      initialCaseId={detailId(ctx.view)}
      key={detailId(ctx.view) ?? "case-list"}
    /> }),
  apiItem({ id: "users", label: "Customers", href: "/admin/customers", icon: Users, group: "Customer Operations", apiWorkspace: "customers",
    render: (ctx) => <CustomerWorkspace initialCustomerId={detailId(ctx.view)} /> }),
  item({ id: "billing", label: "Billing Operations", href: "/admin/customer-ops/billing", icon: BadgeDollarSign, group: "Customer Operations", read: read("billing.read"),
    render: (ctx) => <BillingWorkspace
      canAdjust={ctx.permissions.has("billing.ledger.adjust")}
      canReconcile={ctx.permissions.has("billing.checkout.reconcile")}
      canRefund={ctx.permissions.has("billing.subscription.refund")}
    /> }),
  item({ id: "compliance", label: "Account Requests", href: "/admin/customer-ops/account-requests", icon: ShieldAlert, group: "Customer Operations", read: read("compliance.read"),
    render: () => <ComplianceView /> }),

  apiItem({ id: "analytics", label: "Product Health", href: "/admin/growth/health", icon: BarChart3, group: "Growth", apiWorkspace: "metrics",
    render: (ctx) => <AnalyticsWorkspace
      canReadCanonical={ctx.canRead}
      canReadLegacy={ctx.permissions.has("analytics.export")}
    /> }),
  apiItem({ id: "insights", label: "Funnels & Retention", href: "/admin/growth/funnels", icon: BarChart3, group: "Growth", apiWorkspace: "metrics",
    render: () => <InsightsView /> }),
  apiTargetItem({ id: "growth/characters", label: "Character Performance", href: "/admin/growth/characters", icon: Activity, group: "Growth", apiWorkspace: "character_performance",
    render: (ctx) => <CharacterPerformanceWorkspace permissions={ctx.permissions} /> }),
  apiItem({ id: "experiments", label: "Experiments", href: "/admin/growth/experiments", icon: Flag, group: "Growth", apiWorkspace: "experiments",
    render: () => <ExperimentsView /> }),
  item({ id: "content", label: "Featured Merchandising", href: "/admin/growth/merchandising?view=featured", icon: Library, group: "Growth", read: read("content.read"),
    render: (ctx) => <ContentMerchandisingWorkspace canWrite={ctx.permissions.has("content.takedown.write")} /> }),
  item({ id: "announcements", label: "Announcements", href: "/admin/growth/merchandising?view=announcements", icon: MessageSquare, group: "Growth", read: read("growth.promo.read"),
    render: () => <AnnouncementsView /> }),
  item({ id: "cms", label: "CMS & SEO", href: "/admin/growth/content", icon: FileText, group: "Growth", read: read("content.read"),
    render: () => <CmsView /> }),
  item({ id: "pricing", label: "Pricing", href: "/admin/growth/offers?view=pricing", icon: Coins, group: "Growth", read: read("billing.read"),
    render: (ctx) => <PricingWorkspace canWrite={ctx.permissions.has("config.pricing.write")} /> }),
  item({ id: "promo", label: "Promotions", href: "/admin/growth/offers?view=promo", icon: Ticket, group: "Growth", read: read("growth.promo.read"),
    render: (ctx) => <PromoWorkspace canWrite={ctx.permissions.has("growth.promo.write")} /> }),

  apiItem({ id: "ops/incidents", label: "Incidents", href: "/admin/ops/incidents", icon: ShieldAlert, group: "Platform Operations", apiWorkspace: "incidents",
    render: (ctx) => <IncidentWorkspace
      canManage={ctx.permissions.has("ops.incident.manage")}
      canDiscardAttemptMissingCorrelationOutbox={adminV2OperationAllowed(
        "POST /api/v2/admin/incidents/correlation-outbox/commands/discard-attempt-missing",
        ctx.permissions,
      )}
      canReadCorrelationOutbox={adminV2OperationAllowed(
        "GET /api/v2/admin/incidents/correlation-outbox",
        ctx.permissions,
      )}
      canReplayCorrelationOutbox={adminV2OperationAllowed(
        "POST /api/v2/admin/incidents/correlation-outbox/commands/replay",
        ctx.permissions,
      )}
      initialIncidentId={detailId(ctx.view)}
      key={detailId(ctx.view) ?? "incident-list"}
    /> }),
  apiItem({ id: "generation/jobs", label: "Generation Jobs", href: "/admin/ops/jobs", icon: Activity, group: "Platform Operations", apiWorkspace: "generation_jobs",
    render: () => <GenerationJobsWorkspace /> }),
  item({ id: "generation/dead-letter", label: "Dead-letter", href: "/admin/ops/jobs?view=dead-letter", icon: Inbox, group: "Platform Operations", read: read("ops.queue.read"),
    render: (ctx) => <DeadLetterWorkspace permissions={{
      requeue: ctx.permissions.has("generation.job.requeue"),
      discard: ctx.permissions.has("ops.deadletter.write"),
    }} /> }),
  item({ id: "ops/providers", label: "Providers", href: "/admin/ops/providers", icon: Gauge, group: "Platform Operations", read: read("ops.queue.read"),
    render: (ctx) => <ProviderOverviewWorkspace canRead={ctx.permissions.has("ops.queue.read")} /> }),
  item({ id: "generation/backends", label: "Backend Diagnostics", href: "/admin/ops/providers?view=backends", icon: Server, group: "Platform Operations", read: read("ops.queue.read"),
    render: () => <BackendsView /> }),
  item({ id: "generation/metrics", label: "Generation Health", href: "/admin/ops/providers?view=generation-metrics", icon: BarChart3, group: "Platform Operations", read: read("ops.queue.read"),
    render: () => <GenerationMetricsView /> }),
  item({ id: "generation/config", label: "Profiles & Rollout", href: "/admin/ops/profiles", icon: SlidersHorizontal, group: "Platform Operations", read: read("generation.config.read", "ops.queue.read", "generation.job.read"),
    render: (ctx) => <GenerationConfigWorkspace permissions={{
      manageProfiles: ctx.permissions.has("generation.config.write"),
      manageFlags: ctx.permissions.has("config.feature_flag.write"),
    }} /> }),
  item({ id: "generation/recipes", label: "Prompt Recipes", href: "/admin/ops/recipes", icon: ScrollText, group: "Platform Operations", read: read("generation.config.read"),
    render: (ctx) => <RecipesSection view={ctx.view} /> }),
  item({ id: "generation/presets", label: "Presets", href: "/admin/ops/recipes?view=presets", icon: Layers, group: "Platform Operations", read: read("generation.config.read"),
    render: (ctx) => <PresetsSection view={ctx.view} /> }),
  item({ id: "generation/workflows", label: "Workflow Diagnostics", href: "/admin/ops/recipes?view=workflows", icon: Workflow, group: "Platform Operations", read: read("generation.config.read"),
    render: () => <WorkflowsView /> }),
  item({ id: "chat", label: "Chat Operations", href: "/admin/ops/chat", icon: MessageSquare, group: "Platform Operations", read: read("chat.ops.read"),
    render: (ctx) => <ChatOpsWorkspace
      canRead={ctx.permissions.has("chat.ops.read")}
      canReadMainOutbox={adminV2OperationAllowed(
        "GET /api/v2/admin/chat/main-outbox-events",
        ctx.permissions,
      )}
      canReplayMainOutbox={adminV2OperationAllowed(
        "POST /api/v2/admin/chat/main-outbox-events/commands/replay",
        ctx.permissions,
      )}
      canDiscardMissingMainOutbox={adminV2OperationAllowed(
        "POST /api/v2/admin/chat/main-outbox-events/commands/discard-target-missing",
        ctx.permissions,
      )}
    /> }),

  item({ id: "approvals", label: "Approvals", href: "/admin/system/approvals", icon: ClipboardCheck, group: "System", read: read("admin.approval.review"),
    render: (ctx) => <ApprovalsWorkspace canReview={ctx.permissions.has("admin.approval.review")} /> }),
  item({ id: "system/access", label: "Team Access", href: "/admin/system/access", icon: Users, group: "System", read: read("user.read"),
    render: (ctx) => <AccessWorkspace permissions={{
      changeStatus: ctx.permissions.has("user.status.write"),
      managePermissions: ctx.permissions.has("user.role.write"),
    }} /> }),
  item({ id: "audit-log", label: "Audit Log", href: "/admin/system/audit", icon: History, group: "System", read: read("audit.read"),
    render: () => <AuditWorkspace /> }),
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

// SPEC: 冷启动（还没有 openNavGroups cookie）时侧栏默认展开哪些折叠分组。
// INTENT: 之前默认全折叠——新运营打开后台只看得见「今日工作」一条加六个不知道里面装什么的
//         分组标题，34 个能力一个都不露，渐进披露用过了头。工作模式本来就声明了"这个人整天
//         在干什么"，就按它展开首要分组，再加上当前页所在的分组：冷启动即可上手，侧栏又不至于
//         长到必须滚动才能看全。剩下的分组仍是一次点击的距离。
export function defaultOpenNavGroups(mode: WorkMode, activeGroup: AdminWorkspace): AdminWorkspace[] {
  // "Today" 是固定在顶部、不带分组标题的常驻区，展开它没有意义。
  const groups = new Set<AdminWorkspace>();
  const primary = MODE_GROUP_ORDER[mode].find((group) => group !== "Today");
  if (primary) groups.add(primary);
  if (activeGroup !== "Today") groups.add(activeGroup);
  return [...groups];
}

export function defaultWorkModeForRole(role: string | undefined): WorkMode {
  if (role === "support") return "support";
  if (role === "moderator") return "moderator";
  if (role === "ops") return "platform_ops";
  if (role === "analyst") return "growth_analyst";
  return "admin";
}

export function sectionIsPermitted(sectionId: string, permissions: ReadonlySet<AdminPermissionKey>) {
  const navItem = SECTION_BY_ID.get(sectionId);
  return Boolean(navItem && canReadWorkspace(navItem, permissions));
}

export function canReadWorkspace(navItem: NavItem, permissions: ReadonlySet<AdminPermissionKey>) {
  return navItem.read.allOf.every((permission) => permissions.has(permission));
}

// SPEC: 这个工作台还差哪些 read 键——原样返回 read.allOf 里当前没有的那几个。
// INTENT: 拒绝页原先只说"你的有效权限键不包含此能力"，运营既不知道差什么、也不知道找谁，
//         唯一能做的就是关掉页面。差哪几个键是能从导航契约里如实算出来的，就必须说出来；
//         至于"为什么没有"、"该找谁批"——前端推不出来，也就一个字都不编。
export function missingWorkspacePermissions(
  navItem: NavItem,
  permissions: ReadonlySet<AdminPermissionKey>,
): AdminPermissionKey[] {
  return navItem.read.allOf.filter((permission) => !permissions.has(permission));
}

export function canReadAnyWorkspace(permissions: ReadonlySet<AdminPermissionKey>) {
  return ALL_SECTION_ITEMS.some((navItem) => canReadWorkspace(navItem, permissions));
}

export function navGroupsForPermissions(permissions: ReadonlySet<AdminPermissionKey>, mode: WorkMode) {
  return MODE_GROUP_ORDER[mode]
    .map((group) => ({
      group,
      items: navItems.filter(
        (navItem) => navItem.group === group && canReadWorkspace(navItem, permissions),
      ),
    }))
    .filter(({ items }) => items.length > 0);
}

// These routes retain command parity while their Case equivalents are incomplete.
// They stay out of primary navigation but remain directly addressable for saved links
// and legacy operators; production traffic telemetry decides their eventual sunset.
const HIDDEN_COMPATIBILITY_ITEMS: NavItem[] = [
  item({ id: "moderation", label: "Moderation Cases", href: "/admin/moderation", icon: ShieldAlert, group: "Customer Operations", read: read("safety.review.read"),
    render: (ctx) => <ModerationWorkspace canDecide={ctx.permissions.has("safety.review.write")} /> }),
  item({ id: "support", label: "Support Cases", href: "/admin/support", icon: Ticket, group: "Customer Operations", read: read("support.request.read"),
    render: (ctx) => <SupportWorkspace
      canViewPlaintext={ctx.permissions.has("support.plaintext.view")}
      canWrite={ctx.permissions.has("support.request.write")}
    /> }),
  item({ id: "risk", label: "Risk Cases", href: "/admin/risk", icon: ShieldAlert, group: "Customer Operations", read: read("billing.read"),
    render: (ctx) => <RiskWorkspace canRead={ctx.permissions.has("billing.read")} /> }),
];

// 隐藏的兼容项仍是可直达的目的地，命名规则跟导航里的项一视同仁。
export const ALL_SECTION_ITEMS = [...navItems, ...HIDDEN_COMPATIBILITY_ITEMS];
const SECTION_BY_ID = new Map(ALL_SECTION_ITEMS.map((navItem) => [navItem.id, navItem]));
const SECTION_ALIASES: Record<string, string> = {
  "generation/models": "generation/config",
};

export type AdminSubview =
  | { kind: "list" }
  | { kind: "new" }
  | { kind: "detail"; id: string };

// SPEC: 解析结果直接携带 NavItem 本身，而不是一个还要再查一次表的 sectionId。
// INTENT: 之前解析出字符串 id、再由 adminSectionItem() 查回导航项，查不到就 `?? navItems[0]`
//         静默落到 Today。解析即解析成对象后，这个兜底无处可写，也就不可能再发生。
export type AdminPath = { item: NavItem; view: AdminSubview };

function detailId(view: AdminSubview) {
  return view.kind === "detail" ? view.id : null;
}

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

type SectionMatch = { sectionId: string; view: AdminSubview };

function canonicalSection(path: string, query: URLSearchParams): SectionMatch | null {
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

function matchAdminPath(value: string): SectionMatch | null {
  const [rawPath = "", rawQuery = ""] = value.split("?", 2);
  const path = rawPath.replace(/^\/+|\/+$/g, "");
  const canonical = canonicalSection(path, new URLSearchParams(rawQuery));
  if (canonical) return canonical;

  const mapped = SECTION_ALIASES[path] ?? path;
  if (SECTION_BY_ID.has(mapped)) return { sectionId: mapped, view: { kind: "list" } };
  const segments = mapped.split("/").filter(Boolean);
  if (segments.length >= 2) {
    const last = segments.at(-1) ?? "";
    const prefixRaw = segments.slice(0, -1).join("/");
    const prefix = SECTION_ALIASES[prefixRaw] ?? prefixRaw;
    if (LEGACY_SUBVIEW_SECTIONS.has(prefix) && SECTION_BY_ID.has(prefix) && last) {
      return last === "new"
        ? { sectionId: prefix, view: { kind: "new" } }
        : { sectionId: prefix, view: { kind: "detail", id: last } };
    }
  }
  return null;
}

// SPEC: 认得的路径解析成 { 导航项, 子视图 }；认不得就是 null —— 由路由层 notFound()。
// INTENT: 这里曾经 `return { sectionId: "dashboard" }` 兜底，于是任何拼错的 URL 都会
//         安静地显示 Today，页面本身还回 200；not-found.tsx 写好了却永远到不了。
export function parseAdminPath(value: string): AdminPath | null {
  const match = matchAdminPath(value);
  if (!match) return null;
  const navItem = SECTION_BY_ID.get(match.sectionId);
  return navItem ? { item: navItem, view: match.view } : null;
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
