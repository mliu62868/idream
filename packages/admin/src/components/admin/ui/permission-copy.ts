import type { AdminPermissionKey } from "@idream/shared/admin/permissions";

// SPEC: 权限码 → 运营看得懂的能力名（i18n key）。
// INTENT: 界面上以前直接写「尚未授予 creative.run.review」。运营不背权限码表，看到它既不知道
//         自己少了什么能力，也不知道该找谁要——两句话里一句有用的都没有。
// INVARIANT: Record<AdminPermissionKey, string> 是全集。shared 里加一个码而这里漏了，立刻编译
//            不过——这是「权限码不许糊到运营脸上」唯一靠得住的守法方式，比测试更早拦住。
const PERMISSION_LABEL: Record<AdminPermissionKey, string> = {
  "dashboard.read": "Viewing the dashboard",
  "user.read": "Viewing user records",
  "user.status.write": "Suspending and restoring accounts",
  "user.role.write": "Changing roles and permission overrides",
  "content.read": "Viewing the content catalog",
  "content.takedown.write": "Taking content down and changing its visibility",
  "content.official.write": "Editing official characters",
  "content.template.write": "Editing character templates",
  "content.tag.write": "Editing content tags",
  "content.production.write": "Running content production batches",
  "content.asset.read": "Viewing the image library",
  "content.asset.review": "Reviewing and approving image assets",
  "content.placement.write": "Editing placements",
  "generation.job.read": "Viewing generation jobs",
  "generation.job.requeue": "Requeueing and discarding generation jobs",
  "generation.config.read": "Viewing generation profiles",
  "generation.config.write": "Testing, publishing, and rolling back generation profiles",
  "safety.review.read": "Viewing the moderation queue",
  "safety.review.write": "Deciding moderation reports and appeals",
  "billing.read": "Viewing billing records",
  "billing.ledger.adjust": "Adjusting customer Dreamcoin balances",
  "billing.checkout.reconcile": "Reconciling checkout exceptions",
  "billing.subscription.refund": "Refunding subscriptions",
  "config.feature_flag.write": "Switching feature flags",
  "config.pricing.write": "Publishing and rolling back prices",
  "ops.queue.read": "Viewing queue health",
  "ops.deadletter.write": "Replaying and discarding dead-letter work",
  "support.request.read": "Viewing support requests",
  "support.request.write": "Escalating and resolving support requests",
  "support.plaintext.view": "Revealing customer plaintext",
  "audit.read": "Reading the audit log",
  "analytics.export": "Exporting analytics",
  "growth.promo.read": "Viewing redeem codes and referrals",
  "growth.promo.write": "Creating and disabling redeem codes",
  "chat.ops.read": "Viewing chat operations",
  "admin.approval.review": "Approving and rejecting high-risk requests",
  "content.cms.write": "Editing CMS pages",
  "compliance.read": "Viewing compliance records",
  "compliance.write": "Recording compliance decisions",
  "character.project.read": "Viewing character projects",
  "character.project.write": "Editing character projects",
  "character.release.read": "Viewing character releases",
  "character.release.propose": "Proposing a character release",
  "character.release.review": "Reviewing a character release",
  "character.release.publish": "Publishing a character release",
  "character.performance.read": "Viewing character performance",
  "creative.run.read": "Viewing creative runs",
  "creative.run.write": "Starting and editing creative runs",
  "creative.run.review": "Reviewing creative run output",
  "creative.asset.read": "Viewing creative assets",
  "creative.placement.read": "Viewing creative placements",
  "creative.placement.publish": "Publishing creative placements",
  "ops.incident.read": "Viewing incidents",
  "ops.incident.manage": "Managing incidents",
  "case.read": "Viewing cases",
  "case.assign": "Assigning cases",
  "case.decide": "Deciding cases",
  "customer.read": "Viewing customer profiles",
  "analytics.metric.read": "Viewing metrics",
  "analytics.metric.export": "Exporting metrics",
  "experiment.manage": "Managing experiments",
};

/** 该权限允许做什么，i18n key；渲染处 t() 一次。 */
export function permissionLabel(key: AdminPermissionKey): string {
  return PERMISSION_LABEL[key];
}

/** 全部能力名 —— 由 permission-copy.test.ts 逐个核对中文存在。 */
export const PERMISSION_LABEL_KEYS: readonly string[] = Object.values(PERMISSION_LABEL);
