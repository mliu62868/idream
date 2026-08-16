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

import {
  getContentCharacter,
  getFeaturedCharacters,
  listContentCharacters,
  putFeaturedCharacters,
  setCharacterStatus,
  setCharacterTags,
  setCharacterVisibility,
} from "./content/merchandising";

type ApiMethod = "GET" | "POST" | "PATCH" | "DELETE" | "PUT";

export async function dispatchAdmin(request: Request, segments: string[]) {
  const method = request.method as ApiMethod;
  const [resource, id, action, child, grandchild] = segments;



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


  throw Errors.notFound("Admin API route not found", { path: `/admin/${segments.join("/")}` });
}
