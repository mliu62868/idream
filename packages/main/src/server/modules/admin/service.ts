import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import {
  adminAuditData,
  actorWithPermission,
  clampInt,
  jsonBody,
  toInputJson,
  writeAudit,
} from "@/server/modules/admin/shared/legacy-primitives";
export {
  actorWithPermission,
  clampInt,
  jsonBody,
  toInputJson,
  writeAudit,
  type AdminActor,
} from "@/server/modules/admin/shared/legacy-primitives";
import {
  decodeAdminListCursor,
  encodeAdminListCursor,
} from "@/server/modules/admin-v2/shared/list-cursor";
import {
  listOfficialCharacters,
  createOfficialCharacter,
  updateOfficialCharacter,
  setOfficialState,
} from "./characters/official";
import {
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  setTemplateActive,
} from "./characters/templates";
import { listAdminTags, patchTag, mergeTags } from "./characters/tags";
import { listReviewQueue, reviewSubmission } from "./characters/review";
import { generateCharacterDraft } from "./characters/assist";
import {
  listCharacterVisualProfiles,
  createCharacterVisualProfile,
} from "./characters/visual-profiles";
import {
  createCharacterPregenBatch,
  listCharacterPregenBatches,
} from "./characters/pregen";
import { setCharacterChatTools } from "./characters/chat-tools";
import { generateProductionDirections } from "./production-directions";
import {
  approveProductionItem,
  bulkPatchContentAssets,
  createPlacement,
  createProductionBatch,
  estimateProductionBatch,
  getContentAsset,
  getPlacement,
  getProductionBatch,
  listContentAssets,
  listPlacements,
  listProductionBatches,
  patchContentAsset,
  patchPlacement,
  regenerateProductionItem,
  rejectProductionItem,
} from "./content-ops";
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
} from "./generation-catalog";
import { analyticsExport, analyticsRetention } from "./analytics-extra";
import {
  listAdminAnnouncements,
  createAnnouncement,
  patchAnnouncement,
  deleteAnnouncement,
} from "./announcements";
import { listExperiments } from "./experiments";
import { auditLog } from "./audit/query";
import { billingAdjustment } from "./billing/command";
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
export { enqueueGenerationAttempt } from "@/server/modules/generation/attempt-dispatch";
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
import { appealDecision, moderationDecision, moderationQueue } from "./moderation/service";
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

const FEATURED_SETTING_KEY = "feed.featured";

type ApiMethod = "GET" | "POST" | "PATCH" | "DELETE" | "PUT";

const recipeSchema = z.object({
  recipeKey: z.string().trim().min(1).max(120),
  label: z.string().trim().min(1).max(120),
  mode: z.enum(["image", "video", "negative"]).default("image"),
  useCase: z.enum(["character", "freeplay", "negative"]).default("character"),
  body: z.string().trim().min(1).max(12_000),
  negativeBase: z.string().trim().max(4_000).nullable().optional(),
  presetOrder: z.array(z.string()).max(20).default([]),
  safetyHints: z.record(z.string(), z.unknown()).default({}),
  sampleMatrix: z.array(z.record(z.string(), z.unknown())).max(40).default([]),
  dryRunSummary: z.record(z.string(), z.unknown()).optional(),
});

const recipePatchSchema = recipeSchema.partial();

const publishSchema = z.object({
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
  dryRunSummary: z.record(z.string(), z.unknown()).optional(),
});

const rollbackSchema = z.object({
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

const presetAdminSchema = z.object({
  type: z.enum(["background", "pose", "outfit", "mode"]),
  category: z.string().max(80).optional(),
  label: z.string().trim().min(1).max(80),
  controls: z.record(z.string(), z.unknown()).default({}),
  visibility: z.enum(["private", "public", "unlisted"]).default("public"),
  status: z.enum(["active", "archived"]).default("active"),
});

const savedViewCreateSchema = z.object({
  scope: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(120),
  filters: z.record(z.string(), z.unknown()).default({}),
});

const contentVisibilitySchema = z.object({
  visibility: z.enum(["private", "unlisted", "public"]),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

const contentStatusSchema = z.object({
  status: z.enum(["approved", "rejected", "removed", "archived"]),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

const featuredPutSchema = z.object({
  characterIds: z.array(z.string().trim().min(1).max(160)).max(24),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

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
    if (id === "adjustments" && !action && method === "POST") {
      return billingAdjustment(request);
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

  if (resource === "content" && id === "characters") {
    if (!action && method === "GET") return listContentCharacters(request);
    if (action && !child && method === "GET") return getContentCharacter(request, action);
    if (action && child === "visibility" && method === "POST") {
      return setCharacterVisibility(request, action);
    }
    if (action && child === "status" && method === "POST") {
      return setCharacterStatus(request, action);
    }
    if (action && child === "visual-profiles" && method === "GET") {
      return listCharacterVisualProfiles(request, action);
    }
    if (action && child === "visual-profiles" && method === "POST") {
      return createCharacterVisualProfile(request, action);
    }
    if (action && child === "pregen" && method === "GET") {
      return listCharacterPregenBatches(request, action);
    }
    if (action && child === "pregen" && method === "POST") {
      return createCharacterPregenBatch(request, action);
    }
    if (action && child === "chat-tools" && method === "POST") {
      return setCharacterChatTools(request, action);
    }
  }
  if (resource === "content" && id === "featured") {
    if (!action && method === "GET") return getFeaturedCharacters(request);
    if (!action && method === "PUT") return putFeaturedCharacters(request);
  }
  if (resource === "content" && id === "production") {
    if (action === "directions" && !child && method === "POST") {
      return generateProductionDirections(request);
    }
    if (action === "estimate" && !child && method === "POST") {
      return estimateProductionBatch(request);
    }
    if (action === "batches" && !child && method === "GET") return listProductionBatches(request);
    if (action === "batches" && !child && method === "POST") return createProductionBatch(request);
    if (action === "batches" && child && !grandchild && method === "GET") {
      return getProductionBatch(request, child);
    }
    if (action === "items" && child && grandchild === "approve" && method === "POST") {
      return approveProductionItem(request, child);
    }
    if (action === "items" && child && grandchild === "reject" && method === "POST") {
      return rejectProductionItem(request, child);
    }
    if (action === "items" && child && grandchild === "regenerate" && method === "POST") {
      return regenerateProductionItem(request, child);
    }
  }
  if (resource === "content" && id === "assets") {
    if (!action && method === "GET") return listContentAssets(request);
    if (action === "bulk" && !child && method === "POST") return bulkPatchContentAssets(request);
    if (action && !child && method === "GET") return getContentAsset(request, action);
    if (action && !child && method === "PATCH") return patchContentAsset(request, action);
  }
  if (resource === "content" && id === "placements") {
    if (!action && method === "GET") return listPlacements(request);
    if (!action && method === "POST") return createPlacement(request);
    if (action && !child && method === "GET") return getPlacement(request, action);
    if (action && !child && method === "PATCH") return patchPlacement(request, action);
  }
  // A — 官方角色 CMS
  if (resource === "content" && id === "official") {
    if (!action && method === "GET") return listOfficialCharacters(request);
    if (!action && method === "POST") return createOfficialCharacter(request);
    if (action && !child && method === "PATCH") return updateOfficialCharacter(request, action);
    if (action && child === "state" && method === "POST") return setOfficialState(request, action);
  }
  // B — 角色创建模板库
  if (resource === "content" && id === "templates") {
    if (!action && method === "GET") return listTemplates(request);
    if (action && !child && method === "GET") return getTemplate(request, action);
    if (!action && method === "POST") return createTemplate(request);
    if (action && !child && method === "PATCH") return updateTemplate(request, action);
    if (action && child === "active" && method === "POST") return setTemplateActive(request, action);
  }
  // C — 标签分类法治理（merge 字面量须先于通用 {id} 判断）
  if (resource === "content" && id === "tags") {
    if (!action && method === "GET") return listAdminTags(request);
    if (action === "merge" && method === "POST") return mergeTags(request);
    if (action && action !== "merge" && method === "PATCH") return patchTag(request, action);
  }
  // D — 角色审核队列（复用 safety.review.* 权限）
  if (resource === "content" && id === "review-queue") {
    if (!action && method === "GET") return listReviewQueue(request);
    if (action && child === "decision" && method === "POST") return reviewSubmission(request, action);
  }
  // AI 辅助生成（官方角色/模板共用，§8 后置增强）
  if (resource === "content" && id === "character-assist" && !action && method === "POST") {
    return generateCharacterDraft(request);
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

function assertTargetConfirmation(value: string, targetId: string) {
  if (value !== targetId) throw Errors.badRequest("Confirmation did not match target");
}

async function adminDashboard(request: Request) {
  await actorWithPermission(request, "dashboard.read");
  const [
    activeUsers,
    suspendedUsers,
    queuedJobs,
    failedJobs,
    completedJobs,
    blockedJobs,
    openReports,
    activeSubscriptions,
    flags,
  ] = await Promise.all([
    prisma.user.count({ where: { status: "active", deletedAt: null } }),
    prisma.user.count({ where: { status: "suspended" } }),
    prisma.generationJob.count({
      where: { status: { in: ["queued", "moderating_input", "running", "moderating_output"] } },
    }),
    prisma.generationJob.count({ where: { status: "failed" } }),
    prisma.generationJob.count({ where: { status: "completed" } }),
    prisma.generationJob.count({ where: { status: "blocked" } }),
    prisma.contentReport.count({ where: { status: { in: ["open", "triaged", "reviewing"] } } }),
    prisma.subscription.count({ where: { status: "active" } }),
    prisma.featureFlag.findMany({ orderBy: { key: "asc" }, take: 8 }),
  ]);

  const totalFinished = completedJobs + failedJobs + blockedJobs;
  const successRate = totalFinished > 0 ? Math.round((completedJobs / totalFinished) * 100) : 100;

  return ok({
    metrics: {
      users: { active: activeUsers, suspended: suspendedUsers },
      generation: { queued: queuedJobs, failed: failedJobs, blocked: blockedJobs, successRate },
      moderation: { openReports },
      billing: { activeSubscriptions },
    },
    featureFlags: flags,
  });
}

async function listRecipes(request: Request) {
  await actorWithPermission(request, "generation.config.read");
  const url = new URL(request.url);
  const mode = url.searchParams.get("mode") ?? undefined;
  const status = url.searchParams.get("status")?.trim() || undefined;
  const search = url.searchParams.get("search")?.trim() || undefined;
  const limit = clampInt(url.searchParams.get("limit"), 1, 100, 25);
  const queryIdentity = { mode, status, search, sort: "label_asc" };
  const cursorKeys = url.searchParams.get("cursor")
    ? decodeAdminListCursor(url.searchParams.get("cursor")!, "generation_recipes", queryIdentity)
    : null;
  const [cursorLabel, cursorId] = cursorKeys
    ? z.tuple([z.string(), z.string().min(1)]).parse(cursorKeys)
    : [null, null];
  const templates = await prisma.generationRecipe.findMany({
    where: {
      mode,
      status,
      ...(search ? { OR: [
        { id: { contains: search, mode: "insensitive" } },
        { label: { contains: search, mode: "insensitive" } },
        { recipeKey: { contains: search, mode: "insensitive" } },
      ] } : {}),
      ...(cursorLabel && cursorId ? { AND: [{ OR: [
        { label: { gt: cursorLabel } },
        { label: cursorLabel, id: { gt: cursorId } },
      ] }] } : {}),
    },
    orderBy: [{ label: "asc" }, { id: "asc" }],
    take: limit + 1,
  });
  const hasNextPage = templates.length > limit;
  const page = templates.slice(0, limit);
  const last = page.at(-1);
  return ok({
    items: page,
    pageInfo: {
      endCursor: hasNextPage && last
        ? encodeAdminListCursor("generation_recipes", queryIdentity, [last.label, last.id])
        : null,
      hasNextPage,
    },
    asOf: new Date().toISOString(),
    freshness: "fresh",
  });
}

async function getRecipe(request: Request, id: string) {
  await actorWithPermission(request, "generation.config.read");
  const recipe = await prisma.generationRecipe.findUnique({ where: { id } });
  if (!recipe) throw Errors.notFound("Generation recipe not found");
  return ok({ recipe });
}

async function createRecipe(request: Request) {
  const actor = await actorWithPermission(request, "generation.config.write");
  const body = recipeSchema.parse(await jsonBody(request));
  const latest = await prisma.generationRecipe.findFirst({
    where: { recipeKey: body.recipeKey },
    orderBy: { version: "desc" },
  });
  const template = await prisma.generationRecipe.create({
    data: {
      ...body,
      negativeBase: body.negativeBase ?? null,
      presetOrder: toInputJson(body.presetOrder),
      safetyHints: toInputJson(body.safetyHints),
      sampleMatrix: toInputJson(body.sampleMatrix),
      dryRunSummary: body.dryRunSummary ? toInputJson(body.dryRunSummary) : undefined,
      version: (latest?.version ?? 0) + 1,
      status: "draft",
    },
  });
  await writeAudit(request, actor, {
    action: "generation.prompt_template.create",
    targetType: "generation_prompt_template",
    targetId: template.id,
    after: recipeAuditSnapshot(template),
  });
  return ok({ template });
}

async function patchRecipe(request: Request, id: string) {
  const actor = await actorWithPermission(request, "generation.config.write");
  const body = recipePatchSchema.parse(await jsonBody(request));
  const before = await prisma.generationRecipe.findUnique({ where: { id } });
  if (!before) throw Errors.notFound("Prompt template not found");
  if (before.status !== "draft") throw Errors.badRequest("Only draft templates can be edited");
  const updated = await prisma.generationRecipe.update({
    where: { id },
    data: {
      recipeKey: body.recipeKey,
      label: body.label,
      mode: body.mode,
      useCase: body.useCase,
      body: body.body,
      negativeBase: body.negativeBase,
      presetOrder: body.presetOrder ? toInputJson(body.presetOrder) : undefined,
      safetyHints: body.safetyHints ? toInputJson(body.safetyHints) : undefined,
      sampleMatrix: body.sampleMatrix ? toInputJson(body.sampleMatrix) : undefined,
      dryRunSummary: body.dryRunSummary ? toInputJson(body.dryRunSummary) : undefined,
    },
  });
  await writeAudit(request, actor, {
    action: "generation.prompt_template.update",
    targetType: "generation_prompt_template",
    targetId: id,
    before: recipeAuditSnapshot(before),
    after: recipeAuditSnapshot(updated),
  });
  return ok({ template: updated });
}

async function publishRecipe(request: Request, id: string) {
  const actor = await actorWithPermission(request, "generation.config.write");
  const body = publishSchema.parse(await jsonBody(request));
  const template = await prisma.generationRecipe.findUnique({ where: { id } });
  if (!template) throw Errors.notFound("Prompt template not found");
  assertTargetConfirmation(body.confirmation, template.id);
  if (template.status !== "draft") throw Errors.badRequest("Only draft templates can be published");
  const dryRunSummary = body.dryRunSummary
    ? toInputJson(body.dryRunSummary)
    : template.dryRunSummary;
  if (!dryRunSummary) throw Errors.badRequest("Publish requires dry-run summary");
  const previous = await prisma.generationRecipe.findFirst({
    where: { recipeKey: template.recipeKey, status: "active" },
  });
  const published = await prisma.$transaction(async (tx) => {
    await tx.generationRecipe.updateMany({
      where: { recipeKey: template.recipeKey, status: "active" },
      data: { status: "archived", archivedAt: new Date() },
    });
    return tx.generationRecipe.update({
      where: { id },
      data: { status: "active", dryRunSummary, publishedAt: new Date(), archivedAt: null },
    });
  });
  await writeAudit(request, actor, {
    action: "generation.prompt_template.publish",
    targetType: "generation_prompt_template",
    targetId: id,
    reason: body.reason,
    before: previous ? recipeAuditSnapshot(previous) : null,
    after: recipeAuditSnapshot(published),
  });
  return ok({ template: published, previousActiveId: previous?.id ?? null });
}

async function rollbackRecipe(request: Request, id: string) {
  const actor = await actorWithPermission(request, "generation.config.write");
  const body = rollbackSchema.parse(await jsonBody(request));
  const current = await prisma.generationRecipe.findUnique({ where: { id } });
  if (!current) throw Errors.notFound("Prompt template not found");
  assertTargetConfirmation(body.confirmation, current.id);
  const previous = await prisma.generationRecipe.findFirst({
    where: {
      recipeKey: current.recipeKey,
      status: "archived",
      version: { lt: current.version },
    },
    orderBy: { version: "desc" },
  });
  if (!previous) throw Errors.notFound("No previous template version to roll back to");
  const restored = await prisma.$transaction(async (tx) => {
    await tx.generationRecipe.updateMany({
      where: { recipeKey: current.recipeKey, status: "active" },
      data: { status: "archived", archivedAt: new Date() },
    });
    return tx.generationRecipe.update({
      where: { id: previous.id },
      data: { status: "active", publishedAt: new Date(), archivedAt: null },
    });
  });
  await writeAudit(request, actor, {
    action: "generation.prompt_template.rollback",
    targetType: "generation_prompt_template",
    targetId: current.id,
    reason: body.reason,
    before: recipeAuditSnapshot(current),
    after: recipeAuditSnapshot(restored),
  });
  return ok({ template: restored, fromVersion: current.version, toVersion: restored.version });
}

async function listAdminPresets(request: Request) {
  await actorWithPermission(request, "generation.config.read");
  const url = new URL(request.url);
  const type = url.searchParams.get("type")?.trim() || undefined;
  const status = url.searchParams.get("status")?.trim() || undefined;
  const search = url.searchParams.get("search")?.trim() || undefined;
  const limit = clampInt(url.searchParams.get("limit"), 1, 100, 25);
  const queryIdentity = { type, status, search, sort: "label_asc" };
  const cursorKeys = url.searchParams.get("cursor")
    ? decodeAdminListCursor(url.searchParams.get("cursor")!, "generation_presets", queryIdentity)
    : null;
  const [cursorLabel, cursorId] = cursorKeys
    ? z.tuple([z.string(), z.string().min(1)]).parse(cursorKeys)
    : [null, null];
  const presets = await prisma.generationPreset.findMany({
    where: {
      scope: "built_in",
      type,
      status,
      ...(search ? { OR: [
        { id: { contains: search, mode: "insensitive" } },
        { label: { contains: search, mode: "insensitive" } },
        { category: { contains: search, mode: "insensitive" } },
      ] } : {}),
      ...(cursorLabel && cursorId ? { AND: [{ OR: [
        { label: { gt: cursorLabel } },
        { label: cursorLabel, id: { gt: cursorId } },
      ] }] } : {}),
    },
    orderBy: [{ label: "asc" }, { id: "asc" }],
    take: limit + 1,
  });
  const hasNextPage = presets.length > limit;
  const page = presets.slice(0, limit);
  const last = page.at(-1);
  return ok({
    items: page,
    pageInfo: {
      endCursor: hasNextPage && last
        ? encodeAdminListCursor("generation_presets", queryIdentity, [last.label, last.id])
        : null,
      hasNextPage,
    },
    asOf: new Date().toISOString(),
    freshness: "fresh",
  });
}

async function getAdminPreset(request: Request, id: string) {
  await actorWithPermission(request, "generation.config.read");
  const preset = await prisma.generationPreset.findUnique({ where: { id } });
  if (!preset || preset.scope !== "built_in") throw Errors.notFound("Built-in preset not found");
  return ok({ preset });
}

async function createAdminPreset(request: Request) {
  const actor = await actorWithPermission(request, "generation.config.write");
  const body = presetAdminSchema.parse(await jsonBody(request));
  const preset = await prisma.generationPreset.create({
    data: {
      scope: "built_in",
      type: body.type,
      category: body.category,
      label: body.label,
      controls: toInputJson(body.controls),
      visibility: body.visibility,
      status: body.status,
    },
  });
  await writeAudit(request, actor, {
    action: "generation.preset.create",
    targetType: "generation_preset",
    targetId: preset.id,
    after: { type: preset.type, label: preset.label, status: preset.status },
  });
  return ok({ preset });
}

async function patchAdminPreset(request: Request, id: string) {
  const actor = await actorWithPermission(request, "generation.config.write");
  const body = presetAdminSchema.partial().parse(await jsonBody(request));
  const before = await prisma.generationPreset.findUnique({ where: { id } });
  if (!before || before.scope !== "built_in") throw Errors.notFound("Built-in preset not found");
  const preset = await prisma.generationPreset.update({
    where: { id },
    data: {
      type: body.type,
      category: body.category,
      label: body.label,
      controls: body.controls ? toInputJson(body.controls) : undefined,
      visibility: body.visibility,
      status: body.status,
    },
  });
  await writeAudit(request, actor, {
    action: "generation.preset.update",
    targetType: "generation_preset",
    targetId: id,
    before: { type: before.type, label: before.label, status: before.status },
    after: { type: preset.type, label: preset.label, status: preset.status },
  });
  return ok({ preset });
}

// SPEC: Phase-0 truth containment. Exact operational aggregates remain available,
// while the legacy activation/conversion values are explicitly invalid until the
// canonical fact + certified metric cutover.
async function analyticsOverview(request: Request) {
  await actorWithPermission(request, "analytics.export");
  const url = new URL(request.url);
  const now = new Date();
  const fromParam = url.searchParams.get("from");
  const toParam = url.searchParams.get("to");
  const to = toParam ? new Date(toParam) : now;
  const from = fromParam ? new Date(fromParam) : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw Errors.badRequest("Invalid analytics window");
  }
  const createdAt = { gte: from, lte: to };
  const [
    signups,
    activatedRows,
    payingRows,
    generationByStatus,
    grantedAgg,
    spentAgg,
    ledgerByReason,
    eventRows,
  ] = await Promise.all([
    prisma.user.count({ where: { createdAt, deletedAt: null } }),
    prisma.generationJob.groupBy({ by: ["userId"], where: { createdAt } }),
    prisma.subscription.groupBy({ by: ["userId"], where: { createdAt } }),
    prisma.generationJob.groupBy({ by: ["status"], where: { createdAt }, _count: { _all: true } }),
    prisma.dreamcoinLedger.aggregate({ where: { createdAt, delta: { gt: 0 } }, _sum: { delta: true } }),
    prisma.dreamcoinLedger.aggregate({ where: { createdAt, delta: { lt: 0 } }, _sum: { delta: true } }),
    prisma.dreamcoinLedger.groupBy({
      by: ["reason"],
      where: { createdAt },
      _sum: { delta: true },
      _count: { _all: true },
    }),
    prisma.analyticsEvent.groupBy({ by: ["name"], where: { createdAt }, _count: { _all: true } }),
  ]);

  const activatedUsers = activatedRows.length;
  const payingUsers = payingRows.length;
  const conversionRate = signups > 0 ? Math.round((payingUsers / signups) * 100) : 0;
  const statusCount = (status: string) =>
    generationByStatus.find((row) => row.status === status)?._count._all ?? 0;
  const generationTotal = generationByStatus.reduce((sum, row) => sum + row._count._all, 0);
  const coinsGranted = grantedAgg._sum.delta ?? 0;
  const coinsSpent = spentAgg._sum.delta ?? 0;
  const byReason = ledgerByReason
    .map((row) => ({ reason: row.reason, totalDelta: row._sum.delta ?? 0, count: row._count._all }))
    .sort((a, b) => a.reason.localeCompare(b.reason));
  const topEvents = eventRows
    .map((row) => ({ name: row.name, count: row._count._all }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);

  return ok({
    window: { from: from.toISOString(), to: to.toISOString() },
    funnel: {
      signups,
      activatedUsers: null,
      payingUsers: null,
      conversionRate: null,
      qualityState: "invalid",
      validForDecisions: false,
      metricVersion: "legacy-v1",
      reason:
        "Legacy activation used any generation job and conversion mixed unrelated windows; certified cohort metrics are not available yet.",
      legacyObserved: { activatedUsers, payingUsers, conversionRate },
    },
    generation: {
      total: generationTotal,
      completed: statusCount("completed"),
      failed: statusCount("failed"),
      blocked: statusCount("blocked"),
      qualityState: "directional",
      validForDecisions: false,
      reason: "Legacy status counts are operational diagnostics, not fulfillment outcomes.",
    },
    economy: { coinsGranted, coinsSpent, net: coinsGranted + coinsSpent, byReason },
    topEvents,
  });
}

// SPEC: 资金侧反滥用只读告警 —— 多账号（共享 anonymousId）、Referral 薅取、异常 admin_adjust，窗口内聚合。
// INTENT: 注册送 250 币的产品 beta 期会被刷；先让运营「看得见」，处置仍走既有封禁/adjust（本视图不写）。
// INVARIANTS: 只读；deviceClusters 用 signup 事件的 anonymousId 聚类（同浏览器多账号信号，非完备：清 cookie/无痕可绕）。
// EXAMPLE: 一个 anonymousId 上挂 3 个 userId → accountCount=3，进多账号告警表。
async function abuseOverview(request: Request) {
  await actorWithPermission(request, "billing.read");
  const url = new URL(request.url);
  const now = new Date();
  const fromParam = url.searchParams.get("from");
  const toParam = url.searchParams.get("to");
  const to = toParam ? new Date(toParam) : now;
  const from = fromParam ? new Date(fromParam) : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw Errors.badRequest("Invalid risk window");
  }
  const createdAt = { gte: from, lte: to };

  const [signupGroups, referralGroups, adjustGroups] = await Promise.all([
    prisma.analyticsEvent.groupBy({
      by: ["anonymousId"],
      where: { name: "signup", anonymousId: { not: null }, createdAt },
      _count: { _all: true },
    }),
    prisma.referral.groupBy({
      by: ["inviterId"],
      where: { createdAt },
      _count: { _all: true },
    }),
    prisma.dreamcoinLedger.groupBy({
      by: ["userId"],
      where: { reason: "admin_adjust", createdAt },
      _sum: { delta: true },
      _count: { _all: true },
    }),
  ]);

  // 多账号：同 anonymousId 出现 ≥2 次 signup → 取该 anonymousId 下的 distinct userId。
  const flaggedAnon = signupGroups
    .filter((group) => group._count._all >= 2)
    .sort((a, b) => b._count._all - a._count._all)
    .slice(0, 20)
    .map((group) => group.anonymousId)
    .filter((id): id is string => Boolean(id));
  let deviceClusters: Array<{ anonymousId: string; accountCount: number; userIds: string[] }> = [];
  if (flaggedAnon.length > 0) {
    const events = await prisma.analyticsEvent.findMany({
      where: { name: "signup", anonymousId: { in: flaggedAnon } },
      select: { anonymousId: true, userId: true },
    });
    const byAnon = new Map<string, Set<string>>();
    for (const event of events) {
      if (!event.anonymousId || !event.userId) continue;
      const set = byAnon.get(event.anonymousId) ?? new Set<string>();
      set.add(event.userId);
      byAnon.set(event.anonymousId, set);
    }
    deviceClusters = flaggedAnon
      .map((anonymousId) => ({
        anonymousId,
        accountCount: byAnon.get(anonymousId)?.size ?? 0,
        userIds: [...(byAnon.get(anonymousId) ?? [])].slice(0, 10),
      }))
      .filter((cluster) => cluster.accountCount >= 2);
  }

  const referralAbuse = referralGroups
    .filter((group) => group._count._all >= 3)
    .map((group) => ({ inviterId: group.inviterId, referralCount: group._count._all }))
    .sort((a, b) => b.referralCount - a.referralCount)
    .slice(0, 20);

  const adjustAnomalies = adjustGroups
    .map((group) => ({
      userId: group.userId,
      totalDelta: group._sum.delta ?? 0,
      count: group._count._all,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  return ok({
    window: { from: from.toISOString(), to: to.toISOString() },
    deviceClusters,
    referralAbuse,
    adjustAnomalies,
  });
}

// SPEC: Provider / 成本 / 容量看板 —— 按 provider 聚合生成成功率、单均币成本、p50/p95 延迟，窗口内只读。
// INTENT: 让 ops 看到各 provider 健康度与成本，定位「哪个 runner 慢/贵/失败率高」。数据全来自 GenerationJob。
// INVARIANTS: 只读；latency = completedAt − createdAt（仅 completed 计入）；provider 为空记 "unknown"。默认近 30 天。
async function providerOps(request: Request) {
  await actorWithPermission(request, "ops.queue.read");
  const url = new URL(request.url);
  const now = new Date();
  const fromParam = url.searchParams.get("from");
  const toParam = url.searchParams.get("to");
  const to = toParam ? new Date(toParam) : now;
  const from = fromParam ? new Date(fromParam) : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw Errors.badRequest("Invalid provider window");
  }
  const createdAt = { gte: from, lte: to };
  const [grouped, completedJobs] = await Promise.all([
    prisma.generationJob.groupBy({
      by: ["provider", "status"],
      where: { createdAt },
      _count: { _all: true },
      _sum: { costDreamcoins: true },
    }),
    prisma.generationJob.findMany({
      where: { createdAt, status: "completed", completedAt: { not: null } },
      select: { provider: true, createdAt: true, completedAt: true },
      orderBy: { createdAt: "desc" },
      take: 5000,
    }),
  ]);

  const providerKey = (provider: string | null) => provider ?? "unknown";
  const stats = new Map<
    string,
    { total: number; completed: number; failed: number; blocked: number; coinsCost: number }
  >();
  for (const row of grouped) {
    const key = providerKey(row.provider);
    const acc = stats.get(key) ?? { total: 0, completed: 0, failed: 0, blocked: 0, coinsCost: 0 };
    acc.total += row._count._all;
    acc.coinsCost += row._sum.costDreamcoins ?? 0;
    if (row.status === "completed") acc.completed += row._count._all;
    if (row.status === "failed") acc.failed += row._count._all;
    if (row.status === "blocked") acc.blocked += row._count._all;
    stats.set(key, acc);
  }

  const latencies = new Map<string, number[]>();
  for (const job of completedJobs) {
    if (!job.completedAt) continue;
    const ms = job.completedAt.getTime() - job.createdAt.getTime();
    if (ms < 0) continue;
    const key = providerKey(job.provider);
    const arr = latencies.get(key) ?? [];
    arr.push(ms);
    latencies.set(key, arr);
  }

  const providers = [...stats.entries()]
    .map(([provider, acc]) => {
      const finished = acc.completed + acc.failed + acc.blocked;
      const sorted = (latencies.get(provider) ?? []).sort((a, b) => a - b);
      return {
        provider,
        total: acc.total,
        completed: acc.completed,
        failed: acc.failed,
        blocked: acc.blocked,
        successRate: finished > 0 ? Math.round((acc.completed / finished) * 100) : 0,
        coinsCost: acc.coinsCost,
        avgCostPerJob: acc.total > 0 ? Math.round((acc.coinsCost / acc.total) * 10) / 10 : 0,
        latencyP50Ms: percentile(sorted, 50),
        latencyP95Ms: percentile(sorted, 95),
        latencySamples: sorted.length,
      };
    })
    .sort((a, b) => b.total - a.total);

  return ok({ window: { from: from.toISOString(), to: to.toISOString() }, providers });
}

function percentile(sorted: number[], p: number) {
  if (sorted.length === 0) return 0;
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

// ── F1 Saved Views（owner-scoped 个人 UI 偏好；不入审计，见 ADMIN_PHASE2_DESIGN §4） ──
async function listSavedViews(request: Request) {
  const actor = await actorWithPermission(request, "dashboard.read");
  const url = new URL(request.url);
  const scope = url.searchParams.get("scope") ?? undefined;
  const items = await prisma.adminSavedView.findMany({
    where: { ownerId: actor.id, scope },
    orderBy: { updatedAt: "desc" },
    take: 100,
  });
  return ok({ items });
}

async function createSavedView(request: Request) {
  const actor = await actorWithPermission(request, "dashboard.read");
  const body = savedViewCreateSchema.parse(await jsonBody(request));
  const view = await prisma.adminSavedView.create({
    data: {
      ownerId: actor.id,
      scope: body.scope,
      label: body.label,
      filters: toInputJson(body.filters),
    },
  });
  return ok({ view });
}

async function deleteSavedView(request: Request, id: string) {
  const actor = await actorWithPermission(request, "dashboard.read");
  // owner-scoped：deleteMany 限定 ownerId，非本人删除命中 0 行 → 404，不泄漏他人视图存在性。
  const result = await prisma.adminSavedView.deleteMany({ where: { id, ownerId: actor.id } });
  if (result.count === 0) throw Errors.notFound("Saved view not found");
  return ok({ deleted: true });
}

// ── F2 Content/Character 目录治理 ──
async function listContentCharacters(request: Request) {
  await actorWithPermission(request, "content.read");
  const url = new URL(request.url);
  const search = url.searchParams.get("search")?.trim();
  const status = url.searchParams.get("status") ?? undefined;
  const visibility = url.searchParams.get("visibility") ?? undefined;
  const creatorId = url.searchParams.get("creatorId") ?? undefined;
  const sort = url.searchParams.get("sort") ?? "recent";
  const limit = clampInt(url.searchParams.get("limit"), 1, 100, 60);
  const queryIdentity = { search, status, visibility, creatorId, sort };
  const cursorKeys = adminListCursorKeys(url, "content_characters", queryIdentity);
  const cursorWhere: Prisma.CharacterWhereInput | undefined = cursorKeys ? (() => {
    const id = adminCursorString(cursorKeys, 1, "content_characters");
    if (sort === "popular") {
      if (cursorKeys[0] === null) {
        return { stats: { is: null }, id: { lt: id } };
      }
      const chatsCount = adminCursorNumber(cursorKeys, 0, "content_characters");
      return { OR: [
        { stats: { is: { chatsCount: { lt: chatsCount } } } },
        { stats: { is: { chatsCount } }, id: { lt: id } },
        { stats: { is: null } },
      ] };
    }
    const createdAt = adminCursorDate(cursorKeys, 0, "content_characters");
    return { OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: id } }] };
  })() : undefined;
  const where: Prisma.CharacterWhereInput = { status, visibility, creatorId, deletedAt: null };
  if (search) {
    where.OR = [{ id: { contains: search } }, { name: { contains: search } }];
  }
  if (cursorWhere && sort !== "popular") where.AND = cursorWhere;
  const select = {
      id: true,
      name: true,
      gender: true,
      style: true,
      status: true,
      visibility: true,
      creatorId: true,
      createdAt: true,
      imageAsset: {
        select: { id: true, url: true, thumbnailUrl: true },
      },
      visualProfiles: {
        where: { status: "active" },
        orderBy: { version: "desc" },
        take: 1,
        select: { id: true, version: true, status: true, style: true },
      },
      stats: { select: { chatsCount: true, likesCount: true, viewsCount: true } },
    } satisfies Prisma.CharacterSelect;
  const items = sort === "popular"
    ? await (async () => {
        const cursorValue = cursorKeys?.[0];
        const cursorId = cursorKeys ? adminCursorString(cursorKeys, 1, "content_characters") : null;
        if (cursorKeys && cursorValue === null) {
          return prisma.character.findMany({
            where: { ...where, stats: { is: null }, id: { lt: cursorId ?? "" } },
            orderBy: { id: "desc" },
            take: limit + 1,
            select,
          });
        }
        const chatsCount = cursorKeys ? adminCursorNumber(cursorKeys, 0, "content_characters") : null;
        const ranked = await prisma.character.findMany({
          where: {
            ...where,
            stats: { isNot: null },
            ...(chatsCount !== null && cursorId ? { AND: [{ OR: [
              { stats: { is: { chatsCount: { lt: chatsCount } } } },
              { stats: { is: { chatsCount } }, id: { lt: cursorId } },
            ] }] } : {}),
          },
          orderBy: [{ stats: { chatsCount: "desc" } }, { id: "desc" }],
          take: limit + 1,
          select,
        });
        if (ranked.length > limit) return ranked;
        const unranked = await prisma.character.findMany({
          where: { ...where, stats: { is: null } },
          orderBy: { id: "desc" },
          take: limit + 1 - ranked.length,
          select,
        });
        return [...ranked, ...unranked];
      })()
    : await prisma.character.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        select,
      });
  const page = items.slice(0, limit);
  return ok({
    items: page,
    pageInfo: adminListPageInfo("content_characters", queryIdentity, page, items.length > limit, (row) => [
      sort === "popular" ? row.stats?.chatsCount ?? null : row.createdAt.toISOString(),
      row.id,
    ]),
  });
}

async function getContentCharacter(request: Request, id: string) {
  await actorWithPermission(request, "content.read");
  const character = await prisma.character.findUnique({
    where: { id },
    include: {
      stats: true,
      creator: { select: { id: true, email: true, displayName: true } },
      tags: true,
    },
  });
  if (!character) throw Errors.notFound("Character not found");
  const [reports, recentJobs] = await Promise.all([
    prisma.contentReport.findMany({
      where: { targetType: "character", targetId: id },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
    prisma.generationJob.findMany({
      where: { characterId: id },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { id: true, mode: true, status: true, createdAt: true },
    }),
  ]);
  // 只投影派生布尔，不把整个 advancedDetails 传给前端（见 chat-tools.ts 的写路径）。
  const chatImageToolEnabled =
    isRecord(character.advancedDetails) && character.advancedDetails.imageToolEnabled === false
      ? false
      : true;
  return ok({ character, reports, recentJobs, chatImageToolEnabled });
}

async function setCharacterVisibility(request: Request, id: string) {
  const actor = await actorWithPermission(request, "content.takedown.write");
  const body = contentVisibilitySchema.parse(await jsonBody(request));
  if (body.confirmation !== contentVisibilityConfirmation(id, body.visibility)) {
    throw Errors.badRequest("Confirmation did not match visibility target");
  }
  const before = await prisma.character.findUnique({ where: { id } });
  if (!before) throw Errors.notFound("Character not found");
  if (before.source === "official") {
    throw Errors.conflict("Official Character visibility is controlled by Character Release and Serving commands", {
      repairDeepLink: `/admin/characters/${id}?tab=release`,
    });
  }
  const after = await prisma.$transaction(async (tx) => {
    const updated = await tx.character.update({ where: { id }, data: { visibility: body.visibility } });
    await tx.adminAuditLog.create({
      data: adminAuditData(request, actor, {
        action: "content.visibility.write",
        targetType: "character",
        targetId: id,
        reason: body.reason,
        before: { visibility: before.visibility },
        after: { visibility: updated.visibility },
      }),
    });
    return updated;
  });
  return ok({ character: { id: after.id, visibility: after.visibility, status: after.status } });
}

function contentVisibilityConfirmation(id: string, visibility: string) {
  return `${id}:visibility:${visibility}`;
}

async function setCharacterStatus(request: Request, id: string) {
  const actor = await actorWithPermission(request, "content.takedown.write");
  const body = contentStatusSchema.parse(await jsonBody(request));
  if (body.confirmation !== contentStatusConfirmation(id, body.status)) {
    throw Errors.badRequest("Confirmation did not match status target");
  }
  const before = await prisma.character.findUnique({ where: { id } });
  if (!before) throw Errors.notFound("Character not found");
  if (before.source === "official") {
    throw Errors.conflict("Official Character status is controlled by Character Release and Serving commands", {
      repairDeepLink: `/admin/characters/${id}?tab=release`,
    });
  }
  const after = await prisma.$transaction(async (tx) => {
    const updated = await tx.character.update({ where: { id }, data: { status: body.status } });
    await tx.adminAuditLog.create({
      data: adminAuditData(request, actor, {
        action: "content.status.write",
        targetType: "character",
        targetId: id,
        reason: body.reason,
        before: { status: before.status },
        after: { status: updated.status },
      }),
    });
    return updated;
  });
  return ok({ character: { id: after.id, visibility: after.visibility, status: after.status } });
}

function contentStatusConfirmation(id: string, status: string) {
  return `${id}:status:${status}`;
}

// ── F3 Featured 策展（AppSetting key=feed.featured；公开 feed 读路径优先展示，见 ourdream/service feed()） ──
function featuredIdsFromSetting(value: Prisma.JsonValue | undefined): string[] {
  return isRecord(value) ? jsonStringArray(value.characterIds) : [];
}

async function getFeaturedCharacters(request: Request) {
  await actorWithPermission(request, "content.read");
  const setting = await prisma.appSetting.findUnique({ where: { key: FEATURED_SETTING_KEY } });
  const ids = featuredIdsFromSetting(setting?.value);
  const characters = ids.length
    ? await prisma.character.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, visibility: true, status: true },
      })
    : [];
  const byId = new Map(characters.map((character) => [character.id, character]));
  const items = ids.map((cid) => byId.get(cid)).filter((value) => value !== undefined);
  return ok({ characterIds: ids, items });
}

async function putFeaturedCharacters(request: Request) {
  const actor = await actorWithPermission(request, "content.takedown.write");
  const body = featuredPutSchema.parse(await jsonBody(request));
  const unique = [...new Set(body.characterIds.map((id) => id.trim()).filter(Boolean))];
  const expectedConfirmation = unique.length > 0 ? unique.join(",") : "CLEAR";
  if (body.confirmation !== expectedConfirmation) {
    throw Errors.badRequest("Confirmation did not match featured target");
  }
  // 仅允许仍 public+approved 的角色进精选，避免精选位指向已下架内容。
  const valid = unique.length
    ? await prisma.character.findMany({
        where: { id: { in: unique }, visibility: "public", status: "approved", deletedAt: null },
        select: { id: true },
      })
    : [];
  const validSet = new Set(valid.map((character) => character.id));
  const validIds = unique.filter((id) => validSet.has(id));
  const before = await prisma.appSetting.findUnique({ where: { key: FEATURED_SETTING_KEY } });
  await prisma.appSetting.upsert({
    where: { key: FEATURED_SETTING_KEY },
    update: { value: toInputJson({ characterIds: validIds }) },
    create: { key: FEATURED_SETTING_KEY, value: toInputJson({ characterIds: validIds }) },
  });
  await writeAudit(request, actor, {
    action: "content.featured.write",
    targetType: "app_setting",
    targetId: FEATURED_SETTING_KEY,
    reason: body.reason,
    before: { characterIds: featuredIdsFromSetting(before?.value) },
    after: { characterIds: validIds },
  });
  return ok({ characterIds: validIds, skipped: unique.filter((id) => !validSet.has(id)) });
}

// ── F6 Chat 运营面（代理到 chat 服务内部 admin 只读 API；尊重 DB 边界，默认不回明文） ──
// INTENT: chat 服务不可达/未配置时降级返回 configured:false（与既有 chat BFF 降级一致），不抛 500。
function recipeAuditSnapshot(template: {
  recipeKey: string;
  mode: string;
  useCase: string;
  version: number;
  status: string;
}) {
  return {
    recipeKey: template.recipeKey,
    mode: template.mode,
    useCase: template.useCase,
    version: template.version,
    status: template.status,
  };
}

// SPEC: 双人审批硬门控（ADMIN_PHASE3_DESIGN §5.2）。feature flag `dual_approval_enforced`
// 开启时，高危执行端点须先存在一条 action+targetId 匹配且 status=approved 的 AdminActionRequest；
// 执行前消费它（status=consumed，一次性防重放）。flag 关闭（受控 beta 默认）→ 不强制，行为不变。
// INVARIANTS: 无凭据→403；有凭据→放行并消费；同凭据二次执行→无可用凭据→403。
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function adminListCursorKeys(
  url: URL,
  scope: string,
  queryIdentity: unknown,
  parameter = "cursor",
) {
  const raw = url.searchParams.get(parameter);
  if (!raw) return undefined;
  return decodeAdminListCursor(raw, scope, queryIdentity);
}

function adminCursorString(keys: readonly unknown[], index: number, scope: string) {
  const value = keys[index];
  if (typeof value !== "string" || !value) throw Errors.badRequest(`${scope} cursor key is invalid`);
  return value;
}

function adminCursorNumber(keys: readonly unknown[], index: number, scope: string) {
  const value = keys[index];
  if (typeof value !== "number" || !Number.isFinite(value)) throw Errors.badRequest(`${scope} cursor key is invalid`);
  return value;
}

function adminCursorDate(keys: readonly unknown[], index: number, scope: string) {
  const value = new Date(adminCursorString(keys, index, scope));
  if (Number.isNaN(value.getTime())) throw Errors.badRequest(`${scope} cursor timestamp is invalid`);
  return value;
}

function adminListPageInfo<T>(
  scope: string,
  queryIdentity: unknown,
  page: readonly T[],
  hasNextPage: boolean,
  keys: (row: T) => readonly (string | number | boolean | null)[],
) {
  const last = page.at(-1);
  return {
    endCursor: hasNextPage && last ? encodeAdminListCursor(scope, queryIdentity, keys(last)) : null,
    hasNextPage,
  };
}
