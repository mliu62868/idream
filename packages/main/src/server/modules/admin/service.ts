import { Errors } from "@/server/lib/errors";
export {
  actorWithPermission,
  clampInt,
  jsonBody,
  toInputJson,
  writeAudit,
  type AdminActor,
} from "@/server/modules/admin/shared/legacy-primitives";
import { listCmsPages, getCmsPage, createCmsPage, patchCmsPage, publishCmsPage } from "./cms";
import {
  exportUserData,
  eraseUser,
  listAgeVerifications,
  overrideAgeVerification,
} from "./compliance";
import { profileHealth, profileDryRun } from "./generation-health";
import { generationMetrics } from "./generation-metrics";
import {
  getGenerationWorkflow,
  listGenerationBackends,
  listGenerationWorkflows,
} from "./generation/backends-and-workflows";
import { analyticsExport, analyticsRetention } from "./analytics-extra";
import {
  listAdminAnnouncements,
  createAnnouncement,
  patchAnnouncement,
  deleteAnnouncement,
} from "./announcements";
import { listExperiments } from "./experiments";
import { auditLog } from "./audit/query";
import {
  billingAdjustment,
  resolveCheckoutReconciliation,
} from "./billing/command";
import {
  reconcileSubscriptionRefund,
  requestSubscriptionRefund,
} from "./billing/refund";
import { billingLedger, billingReconciliation, listSubscriptions } from "./billing/query";
import { listFeatureFlags, patchFeatureFlag } from "./config/feature-flags";
import {
  createPricingRule,
  listPricingRules,
  patchPricingRule,
  publishPricingRule,
  rollbackPricingRule,
} from "./pricing/service";
export { DUAL_APPROVAL_FLAG, LEDGER_APPROVAL_THRESHOLD } from "./shared/legacy-approval";
import {
  getUserDetail,
  listUserPermissions,
  listUsers,
  setUserPermission,
  updateUserRole,
  updateUserStatus,
} from "./users/service";
import {
  deadLetterQueue,
  discardDeadLetterBatch,
  discardGenerationJob,
  getGenerationJobDetail,
  listGenerationJobs,
  requeueDeadLetterBatch,
  requeueGenerationJob,
} from "./generation/dead-letter/service";
import {
  createModelProfile,
  createProfileTestJob,
  listModelImports,
  listModelProfiles,
  modelDiagnosticsEnabled,
  patchModelProfile,
  publishModelProfile,
  registerModelImport,
  rollbackModelProfile,
  uploadModelImport,
} from "./generation/config/service";
import {
  appealDecision,
  mediaReviewDecision,
  moderationDecision,
  moderationQueue,
} from "./moderation/service";
import {
  escalateSupportRequest,
  listSupportRequests,
  patchSupportRequest,
  viewPlaintext,
} from "./support/service";
import {
  createRedeemCode,
  disableRedeemCode,
  listRedeemCodes,
  listReferrals,
} from "./promo/service";
import {
  approveApproval,
  createApproval,
  listApprovals,
  rejectApproval,
} from "./approvals/service";
import {
  chatOpsModerationEvents,
  chatOpsOverview,
  chatOpsProviderHealth,
  chatOpsSessions,
  chatOpsUsage,
} from "./chat/service";
import {
  abuseOverview,
  analyticsOverview,
  providerOps,
} from "./overviews/service";
import {
  createSavedView,
  deleteSavedView,
  listSavedViews,
} from "./saved-views/service";
import { adminDashboard } from "./dashboard/service";
import {
  createAdminPreset,
  createRecipe,
  getAdminPreset,
  getRecipe,
  listAdminPresets,
  listRecipes,
  patchAdminPreset,
  patchRecipe,
  publishRecipe,
  rollbackRecipe,
} from "./generation/catalog-admin";

type ApiMethod = "GET" | "POST" | "PATCH" | "DELETE" | "PUT";

export async function dispatchAdmin(request: Request, segments: string[]) {
  const method = request.method as ApiMethod;
  const [resource, id, action, child, grandchild] = segments;

  if (resource === "dashboard" && !id && method === "GET") return adminDashboard(request);

  if (resource === "users") {
    if (!id && method === "GET") return listUsers(request);
    if (id && !action && method === "GET") return getUserDetail(request, id);
    if (id && action === "status" && method === "POST") return updateUserStatus(request, id);
    if (id && action === "role" && method === "POST") return updateUserRole(request, id);
    if (id && action === "permissions" && method === "GET") return listUserPermissions(request, id);
    if (id && action === "permissions" && method === "POST") return setUserPermission(request, id);
  }

  if (resource === "generation") {
    if (id === "jobs" && !action && method === "GET") return listGenerationJobs(request);
    if (id === "jobs" && action && !child && method === "GET") {
      return getGenerationJobDetail(request, action);
    }
    if (id === "jobs" && action && child === "requeue" && method === "POST") {
      return requeueGenerationJob(request, action);
    }
    if (id === "jobs" && action && child === "discard" && method === "POST") {
      return discardGenerationJob(request, action);
    }
    if (id === "model-profiles") {
      if (!action && method === "GET") return listModelProfiles(request);
      if (!action && method === "POST") return createModelProfile(request);
      if (action && !child && method === "PATCH") return patchModelProfile(request, action);
      if (action && child === "publish" && method === "POST") {
        return publishModelProfile(request, action);
      }
      if (action && child === "rollback" && method === "POST") {
        return rollbackModelProfile(request, action);
      }
    }
    if (id === "model-imports") {
      if (!modelDiagnosticsEnabled()) throw Errors.notFound("Admin API route not found");
      if (!action && method === "GET") return listModelImports(request);
      if (action === "register" && method === "POST") return registerModelImport(request);
      if (action === "upload" && method === "POST") return uploadModelImport(request);
    }
    if (id === "recipes") {
      if (!action && method === "GET") return listRecipes(request);
      if (action && !child && method === "GET") return getRecipe(request, action);
      if (!action && method === "POST") return createRecipe(request);
      if (action && !child && method === "PATCH") return patchRecipe(request, action);
      if (action && child === "publish" && method === "POST") {
        return publishRecipe(request, action);
      }
      if (action && child === "rollback" && method === "POST") {
        return rollbackRecipe(request, action);
      }
    }
    if (id === "presets") {
      if (!action && method === "GET") return listAdminPresets(request);
      if (action && !child && method === "GET") return getAdminPreset(request, action);
      if (!action && method === "POST") return createAdminPreset(request);
      if (action && !child && method === "PATCH") return patchAdminPreset(request, action);
    }
    if (id === "dead-letter") {
      if (!action && method === "GET") return deadLetterQueue(request);
      if (action === "requeue" && method === "POST") return requeueDeadLetterBatch(request);
      if (action === "discard" && method === "POST") return discardDeadLetterBatch(request);
    }
    if (id === "backends") {
      if (!action && method === "GET") return listGenerationBackends(request);
    }
    if (id === "workflows") {
      if (!action && method === "GET") return listGenerationWorkflows(request);
      if (action && !child && method === "GET") return getGenerationWorkflow(request, action);
    }
    if (id === "metrics" && !action && method === "GET") return generationMetrics(request);
  }

  if (resource === "pricing" && id === "rules") {
    if (!action && method === "GET") return listPricingRules(request);
    if (!action && method === "POST") return createPricingRule(request);
    if (action && !child && method === "PATCH") return patchPricingRule(request, action);
    if (action && child === "publish" && method === "POST") {
      return publishPricingRule(request, action);
    }
    if (action && child === "rollback" && method === "POST") {
      return rollbackPricingRule(request, action);
    }
  }

  if (resource === "moderation") {
    if (id === "queue" && !action && method === "GET") return moderationQueue(request);
    if (id === "media" && action && child === "decision" && method === "POST") {
      return mediaReviewDecision(request, action);
    }
    if (id && action === "decision" && method === "POST") {
      return moderationDecision(request, id);
    }
    if (id === "appeals" && action && !child && method === "PATCH") {
      return appealDecision(request, action);
    }
  }

  if (resource === "billing") {
    if (id === "ledger" && !action && method === "GET") return billingLedger(request);
    if (id === "subscriptions" && !action && method === "GET") return listSubscriptions(request);
    if (id === "reconciliation" && !action && method === "GET") {
      return billingReconciliation(request);
    }
    if (
      id === "reconciliation" &&
      action &&
      child === "resolve" &&
      method === "POST"
    ) {
      return resolveCheckoutReconciliation(request, action);
    }
    if (id === "adjustments" && !action && method === "POST") {
      return billingAdjustment(request);
    }
    if (
      id === "subscriptions" &&
      action &&
      child === "refund" &&
      !grandchild &&
      method === "POST"
    ) {
      return requestSubscriptionRefund(request, action);
    }
    if (
      id === "subscriptions" &&
      action &&
      child === "refund" &&
      grandchild === "reconcile" &&
      method === "POST"
    ) {
      return reconcileSubscriptionRefund(request, action);
    }
  }

  if (resource === "feature-flags") {
    if (!id && method === "GET") return listFeatureFlags(request);
    if (id && !action && method === "PATCH") return patchFeatureFlag(request, id);
  }

  if (resource === "analytics" && id === "overview" && !action && method === "GET") {
    return analyticsOverview(request);
  }

  if (resource === "risk" && id === "abuse" && !action && method === "GET") {
    return abuseOverview(request);
  }

  if (resource === "ops" && id === "providers" && !action && method === "GET") {
    return providerOps(request);
  }

  if (resource === "audit-log" && !id && method === "GET") return auditLog(request);

  if (resource === "support" && id === "requests") {
    if (!action && method === "GET") return listSupportRequests(request);
    if (action && !child && method === "PATCH") return patchSupportRequest(request, action);
    if (action && child === "escalate" && !grandchild && method === "POST") {
      return escalateSupportRequest(request, action);
    }
  }

  if (resource === "support" && id === "plaintext" && action === "view" && method === "POST") {
    return viewPlaintext(request);
  }

  if (resource === "saved-views") {
    if (!id && method === "GET") return listSavedViews(request);
    if (!id && method === "POST") return createSavedView(request);
    if (id && !action && method === "DELETE") return deleteSavedView(request, id);
  }

  if (resource === "promo") {
    if (id === "redeem-codes" && !action && method === "GET") return listRedeemCodes(request);
    if (id === "redeem-codes" && !action && method === "POST") return createRedeemCode(request);
    if (id === "redeem-codes" && action && child === "disable" && method === "POST") {
      return disableRedeemCode(request, action);
    }
    if (id === "referrals" && !action && method === "GET") return listReferrals(request);
  }

  if (resource === "approvals") {
    if (!id && method === "GET") return listApprovals(request);
    if (!id && method === "POST") return createApproval(request);
    if (id && action === "approve" && method === "POST") return approveApproval(request, id);
    if (id && action === "reject" && method === "POST") return rejectApproval(request, id);
  }

  if (resource === "chat") {
    if (id === "overview" && !action && method === "GET") return chatOpsOverview(request);
    if (id === "provider-health" && !action && method === "GET") return chatOpsProviderHealth(request);
    if (id === "sessions" && !action && method === "GET") return chatOpsSessions(request);
    if (id === "usage" && !action && method === "GET") return chatOpsUsage(request);
    if (id === "moderation-events" && !action && method === "GET") {
      return chatOpsModerationEvents(request);
    }
  }

  // T1 CMS/SEO（path 含 "/"，作为 ?path= / body.path 传递，不放 URL 段）
  if (resource === "cms" && id === "pages") {
    if (!action && method === "GET") {
      return new URL(request.url).searchParams.get("path") ? getCmsPage(request) : listCmsPages(request);
    }
    if (!action && method === "POST") return createCmsPage(request);
    if (!action && method === "PATCH") return patchCmsPage(request);
    if (action === "publish" && method === "POST") return publishCmsPage(request);
  }

  // T2 合规（DSAR 导出/擦除 + 年龄验证复核）
  if (resource === "compliance") {
    if (id === "users" && action && child === "export" && method === "GET") {
      return exportUserData(request, action);
    }
    if (id === "users" && action && child === "erase" && method === "POST") {
      return eraseUser(request, action);
    }
    if (id === "age-verifications" && !action && method === "GET") {
      return listAgeVerifications(request);
    }
    if (id === "age-verifications" && action && child === "override" && method === "POST") {
      return overrideAgeVerification(request, action);
    }
  }

  // T4 生成 profile 健康度 + dry-run（与既有 model-profiles publish/rollback 正交）
  if (resource === "generation" && id === "model-profiles" && action) {
    if (child === "health" && method === "GET") return profileHealth(request, action);
    if (child === "dry-run" && method === "POST") return profileDryRun(request, action);
    if (child === "test-job" && method === "POST") return createProfileTestJob(request, action);
  }

  // T4 analytics 导出 + 留存
  if (resource === "analytics" && id === "export" && !action && method === "GET") {
    return analyticsExport(request);
  }
  if (resource === "analytics" && id === "retention" && !action && method === "GET") {
    return analyticsRetention(request);
  }

  // Phase 4 增长运营：公告 CRUD + 实验度量
  if (resource === "announcements") {
    if (!id && method === "GET") return listAdminAnnouncements(request);
    if (!id && method === "POST") return createAnnouncement(request);
    if (id && !action && method === "PATCH") return patchAnnouncement(request, id);
    if (id && !action && method === "DELETE") return deleteAnnouncement(request, id);
  }
  if (resource === "experiments" && !id && method === "GET") return listExperiments(request);

  throw Errors.notFound("Admin API route not found", { path: `/admin/${segments.join("/")}` });
}
