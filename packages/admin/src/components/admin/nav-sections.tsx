"use client";

import dynamic from "next/dynamic";
import type { ReactNode } from "react";
import { adminV2OperationAllowed } from "@/lib/admin-v2-operation";
import { useAdminI18n } from "./i18n";
import type { AdminSectionId, AdminSubview, SectionContext } from "./nav-config";

// SPEC: 每个目的地的渲染方式与它的代码分包都在这里；一页只下载自己那个工作台。
// INVARIANT: Record<AdminSectionId, …> 是"新增导航项必须同时配好组件"的唯一强制点——漏了就是
//            编译错误，而不是在 if 链末尾静默落到别的页面。
// INVARIANT: 只有 "use client" 的 shell 能 import 本文件。服务端一旦 import，RSC 图会把这些工作台
//            全部登记成客户端入口，分包当场失效（next/dynamic 的文档也写明服务端不做自动分包）。
//            source-boundary.test.ts 守这条。
// NOTE: dynamic() 的第一个参数必须内联写 import()，封一层 helper 后 Next 就认不出来了，
//       没法做 SSR 预加载——所以下面才是逐条写，而不是循环生成。
function SectionLoading() {
  const { t } = useAdminI18n();
  return (
    <div aria-busy="true" className="animate-pulse" role="status">
      <span className="sr-only">{t("Loading…")}</span>
      <div className="h-64 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)]" />
    </div>
  );
}

const TodayWorkspace = dynamic(() => import("./today/TodayWorkspace").then((m) => m.TodayWorkspace), { loading: SectionLoading });
const CharacterWorkspace = dynamic(() => import("@/features/characters/CharacterWorkspace").then((m) => m.CharacterWorkspace), { loading: SectionLoading });
const CharacterPerformanceWorkspace = dynamic(() => import("@/features/characters/CharacterWorkspace").then((m) => m.CharacterPerformanceWorkspace), { loading: SectionLoading });
const StartersSection = dynamic(() => import("./starters/StartersSection").then((m) => m.StartersSection), { loading: SectionLoading });
const TagsView = dynamic(() => import("./TagsView").then((m) => m.TagsView), { loading: SectionLoading });
const AssetsSection = dynamic(() => import("./assets/AssetsSection").then((m) => m.AssetsSection), { loading: SectionLoading });
const PlacementsSection = dynamic(() => import("./placements/PlacementsSection").then((m) => m.PlacementsSection), { loading: SectionLoading });
const CreativeRunWorkspace = dynamic(() => import("@/features/creative/CreativeRunWorkspace").then((m) => m.CreativeRunWorkspace), { loading: SectionLoading });
const CaseWorkspace = dynamic(() => import("@/features/cases/CaseWorkspace").then((m) => m.CaseWorkspace), { loading: SectionLoading });
const CustomerWorkspace = dynamic(() => import("@/features/customers/CustomerWorkspace").then((m) => m.CustomerWorkspace), { loading: SectionLoading });
const BillingWorkspace = dynamic(() => import("@/features/billing/BillingWorkspace").then((m) => m.BillingWorkspace), { loading: SectionLoading });
const ComplianceView = dynamic(() => import("./ComplianceView").then((m) => m.ComplianceView), { loading: SectionLoading });
const AnalyticsWorkspace = dynamic(() => import("@/features/overviews/OverviewWorkspaces").then((m) => m.AnalyticsWorkspace), { loading: SectionLoading });
const ProviderOverviewWorkspace = dynamic(() => import("@/features/overviews/OverviewWorkspaces").then((m) => m.ProviderOverviewWorkspace), { loading: SectionLoading });
const RiskWorkspace = dynamic(() => import("@/features/overviews/OverviewWorkspaces").then((m) => m.RiskWorkspace), { loading: SectionLoading });
const ExperimentsView = dynamic(() => import("./ExperimentsView").then((m) => m.ExperimentsView), { loading: SectionLoading });
const ContentMerchandisingWorkspace = dynamic(() => import("@/features/content-merchandising/ContentMerchandisingWorkspace").then((m) => m.ContentMerchandisingWorkspace), { loading: SectionLoading });
const AnnouncementsView = dynamic(() => import("./AnnouncementsView").then((m) => m.AnnouncementsView), { loading: SectionLoading });
const CmsView = dynamic(() => import("./CmsView").then((m) => m.CmsView), { loading: SectionLoading });
const PricingWorkspace = dynamic(() => import("@/features/pricing/PricingWorkspace").then((m) => m.PricingWorkspace), { loading: SectionLoading });
const AffiliateApplicationsView = dynamic(() => import("./AffiliateApplicationsView").then((m) => m.AffiliateApplicationsView), { loading: SectionLoading });
const PromoWorkspace = dynamic(() => import("@/features/promo/PromoWorkspace").then((m) => m.PromoWorkspace), { loading: SectionLoading });
const IncidentWorkspace = dynamic(() => import("@/features/incidents/IncidentWorkspace").then((m) => m.IncidentWorkspace), { loading: SectionLoading });
const InvariantsWorkspace = dynamic(() => import("@/features/reconciliation/InvariantsWorkspace").then((m) => m.InvariantsWorkspace), { loading: SectionLoading });
const GenerationJobsWorkspace = dynamic(() => import("@/features/jobs/JobsView").then((m) => m.JobsView), { loading: SectionLoading });
const DeadLetterWorkspace = dynamic(() => import("@/features/dead-letter/DeadLetterWorkspace").then((m) => m.DeadLetterWorkspace), { loading: SectionLoading });
const BackendsView = dynamic(() => import("./BackendsView").then((m) => m.BackendsView), { loading: SectionLoading });
const GenerationMetricsView = dynamic(() => import("./GenerationMetricsView").then((m) => m.GenerationMetricsView), { loading: SectionLoading });
const InsightsView = dynamic(() => import("./InsightsView").then((m) => m.InsightsView), { loading: SectionLoading });
const GenerationConfigWorkspace = dynamic(() => import("@/features/config/GenerationConfigWorkspace").then((m) => m.GenerationConfigWorkspace), { loading: SectionLoading });
const RecipesSection = dynamic(() => import("./recipes/RecipesSection").then((m) => m.RecipesSection), { loading: SectionLoading });
const PresetsSection = dynamic(() => import("./presets/PresetsSection").then((m) => m.PresetsSection), { loading: SectionLoading });
const WorkflowsView = dynamic(() => import("./WorkflowsView").then((m) => m.WorkflowsView), { loading: SectionLoading });
const ChatOpsWorkspace = dynamic(() => import("@/features/chat-ops/ChatOpsWorkspace").then((m) => m.ChatOpsWorkspace), { loading: SectionLoading });
const ApprovalsWorkspace = dynamic(() => import("@/features/approvals/ApprovalsWorkspace").then((m) => m.ApprovalsWorkspace), { loading: SectionLoading });
const AccessWorkspace = dynamic(() => import("@/features/access/AccessWorkspace").then((m) => m.AccessWorkspace), { loading: SectionLoading });
const AuditWorkspace = dynamic(() => import("@/features/audit/AuditWorkspace").then((m) => m.AuditWorkspace), { loading: SectionLoading });
const ModerationWorkspace = dynamic(() => import("@/features/moderation/ModerationWorkspace").then((m) => m.ModerationWorkspace), { loading: SectionLoading });
const SupportWorkspace = dynamic(() => import("@/features/support/SupportWorkspace").then((m) => m.SupportWorkspace), { loading: SectionLoading });

function detailId(view: AdminSubview) {
  return view.kind === "detail" ? view.id : null;
}

const SECTION_RENDERERS: Record<AdminSectionId, (ctx: SectionContext) => ReactNode> = {
  dashboard: (ctx) => <TodayWorkspace workMode={ctx.workMode} />,

  "content/official": (ctx) => <CharacterWorkspace actorId={ctx.actorId} canCreateCharacters={ctx.canCreateCharacters} permissions={ctx.permissions} view={ctx.view} />,
  "content/templates": (ctx) => <StartersSection
    canAssist={ctx.permissions.has("content.official.write")}
    canWrite={ctx.permissions.has("content.template.write")}
    view={ctx.view}
  />,
  "content/tags": (ctx) => <TagsView canWrite={ctx.permissions.has("content.tag.write")} />,

  "content/assets": (ctx) => <AssetsSection canReview={ctx.permissions.has("content.asset.review")} view={ctx.view} />,
  "content/placements": (ctx) => <PlacementsSection canPublish={ctx.permissions.has("creative.placement.publish")} view={ctx.view} />,
  "content/production": (ctx) => <CreativeRunWorkspace actorId={ctx.actorId} permissions={{
    read: ctx.canRead,
    write: ctx.permissions.has("creative.run.write"),
    review: ctx.permissions.has("creative.run.review"),
    place: ctx.permissions.has("creative.placement.publish"),
    manageIncident: adminV2OperationAllowed("POST /api/v2/admin/creative/runs/:id/commands/attach-incident", ctx.permissions),
  }} view={ctx.view} />,

  cases: (ctx) => <CaseWorkspace
    actorId={ctx.actorId}
    canAssign={ctx.permissions.has("case.assign")}
    canDecide={ctx.permissions.has("case.decide")}
    canReadSupport={ctx.permissions.has("support.request.read")}
    canReplySupport={ctx.permissions.has("support.request.write")}
    canViewPlaintext={ctx.permissions.has("support.plaintext.view")}
    initialCaseId={detailId(ctx.view)}
    key={detailId(ctx.view) ?? "case-list"}
  />,
  users: (ctx) => <CustomerWorkspace initialCustomerId={detailId(ctx.view)} />,
  billing: (ctx) => <BillingWorkspace
    canAdjust={ctx.permissions.has("billing.ledger.adjust")}
    canReconcile={ctx.permissions.has("billing.checkout.reconcile")}
    canRefund={ctx.permissions.has("billing.subscription.refund")}
  />,
  compliance: (ctx) => <ComplianceView canWrite={ctx.permissions.has("compliance.write")} />,

  analytics: (ctx) => <AnalyticsWorkspace
    canReadCanonical={ctx.canRead}
    canReadLegacy={ctx.permissions.has("analytics.export")}
  />,
  "growth/characters": (ctx) => <CharacterPerformanceWorkspace permissions={ctx.permissions} />,
  experiments: (ctx) => <ExperimentsView canReadFlagMonitoring={adminV2OperationAllowed("GET /api/v2/admin/analytics/flag-monitoring", ctx.permissions)} />,
  content: (ctx) => <ContentMerchandisingWorkspace canCurate={ctx.permissions.has("content.featured.write")} canWrite={ctx.permissions.has("content.takedown.write")} />,
  announcements: (ctx) => <AnnouncementsView canWrite={ctx.permissions.has("growth.promo.write")} />,
  cms: (ctx) => <CmsView canWrite={ctx.permissions.has("content.cms.write")} />,
  pricing: (ctx) => <PricingWorkspace canWrite={ctx.permissions.has("config.pricing.write")} />,
  "growth/affiliates": (ctx) => <AffiliateApplicationsView canWrite={adminV2OperationAllowed("POST /api/v2/admin/affiliate/applications/:id/decision", ctx.permissions)} />,
  promo: (ctx) => <PromoWorkspace canWrite={ctx.permissions.has("growth.promo.write")} />,

  "ops/incidents": (ctx) => <IncidentWorkspace
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
  />,
  "ops/invariants": (ctx) => <InvariantsWorkspace canRead={ctx.canRead} />,
  "generation/jobs": (ctx) => <GenerationJobsWorkspace permissions={{
    retry: adminV2OperationAllowed("POST /api/v2/admin/jobs/:id/commands/retry", ctx.permissions),
    cancel: adminV2OperationAllowed("POST /api/v2/admin/generation/requests/:id/commands/cancel", ctx.permissions),
    reconcile: adminV2OperationAllowed("POST /api/v2/admin/jobs/:id/commands/reconcile-unknown", ctx.permissions),
  }} />,
  "generation/dead-letter": (ctx) => <DeadLetterWorkspace permissions={{
    requeue: ctx.permissions.has("generation.job.requeue"),
    discard: ctx.permissions.has("ops.deadletter.write"),
  }} />,
  "ops/providers": (ctx) => <ProviderOverviewWorkspace canRead={ctx.permissions.has("ops.queue.read")} />,
  "generation/backends": () => <BackendsView />,
  "generation/metrics": () => <GenerationMetricsView />,
  insights: (ctx) => <InsightsView canWrite={adminV2OperationAllowed("POST /api/v2/admin/generation/model-profiles/:id/commands/dry-run", ctx.permissions)} />,
  "generation/config": (ctx) => <GenerationConfigWorkspace permissions={{
    manageProfiles: ctx.permissions.has("generation.config.write"),
    manageFlags: ctx.permissions.has("config.feature_flag.write"),
  }} />,
  "generation/recipes": (ctx) => <RecipesSection canWrite={ctx.permissions.has("generation.config.write")} view={ctx.view} />,
  "generation/presets": (ctx) => <PresetsSection canWrite={ctx.permissions.has("generation.config.write")} view={ctx.view} />,
  "generation/workflows": () => <WorkflowsView />,
  chat: (ctx) => <ChatOpsWorkspace
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
    canMigrateSessionRelease={adminV2OperationAllowed(
      "POST /api/v2/admin/chat/sessions/:sessionId/commands/migrate-release",
      ctx.permissions,
    )}
  />,

  approvals: (ctx) => <ApprovalsWorkspace actorId={ctx.actorId} canReview={ctx.permissions.has("admin.approval.review")} canToggleEnforcement={ctx.permissions.has("config.feature_flag.write")} />,
  "system/access": (ctx) => <AccessWorkspace permissions={{
    changeStatus: ctx.permissions.has("user.status.write"),
    managePermissions: ctx.permissions.has("user.role.write"),
  }} />,
  "audit-log": () => <AuditWorkspace />,

  moderation: (ctx) => <ModerationWorkspace canDecide={ctx.permissions.has("safety.review.write")} canReadComics={ctx.permissions.has("content.asset.read")} canReviewComics={ctx.permissions.has("safety.review.write")} />,
  support: (ctx) => <SupportWorkspace
    canViewPlaintext={ctx.permissions.has("support.plaintext.view")}
    canWrite={ctx.permissions.has("support.request.write")}
  />,
  risk: (ctx) => <RiskWorkspace canRead={ctx.permissions.has("billing.read")} />,
};

export function renderAdminSection(sectionId: AdminSectionId, context: SectionContext): ReactNode {
  return SECTION_RENDERERS[sectionId](context);
}
