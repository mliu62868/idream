import { Errors } from "@/server/lib/errors";
export {
  actorWithPermission,
  clampInt,
  jsonBody,
  toInputJson,
  writeAudit,
  type AdminActor,
} from "@/server/modules/admin/shared/legacy-primitives";
import { retiredCreativeWrite } from "./shared/retired-creative-write";
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
import { setCharacterChatTools } from "./characters/chat-tools";
import { generateProductionDirections } from "./production-directions";
import {
  approveProductionItem,
  estimateProductionBatch,
  getProductionBatch,
  listProductionBatches,
  regenerateProductionItem,
  rejectProductionItem,
} from "./content/production-batches";
import {
  bulkPatchContentAssets,
  getContentAsset,
  listContentAssets,
  patchContentAsset,
  preflightContentAssetArchive,
} from "./content/assets";
import {
  createPlacement,
  getPlacement,
  listPlacements,
  patchPlacement,
} from "./content/placements";

import { listCmsPages, getCmsPage, createCmsPage, patchCmsPage, publishCmsPage } from "./cms";
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
  chatOpsModerationEvents,
  chatOpsOverview,
  chatOpsProviderHealth,
  chatOpsSessions,
  chatOpsUsage,
} from "./chat/service";
import {
  getContentCharacter,
  getFeaturedCharacters,
  listContentCharacters,
  putFeaturedCharacters,
  setCharacterStatus,
  setCharacterTags,
  setCharacterVisibility,
} from "./content/merchandising";
import { analyticsOverview, providerOps } from "./overviews/service";
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


  if (resource === "analytics" && id === "overview" && !action && method === "GET") {
    return analyticsOverview(request);
  }

  if (resource === "ops" && id === "providers" && !action && method === "GET") {
    return providerOps(request);
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
    if (action && child === "tags" && method === "PUT") {
      return setCharacterTags(request, action);
    }
    if (action && child === "visual-profiles" && method === "GET") {
      return listCharacterVisualProfiles(request, action);
    }
    if (action && child === "visual-profiles" && method === "POST") {
      return createCharacterVisualProfile(request, action);
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
    if (action === "batches" && !child && method === "POST") {
      return retiredCreativeWrite(request, {
        deepLink: "/admin/creative/runs",
      });
    }
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
    if (action === "bulk" && child === "preflight" && method === "POST") {
      return preflightContentAssetArchive(request);
    }
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
