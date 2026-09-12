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
  ListChecks,
  Library,
  MessageSquare,
  Play,
  ScrollText,
  Server,
  Settings,
  ShieldAlert,
  UserRound,
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
import {
  matchAdminRoute,
  type AdminSectionId,
  type AdminSubview,
} from "./nav-routes";

// 子视图与 section id 的定义住在 nav-routes.ts（proxy 也要用，那里不能碰 React）；
// 这里转出去，各 section 的 import 路径不必改。
export type { AdminSectionId, AdminSubview };
import type { AdminPermissionKey } from "@idream/shared/admin/permissions";
import { BackendsView } from "@/components/admin/BackendsView";
import { GenerationMetricsView } from "@/components/admin/GenerationMetricsView";
import { WorkflowsView } from "@/components/admin/WorkflowsView";
import { StartersSection } from "@/components/admin/starters/StartersSection";
import { RecipesSection } from "@/components/admin/recipes/RecipesSection";
import { PresetsSection } from "@/components/admin/presets/PresetsSection";
import { AssetsSection } from "@/components/admin/assets/AssetsSection";
import { TagsView } from "@/components/admin/TagsView";
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
import { InvariantsWorkspace } from "@/features/reconciliation/InvariantsWorkspace";
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
  "Characters",
  "Content Operations",
  "Customers & Support",
  "Revenue & Marketing",
  "Analytics",
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
  id: AdminSectionId;
  label: string;
  href: string;
  legacyHref: string | null;
  icon: LucideIcon;
  group: AdminWorkspace;
  read: { allOf: readonly AdminPermissionKey[] };
  apiWorkspace: AdminV2WorkspaceAccessKey | null;
  // SPEC: 入口只有三层：跨工作区常驻、区内常规任务、区内低频工具。
  // INTENT: 用一个互斥枚举表达信息层级，避免多个布尔值组合出「既常驻又是低频工具」之类的无效状态。
  navigation: "primary" | "workspace" | "tool";
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

type ItemInput = Omit<NavItem, "apiWorkspace" | "legacyHref" | "chrome" | "navigation"> & {
  apiWorkspace?: AdminV2WorkspaceAccessKey;
  chrome?: NavItem["chrome"];
  navigation?: NavItem["navigation"];
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
    navigation: input.navigation ?? "workspace",
  };
}

function targetItem(input: ItemInput): NavItem {
  return {
    ...input,
    apiWorkspace: input.apiWorkspace ?? null,
    chrome: input.chrome ?? "default",
    legacyHref: null,
    navigation: input.navigation ?? "workspace",
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

// SSoT for the migration shell. `id` remains the legacy implementation key so every
// shipped capability stays reachable; `href` is the canonical decision-workspace URL.
// Permissions are existing effective keys, not client-side role guesses.
export const navItems: NavItem[] = [
  apiItem({ id: "dashboard", label: "Today", href: "/admin/today", icon: Gauge, group: "Today", apiWorkspace: "today", navigation: "primary",
    render: (ctx) => <TodayWorkspace workMode={ctx.workMode} /> }),

  apiItem({ id: "content/official", label: "Characters", href: "/admin/characters", icon: UserRound, group: "Characters", apiWorkspace: "character_workspace", chrome: "compact",
    render: (ctx) => <CharacterWorkspace actorId={ctx.actorId} permissions={ctx.permissions} view={ctx.view} /> }),
  item({ id: "content/templates", label: "Character Starters", href: "/admin/characters/starters", icon: Sparkles, group: "Characters", read: read("content.read"),
    render: (ctx) => <StartersSection view={ctx.view} /> }),
  item({ id: "content/tags", label: "Taxonomy", href: "/admin/characters/taxonomy", icon: Flag, group: "Characters", read: read("content.read"),
    render: () => <TagsView /> }),

  item({ id: "content/assets", label: "Operational Assets", href: "/admin/creative/library", icon: ImageIcon, group: "Content Operations", read: read("creative.asset.read"),
    render: (ctx) => <AssetsSection canReview={ctx.permissions.has("content.asset.review")} view={ctx.view} /> }),
  item({ id: "content/placements", label: "Placements", href: "/admin/creative/placements", icon: Bookmark, group: "Content Operations", read: read("creative.placement.read"),
    render: (ctx) => <PlacementsSection canPublish={ctx.permissions.has("creative.placement.publish")} view={ctx.view} /> }),
  apiItem({ id: "content/production", label: "Generation History", href: "/admin/creative/runs", icon: Play, group: "Content Operations", apiWorkspace: "creative_runs", navigation: "tool",
    render: (ctx) => <CreativeRunWorkspace actorId={ctx.actorId} permissions={{
      read: ctx.canRead,
      write: ctx.permissions.has("creative.run.write"),
      review: ctx.permissions.has("creative.run.review"),
      place: ctx.permissions.has("creative.placement.publish"),
      manageIncident: ctx.permissions.has("ops.incident.manage"),
    }} view={ctx.view} /> }),

  apiItem({ id: "cases", label: "Cases", href: "/admin/cases?view=mine", icon: Ticket, group: "Customers & Support", apiWorkspace: "cases",
    render: (ctx) => <CaseWorkspace
      canAssign={ctx.permissions.has("case.assign")}
      canDecide={ctx.permissions.has("case.decide")}
      initialCaseId={detailId(ctx.view)}
      key={detailId(ctx.view) ?? "case-list"}
    /> }),
  apiItem({ id: "users", label: "Customers", href: "/admin/customers", icon: Users, group: "Customers & Support", apiWorkspace: "customers",
    render: (ctx) => <CustomerWorkspace initialCustomerId={detailId(ctx.view)} /> }),
  item({ id: "billing", label: "Orders & Billing", href: "/admin/customer-ops/billing", icon: BadgeDollarSign, group: "Revenue & Marketing", read: read("billing.read"),
    render: (ctx) => <BillingWorkspace
      canAdjust={ctx.permissions.has("billing.ledger.adjust")}
      canReconcile={ctx.permissions.has("billing.checkout.reconcile")}
      canRefund={ctx.permissions.has("billing.subscription.refund")}
    /> }),
  item({ id: "compliance", label: "Account Requests", href: "/admin/customer-ops/account-requests", icon: ShieldAlert, group: "Customers & Support", read: read("compliance.read"),
    render: () => <ComplianceView /> }),

  apiItem({ id: "analytics", label: "Product Health", href: "/admin/growth/health", icon: BarChart3, group: "Analytics", apiWorkspace: "metrics",
    render: (ctx) => <AnalyticsWorkspace
      canReadCanonical={ctx.canRead}
      canReadLegacy={ctx.permissions.has("analytics.export")}
    /> }),
  apiTargetItem({ id: "growth/characters", label: "Character Performance", href: "/admin/growth/characters", icon: Activity, group: "Analytics", apiWorkspace: "character_performance",
    render: (ctx) => <CharacterPerformanceWorkspace permissions={ctx.permissions} /> }),
  apiItem({ id: "experiments", label: "Experiments", href: "/admin/growth/experiments", icon: Flag, group: "Analytics", apiWorkspace: "experiments",
    render: () => <ExperimentsView /> }),
  item({ id: "content", label: "Featured Merchandising", href: "/admin/growth/merchandising?view=featured", icon: Library, group: "Content Operations", read: read("content.read"),
    render: (ctx) => <ContentMerchandisingWorkspace canWrite={ctx.permissions.has("content.takedown.write")} /> }),
  item({ id: "announcements", label: "Announcements", href: "/admin/growth/merchandising?view=announcements", icon: MessageSquare, group: "Content Operations", read: read("growth.promo.read"),
    render: () => <AnnouncementsView /> }),
  item({ id: "cms", label: "Site Content & SEO", href: "/admin/growth/content", icon: FileText, group: "Content Operations", read: read("content.read"),
    render: (ctx) => <CmsView canWrite={ctx.permissions.has("content.cms.write")} /> }),
  item({ id: "pricing", label: "Pricing", href: "/admin/growth/offers?view=pricing", icon: Coins, group: "Revenue & Marketing", read: read("billing.read"),
    render: (ctx) => <PricingWorkspace canWrite={ctx.permissions.has("config.pricing.write")} /> }),
  item({ id: "promo", label: "Promotions", href: "/admin/growth/offers?view=promo", icon: Ticket, group: "Revenue & Marketing", read: read("growth.promo.read"),
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
  // SPEC: 跨表一致性是运维的一等公民 —— 它和事故并列，因为它回答的正是「有没有事故还没被
  //       任何人发现」。targetItem：id 与 href 同形，不需要再造一条同名的 legacy 别名。
  // INTENT: 权威早就在算这 31 条检查（reconciliation/invariants，实测 17 条违规、
  //         decisionUse=blocked），此前整个控制台零引用 —— 结论算出来却没有任何一页显示它。
  targetItem({ id: "ops/invariants", label: "Data Integrity", href: "/admin/ops/invariants", icon: ListChecks, group: "Platform Operations", read: read("analytics.metric.read"),
    render: (ctx) => <InvariantsWorkspace canRead={ctx.canRead} /> }),
  apiItem({ id: "generation/jobs", label: "Generation Jobs", href: "/admin/ops/jobs", icon: Activity, group: "Platform Operations", apiWorkspace: "generation_jobs",
    render: () => <GenerationJobsWorkspace /> }),
  item({ id: "generation/dead-letter", label: "Dead-letter", href: "/admin/ops/jobs?view=dead-letter", icon: Inbox, group: "Platform Operations", read: read("ops.queue.read"), navigation: "tool",
    render: (ctx) => <DeadLetterWorkspace permissions={{
      requeue: ctx.permissions.has("generation.job.requeue"),
      discard: ctx.permissions.has("ops.deadletter.write"),
    }} /> }),
  item({ id: "ops/providers", label: "Providers", href: "/admin/ops/providers", icon: Gauge, group: "Platform Operations", read: read("ops.queue.read"),
    render: (ctx) => <ProviderOverviewWorkspace canRead={ctx.permissions.has("ops.queue.read")} /> }),
  item({ id: "generation/backends", label: "Backend Diagnostics", href: "/admin/ops/providers?view=backends", icon: Server, group: "Platform Operations", read: read("ops.queue.read"), navigation: "tool",
    render: () => <BackendsView /> }),
  item({ id: "generation/metrics", label: "Generation Health", href: "/admin/ops/providers?view=generation-metrics", icon: BarChart3, group: "Platform Operations", read: read("ops.queue.read"), navigation: "tool",
    render: () => <GenerationMetricsView /> }),
  // SPEC: 这一页按 model-profile id 查健康度、跑不调 provider 的配置检查。
  // INTENT: 它过去叫「Funnels & Retention」、挂在 Growth 下，但页面里既没有漏斗也没有 cohort
  //         ——不是渲染缺口，是数据契约里就没有这两样。名字承诺了不存在的东西，增长分析师
  //         点进去只会看到一条「retention unavailable」和一个要手敲 UUID 的运维工具。
  //         按页面真正提供的能力改名，并归到它受众所在的分组：读它的是平台运维，不是增长。
  //         和邻居 Backend / Workflow Diagnostics 是同一族命名。
  // INVARIANT: href 保持 /admin/growth/funnels —— 换 URL 会废掉现有书签，而这一轮只改元数据。
  apiItem({ id: "insights", label: "Profile Diagnostics", href: "/admin/growth/funnels", icon: BarChart3, group: "Platform Operations", apiWorkspace: "metrics", navigation: "tool",
    render: () => <InsightsView /> }),
  item({ id: "generation/config", label: "Profiles & Rollout", href: "/admin/ops/profiles", icon: SlidersHorizontal, group: "Platform Operations", read: read("generation.config.read", "ops.queue.read", "generation.job.read"),
    render: (ctx) => <GenerationConfigWorkspace permissions={{
      manageProfiles: ctx.permissions.has("generation.config.write"),
      manageFlags: ctx.permissions.has("config.feature_flag.write"),
    }} /> }),
  item({ id: "generation/recipes", label: "Prompt Recipes", href: "/admin/ops/recipes", icon: ScrollText, group: "Platform Operations", read: read("generation.config.read"),
    render: (ctx) => <RecipesSection view={ctx.view} /> }),
  item({ id: "generation/presets", label: "Presets", href: "/admin/ops/recipes?view=presets", icon: Layers, group: "Platform Operations", read: read("generation.config.read"), navigation: "tool",
    render: (ctx) => <PresetsSection view={ctx.view} /> }),
  item({ id: "generation/workflows", label: "Workflow Diagnostics", href: "/admin/ops/recipes?view=workflows", icon: Workflow, group: "Platform Operations", read: read("generation.config.read"), navigation: "tool",
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

// 分组身份不依赖首个可读页面；权限变化不能改变图标或偷偷改变点击目的地。
export const WORKSPACE_ICONS: Record<AdminWorkspace, LucideIcon> = {
  Today: Gauge,
  Characters: UserRound,
  "Content Operations": ImageIcon,
  "Customers & Support": Users,
  "Revenue & Marketing": Coins,
  Analytics: BarChart3,
  "Platform Operations": Server,
  System: Settings,
};

// 默认按业务任务排序。专业工作模式只将相关任务提前，永远不改变授权集合。
const MODE_GROUP_ORDER: Record<WorkMode, readonly AdminWorkspace[]> = {
  admin: ADMIN_WORKSPACES,
  character_producer: ADMIN_WORKSPACES,
  creative_operator: ["Today", "Content Operations", "Characters", "Customers & Support", "Revenue & Marketing", "Analytics", "Platform Operations", "System"],
  platform_ops: ["Today", "Platform Operations", "Characters", "Content Operations", "Customers & Support", "Revenue & Marketing", "Analytics", "System"],
  support: ["Today", "Customers & Support", "Revenue & Marketing", "Characters", "Content Operations", "Analytics", "Platform Operations", "System"],
  moderator: ["Today", "Customers & Support", "Characters", "Content Operations", "Revenue & Marketing", "Analytics", "Platform Operations", "System"],
  growth_analyst: ["Today", "Analytics", "Characters", "Content Operations", "Revenue & Marketing", "Customers & Support", "Platform Operations", "System"],
};

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

export function navGroupsForPermissions(
  permissions: ReadonlySet<AdminPermissionKey>,
  mode: WorkMode,
) {
  // SPEC: 工作模式只排序分组，不能成为权限之外的第二套功能可见性门槛。
  // INVARIANT: 包括兼容工具在内，每个满足 read.allOf 的目的地都进入所属工作区；
  //            shell 再展示分组、常规页面与低频工具，不靠搜索或记 URL 补洞。
  return MODE_GROUP_ORDER[mode]
    .map((group) => ({
      group,
      items: ALL_SECTION_ITEMS.filter(
        (navItem) => navItem.group === group
          && canReadWorkspace(navItem, permissions),
      ),
    }))
    .filter(({ items }) => items.length > 0);
}

// These routes retain command parity while their Case equivalents are incomplete.
// They do not become global destinations, but they do appear inside Customer Operations:
// a necessary compatibility tool must be discoverable without pretending it is a new workspace.
// Production traffic telemetry decides their eventual sunset.
const COMPATIBILITY_ITEMS: NavItem[] = [
  item({ id: "moderation", label: "Moderation Cases", href: "/admin/moderation", icon: ShieldAlert, group: "Customers & Support", read: read("safety.review.read"), navigation: "tool",
    render: (ctx) => <ModerationWorkspace canDecide={ctx.permissions.has("safety.review.write")} canReadComics={ctx.permissions.has("content.asset.read")} canReviewComics={ctx.permissions.has("safety.review.write")} /> }),
  item({ id: "support", label: "Support Cases", href: "/admin/support", icon: Ticket, group: "Customers & Support", read: read("support.request.read"), navigation: "tool",
    render: (ctx) => <SupportWorkspace
      canViewPlaintext={ctx.permissions.has("support.plaintext.view")}
      canWrite={ctx.permissions.has("support.request.write")}
    /> }),
  item({ id: "risk", label: "Risk Cases", href: "/admin/risk", icon: ShieldAlert, group: "Customers & Support", read: read("billing.read"), navigation: "tool",
    render: (ctx) => <RiskWorkspace canRead={ctx.permissions.has("billing.read")} /> }),
];

// 兼容项仍是可直达的目的地，命名规则跟正式项一视同仁。
export const ALL_SECTION_ITEMS = [...navItems, ...COMPATIBILITY_ITEMS];
const SECTION_BY_ID: ReadonlyMap<string, NavItem> = new Map(
  ALL_SECTION_ITEMS.map((navItem) => [navItem.id, navItem]),
);
function detailId(view: AdminSubview) {
  return view.kind === "detail" ? view.id : null;
}

// SPEC: 解析结果直接携带 NavItem 本身，而不是一个还要再查一次表的 sectionId。
// INTENT: 之前解析出字符串 id、再由 adminSectionItem() 查回导航项，查不到就 `?? navItems[0]`
//         静默落到 Today。解析即解析成对象后，这个兜底无处可写，也就不可能再发生。
export type AdminPath = { item: NavItem; view: AdminSubview };

// SPEC: 认得的路径解析成 { 导航项, 子视图 }；认不得就是 null —— 由路由层 notFound()，
//       状态码则由 src/proxy.ts 在流式输出开始之前定成 404。
export function parseAdminPath(value: string): AdminPath | null {
  const match = matchAdminRoute(value);
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
