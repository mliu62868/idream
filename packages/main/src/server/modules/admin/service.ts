import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, open, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import type { ImageGeneratePayload, VideoGeneratePayload } from "@/server/ai/schemas";
import { imageReferenceInputsForGenerationJob } from "@/server/ai/reference-images";
import { ensureGenerationSettlementLinks, linkGenerationLedgerEntry } from "@/server/ai/generation-settlement";
import {
  recordGenerationAttemptEvent,
  recordGenerationAttemptQueuedEvent,
} from "@/server/ai/generation-attempt-events";
import { resolveLocalBlobPath } from "@idream/shared/storage/local-blob";
import { jobQueue } from "@/server/jobs/queue";
import {
  applyOverrides,
  isPermissionKey,
  resolvePermissions,
  type PermissionKey,
} from "@/server/admin/permissions";
import { effectiveCharacterIdsForPermission, effectivePermissions } from "@/server/admin/effective-permissions";
import { getAuthCtx, requireUser, type ActorRole } from "@/server/lib/auth";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import { verifyAdminBffRequest } from "@/server/modules/admin-v2/shared/admin-bff";
import { redeemCodeHash, redeemCodeHashCandidates } from "@/server/lib/redeem-codes";
import { dimensionsForImageOrientation } from "@/server/modules/ourdream/generation-dimensions";
import {
  listOfficialCharacters,
  createOfficialCharacter,
  updateOfficialCharacter,
  setOfficialState,
} from "./characters/official";
import {
  listTemplates,
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
  deriveGenerationJobState,
  deriveGenerationTimeline,
} from "./generation-job-state";
import {
  getGenerationWorkflow,
  listGenerationBackends,
  listGenerationWorkflows,
  workflowKeyExists,
} from "./generation-catalog";
import { analyticsExport, analyticsRetention } from "./analytics-extra";
import {
  listAdminAnnouncements,
  createAnnouncement,
  patchAnnouncement,
  deleteAnnouncement,
} from "./announcements";
import { listExperiments } from "./experiments";
import {
  ensureReviewCaseForAppeal,
  ensureReviewCaseForReport,
  recordReviewCaseDecision,
  synchronizeSupportCaseFromRequest,
} from "@/server/modules/admin-v2/cases/service";

const FEATURED_SETTING_KEY = "feed.featured";

type ApiMethod = "GET" | "POST" | "PATCH" | "DELETE" | "PUT";
export type AdminActor = { id: string; role: ActorRole };
type PlaintextFields = Record<string, string | null>;

const adminDecisionSchema = z.object({
  decision: z.enum(["actioned", "no_violation", "duplicate", "escalated", "closed"]),
  policyCode: z.string().max(120).optional(),
  notes: z.string().max(2_000).optional(),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

const appealDecisionSchema = z.object({
  outcome: z.enum(["upheld", "overturned", "modified", "open"]),
  notes: z.string().trim().max(2_000).optional(),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

const statusChangeSchema = z.object({
  status: z.enum(["active", "suspended"]),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

const roleChangeSchema = z.object({
  role: z.enum(["user", "moderator", "support", "ops", "analyst", "admin"]),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

const permissionOverrideSchema = z.object({
  permissionKey: z.string().trim().min(1).max(80),
  effect: z.enum(["grant", "revoke", "clear"]),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

const requeueSchema = z.object({
  reason: z.string().trim().max(2_000).optional(),
  confirmation: z.string().trim().min(1).max(160),
});

const discardSchema = z.object({
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

const deadLetterBatchSchema = z.object({
  jobIds: z.array(z.string().trim().min(1).max(160)).min(1).max(100),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(20_000),
});

const flagPatchSchema = z.object({
  enabled: z.boolean().optional(),
  rolloutPercent: z.number().int().min(0).max(100).optional(),
  targetRoles: z.array(z.string()).optional(),
  targetPlans: z.array(z.string()).optional(),
  description: z.string().max(500).optional(),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

const ledgerAdjustmentSchema = z.object({
  userId: z.string().trim().min(1),
  delta: z.number().int().refine((value) => value !== 0),
  reason: z.string().trim().min(3).max(2_000),
  sourceId: z.string().trim().max(160).optional(),
  confirmation: z.string().trim().min(1).max(160),
});

const modelProfileSchema = z.object({
  profileKey: z.string().trim().min(1).max(120),
  label: z.string().trim().min(1).max(120),
  mode: z.enum(["image", "video"]).default("image"),
  runner: z.enum(["pipeline", "sd_cpp", "mlx", "comfyui", "external"]).default("sd_cpp"),
  pipelineModel: z.string().trim().min(1).max(160),
  workflowKey: z.string().trim().min(1).max(160).nullable().optional(),
  sourceModelPath: z.string().trim().max(500).nullable().optional(),
  convertedModelPath: z.string().trim().max(500).nullable().optional(),
  modelFormat: z.enum(["safetensors", "gguf", "diffusers", "external"]).default("safetensors"),
  runnerConfig: z.record(z.string(), z.unknown()).optional(),
  defaultWidth: z.number().int().min(128).max(4096).default(768),
  defaultHeight: z.number().int().min(128).max(4096).default(1024),
  allowedOrientations: z.array(z.string().trim().min(1).max(20)).min(1).max(12),
  steps: z.number().int().min(1).max(150).default(28),
  sampler: z.string().trim().min(1).max(80).default("euler"),
  scheduler: z.string().trim().min(1).max(80).default("model_default"),
  cfgScale: z.number().min(1).max(30).default(1),
  costMultiplier: z.number().min(0.1).max(20).default(1),
  requiredEntitlement: z.string().trim().max(120).nullable().optional(),
  maxCount: z.number().int().min(1).max(8).default(4),
  concurrencyLimit: z.number().int().min(1).max(100).default(1),
  enabled: z.boolean().default(false),
  rolloutPercent: z.number().int().min(0).max(100).default(0),
  dryRunSummary: z.record(z.string(), z.unknown()).optional(),
});

const modelProfilePatchSchema = z.object({
  profileKey: z.string().trim().min(1).max(120).optional(),
  label: z.string().trim().min(1).max(120).optional(),
  mode: z.enum(["image", "video"]).optional(),
  runner: z.enum(["pipeline", "sd_cpp", "mlx", "comfyui", "external"]).optional(),
  pipelineModel: z.string().trim().min(1).max(160).optional(),
  workflowKey: z.string().trim().min(1).max(160).nullable().optional(),
  sourceModelPath: z.string().trim().max(500).nullable().optional(),
  convertedModelPath: z.string().trim().max(500).nullable().optional(),
  modelFormat: z.enum(["safetensors", "gguf", "diffusers", "external"]).optional(),
  runnerConfig: z.record(z.string(), z.unknown()).optional(),
  defaultWidth: z.number().int().min(128).max(4096).optional(),
  defaultHeight: z.number().int().min(128).max(4096).optional(),
  allowedOrientations: z.array(z.string().trim().min(1).max(20)).min(1).max(12).optional(),
  steps: z.number().int().min(1).max(150).optional(),
  sampler: z.string().trim().min(1).max(80).optional(),
  scheduler: z.string().trim().min(1).max(80).optional(),
  cfgScale: z.number().min(1).max(30).optional(),
  costMultiplier: z.number().min(0.1).max(20).optional(),
  requiredEntitlement: z.string().trim().max(120).nullable().optional(),
  maxCount: z.number().int().min(1).max(8).optional(),
  concurrencyLimit: z.number().int().min(1).max(100).optional(),
  enabled: z.boolean().optional(),
  rolloutPercent: z.number().int().min(0).max(100).optional(),
  dryRunSummary: z.record(z.string(), z.unknown()).optional(),
  reason: z.string().trim().min(3).max(2_000).optional(),
  confirmation: z.string().trim().min(1).max(160).optional(),
});

const modelProfileTestJobSchema = z.object({
  prompt: z.string().trim().max(2_000).optional(),
  negativePrompt: z.string().trim().max(1_000).nullable().optional(),
  orientation: z.string().trim().min(1).max(20).optional(),
  outputCount: z.number().int().min(1).max(4).default(1),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

const modelImportKindSchema = z.enum(["model", "lora", "llm", "vae"]);

const modelImportRegisterSchema = z.object({
  kind: modelImportKindSchema.default("model"),
  path: z.string().trim().min(1).max(1_000),
  copyToLibrary: z.boolean().default(false),
  reason: z.string().trim().min(3).max(2_000).optional(),
});

const optionalTrimmedText = (max: number) =>
  z.preprocess(
    (value) => {
      if (value === null) return undefined;
      if (typeof value === "string" && value.trim() === "") return undefined;
      return value;
    },
    z.string().trim().min(1).max(max).optional(),
  );

const sdcppLoraSchema = z
  .object({
    key: optionalTrimmedText(160),
    path: optionalTrimmedText(500),
    weight: z.number().min(-4).max(4).default(1),
    enabled: z.boolean().default(true),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    if (!value.key && !value.path) {
      ctx.addIssue({
        code: "custom",
        message: "LoRA entry requires key or path",
        path: ["key"],
      });
    }
  });

const sdcppConversionSchema = z
  .object({
    enabled: z.boolean().default(false),
    targetFormat: z.enum(["gguf"]).default("gguf"),
    outputPath: z.string().trim().max(500).optional(),
    type: z.string().trim().min(1).max(40).default("q8_0"),
    sourceArg: z.enum(["model", "diffusion-model"]).default("model"),
    convertName: z.boolean().default(false),
    tensorTypeRules: z.string().trim().max(1_000).optional(),
  })
  .passthrough();

const modelCapabilitiesSchema = z
  .object({
    textToImage: z.boolean().optional(),
    stableSeed: z.boolean().optional(),
    referenceImages: z.boolean().optional(),
    initImage: z.boolean().optional(),
    lora: z.boolean().optional(),
  })
  .passthrough();

const sdcppRunnerConfigSchema = z
  .object({
    apiModelId: z.string().trim().min(1).max(160).optional(),
    cliPath: optionalTrimmedText(500),
    modelPath: optionalTrimmedText(500),
    diffusionModelPath: optionalTrimmedText(500),
    llmPath: optionalTrimmedText(500),
    vaePath: optionalTrimmedText(500),
    llmVisionPath: optionalTrimmedText(500),
    clipLPath: optionalTrimmedText(500),
    clipGPath: optionalTrimmedText(500),
    t5xxlPath: optionalTrimmedText(500),
    backend: optionalTrimmedText(120),
    loraModelDir: optionalTrimmedText(500),
    loraApplyMode: z.enum(["auto", "immediately", "at_runtime"]).optional(),
    loras: z.array(sdcppLoraSchema).max(24).optional(),
    conversion: sdcppConversionSchema.optional(),
    capabilities: modelCapabilitiesSchema.optional(),
  })
  .passthrough();

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

const imageProfilePublishMinSamples = 20;
const modelProfilePublishMinRate = 0.8;

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

const pricingRuleSchema = z.object({
  ruleKey: z.string().trim().min(1).max(120),
  label: z.string().trim().min(1).max(120),
  mode: z.enum(["image", "video", "voice"]).default("image"),
  baseCost: z.number().int().min(0).max(100_000),
  multiplier: z.number().min(0.1).max(20).default(1),
  effectiveFrom: z.string().datetime().optional(),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

// ruleKey/mode 在 create 后不可改：避免一条 draft 的 mode 漂离其 ruleKey 版本谱系。
const pricingRulePatchSchema = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  baseCost: z.number().int().min(0).max(100_000).optional(),
  multiplier: z.number().min(0.1).max(20).optional(),
  effectiveFrom: z.string().datetime().nullable().optional(),
});

const pricingPublishSchema = z.object({
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
  effectiveFrom: z.string().datetime().optional(),
});

const plaintextViewSchema = z.object({
  targetType: z.enum(["generation_job", "media"]),
  targetId: z.string().trim().min(1).max(160),
  ticketId: z.string().trim().max(160).optional(),
  legalHoldId: z.string().trim().max(160).optional(),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
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

const redeemCodeCreateSchema = z.object({
  code: z.string().trim().min(4).max(80),
  reward: z
    .object({
      dreamcoins: z.number().int().min(0).max(1_000_000).optional(),
      note: z.string().trim().max(200).optional(),
    })
    .passthrough(),
  maxRedemptions: z.number().int().min(1).max(1_000_000).nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

const promoDisableSchema = z.object({
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

const supportRequestPatchSchema = z.object({
  status: z.enum(["received", "open", "waiting_on_user", "resolved", "closed"]).optional(),
  assignedToId: z.string().trim().min(1).max(160).nullable().optional(),
  priority: z.number().int().min(1).max(5).optional(),
  resolutionNotes: z.string().trim().max(2_000).nullable().optional(),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

const supportRequestEscalateSchema = z.object({
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

// requestedById≠approvedById、approver 须持 permissionKey、状态单向（ADMIN_CONSOLE_PLAN §11 Phase4）。
const approvalCreateSchema = z.object({
  permissionKey: z.string().trim().min(1).max(80),
  action: z.string().trim().min(1).max(120),
  targetType: z.string().trim().min(1).max(80),
  targetId: z.string().trim().min(1).max(160),
  payload: z.record(z.string(), z.unknown()).default({}),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

const approvalDecisionSchema = z.object({
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

function modelDiagnosticsEnabled() {
  return process.env.ADMIN_MODEL_DIAGNOSTICS_ENABLED === "true";
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

async function listUsers(request: Request) {
  await actorWithPermission(request, "user.read");
  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim();
  const users = await prisma.user.findMany({
    where: q
      ? {
          OR: [
            { id: { contains: q } },
            { email: { contains: q } },
            { displayName: { contains: q } },
          ],
        }
      : undefined,
    include: {
      subscriptions: {
        include: { plan: true },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
    orderBy: { createdAt: "desc" },
    take: clampInt(url.searchParams.get("limit"), 1, 100, 40),
  });
  const items = await Promise.all(
    users.map(async (user) => ({
      id: user.id,
      email: user.email,
      displayName: user.displayName ?? user.name,
      role: user.role,
      status: user.status,
      createdAt: user.createdAt,
      plan: user.subscriptions[0]?.plan
        ? {
            slug: user.subscriptions[0].plan.slug,
            billingPeriod: user.subscriptions[0].plan.billingPeriod,
            status: user.subscriptions[0].status,
          }
        : null,
      dreamcoins: await dreamcoinBalance(user.id),
    })),
  );

  return ok({ items });
}

async function getUserDetail(request: Request, userId: string) {
  await actorWithPermission(request, "user.read");
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      preferences: true,
      subscriptions: {
        include: { plan: true },
        orderBy: { createdAt: "desc" },
        take: 5,
      },
      entitlements: { orderBy: { createdAt: "desc" } },
      ledgerEntries: { orderBy: { createdAt: "desc" }, take: 25 },
      ageVerifications: { orderBy: { createdAt: "desc" }, take: 3 },
      generationJobs: { orderBy: { createdAt: "desc" }, take: 8 },
    },
  });
  if (!user) throw Errors.notFound("User not found");

  return ok({
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName ?? user.name,
      role: user.role,
      status: user.status,
      createdAt: user.createdAt,
      ageVerification: user.ageVerifications[0] ?? null,
      preferences: user.preferences,
    },
    subscriptions: user.subscriptions,
    entitlements: user.entitlements,
    ledger: user.ledgerEntries,
    dreamcoins: { balance: await dreamcoinBalance(user.id) },
    generationJobs: user.generationJobs.map(redactJob),
  });
}

async function updateUserStatus(request: Request, userId: string) {
  const actor = await actorWithPermission(request, "user.status.write");
  const body = statusChangeSchema.parse(await jsonBody(request));
  if (body.confirmation !== userStatusConfirmation(userId, body.status)) {
    throw Errors.badRequest("Confirmation did not match user status target");
  }
  const before = await prisma.user.findUnique({ where: { id: userId } });
  if (!before) throw Errors.notFound("User not found");
  const after = await prisma.user.update({
    where: { id: userId },
    data: { status: body.status, deletedAt: body.status === "active" ? null : undefined },
  });
  await writeAudit(request, actor, {
    action: "user.status.write",
    targetType: "user",
    targetId: userId,
    reason: body.reason,
    before: { status: before.status },
    after: { status: after.status },
  });
  return ok({ user: publicUser(after) });
}

function userStatusConfirmation(userId: string, status: string) {
  return `${userId}:${status}`;
}

async function updateUserRole(request: Request, userId: string) {
  const actor = await actorWithPermission(request, "user.role.write");
  const body = roleChangeSchema.parse(await jsonBody(request));
  if (body.confirmation !== userRoleConfirmation(userId, body.role)) {
    throw Errors.badRequest("Confirmation did not match role-change target");
  }
  const before = await prisma.user.findUnique({ where: { id: userId } });
  if (!before) throw Errors.notFound("User not found");
  const after = await prisma.user.update({
    where: { id: userId },
    data: { role: body.role },
  });
  await writeAudit(request, actor, {
    action: "user.role.write",
    targetType: "user",
    targetId: userId,
    reason: body.reason,
    before: { role: before.role },
    after: { role: after.role },
  });
  return ok({ user: publicUser(after) });
}

function userRoleConfirmation(userId: string, role: string) {
  return `${userId}:${role}`;
}

// SPEC: 用户级权限覆盖管理 —— 给单个用户 grant/revoke/clear 某 permission key，admin only，全部审计。
// INTENT: 不动 role 就能精确授予/收回能力（如给某 support 临时 billing.ledger.adjust）；解析见 effective-permissions。
// INVARIANTS: 一个 key 至多一条 override（写前清同 key 旧 override）；grant 的 key 必须是合法 PermissionKey；硬政策无 key 可授。
async function listUserPermissions(request: Request, userId: string) {
  await actorWithPermission(request, "user.role.write");
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw Errors.notFound("User not found");
  const overrides = await prisma.adminUserPermission.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
  const effective = [...applyOverrides(resolvePermissions(user.role as ActorRole), overrides)].sort();
  return ok({ role: user.role, overrides, effective });
}

async function setUserPermission(request: Request, userId: string) {
  const actor = await actorWithPermission(request, "user.role.write");
  const body = permissionOverrideSchema.parse(await jsonBody(request));
  if (body.confirmation !== permissionOverrideConfirmation(userId, body.permissionKey, body.effect)) {
    throw Errors.badRequest("Confirmation did not match permission-override target");
  }
  if (body.effect !== "clear" && !isPermissionKey(body.permissionKey)) {
    throw Errors.badRequest("Unknown permission key");
  }
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw Errors.notFound("User not found");
  // 一个 key 至多一条 override：先清同 key 旧记录，再按 effect 写。
  await prisma.adminUserPermission.deleteMany({
    where: { userId, permissionKey: body.permissionKey },
  });
  const override =
    body.effect === "clear"
      ? null
      : await prisma.adminUserPermission.create({
          data: {
            userId,
            permissionKey: body.permissionKey,
            effect: body.effect,
            reason: body.reason,
            createdById: actor.id,
          },
        });
  await writeAudit(request, actor, {
    action:
      body.effect === "grant"
        ? "admin.permission.grant"
        : body.effect === "revoke"
          ? "admin.permission.revoke"
          : "admin.permission.clear",
    targetType: "user",
    targetId: userId,
    reason: body.reason,
    after: { permissionKey: body.permissionKey, effect: body.effect },
  });
  return ok({ override, cleared: body.effect === "clear" });
}

function permissionOverrideConfirmation(userId: string, permissionKey: string, effect: string) {
  return `${userId}:${permissionKey}:${effect}`;
}

async function listGenerationJobs(request: Request) {
  await actorWithPermission(request, "generation.job.read");
  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? undefined;
  const mode = url.searchParams.get("mode") ?? "image";
  const userId = url.searchParams.get("userId") ?? undefined;
  const jobs = await prisma.generationJob.findMany({
    where: {
      status,
      mode: mode === "all" ? undefined : mode,
      userId,
    },
    include: {
      user: true,
      assets: true,
    },
    orderBy: { createdAt: "desc" },
    take: clampInt(url.searchParams.get("limit"), 1, 100, 50),
  });
  return ok({ items: jobs.map((job) => redactJob(job)) });
}

async function getGenerationJobDetail(request: Request, jobId: string) {
  await actorWithPermission(request, "generation.job.read");
  const job = await prisma.generationJob.findUnique({
    where: { id: jobId },
    include: {
      user: true,
      character: true,
      assets: true,
      events: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!job) throw Errors.notFound("Generation job not found");
  const [moderationEvents, ledger] = await Promise.all([
    prisma.moderationEvent.findMany({
      where: { targetType: "generation_job", targetId: job.id },
      orderBy: { createdAt: "asc" },
    }),
    prisma.dreamcoinLedger.findMany({
      where: { sourceId: job.id },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  const state = deriveGenerationJobState({
    status: job.status,
    completedAt: job.completedAt,
    finishedAt: job.finishedAt,
    errorCode: job.errorCode,
    assets: job.assets,
    events: job.events,
    ledgerEntries: ledger,
  });

  return ok({
    job: redactJob(job),
    user: publicUser(job.user),
    character: job.character
      ? { id: job.character.id, name: job.character.name, status: job.character.status }
      : null,
    assets: job.assets.map((asset) => ({
      id: asset.id,
      type: asset.type,
      url: asset.url,
      thumbnailUrl: asset.thumbnailUrl,
      safetyStatus: asset.safetyStatus,
      createdAt: asset.createdAt,
    })),
    providerError: job.errorCode ? { code: job.errorCode } : null,
    ledger,
    state,
    timeline: deriveGenerationTimeline({
      status: job.status,
      completedAt: job.completedAt,
      events: job.events,
      moderationEvents,
      ledgerEntries: ledger,
    }),
  });
}

async function requeueGenerationJob(request: Request, jobId: string) {
  const actor = await actorWithPermission(request, "generation.job.requeue");
  const body = requeueSchema.parse(await jsonBody(request));
  if (body.confirmation !== jobId) {
    throw Errors.badRequest("Confirmation did not match requeue target");
  }
  const job = await prisma.generationJob.findUnique({
    where: { id: jobId },
    include: { assets: true, events: { orderBy: { createdAt: "asc" } } },
  });
  if (!job) throw Errors.notFound("Generation job not found");
  const ledger = await prisma.dreamcoinLedger.findMany({
    where: { sourceId: job.id, reason: "refund" },
  });
  const state = deriveGenerationJobState({
    status: job.status,
    completedAt: job.completedAt,
    finishedAt: job.finishedAt,
    errorCode: job.errorCode,
    assets: job.assets,
    events: job.events,
    ledgerEntries: ledger,
  });
  if (!state.retryEligibility.eligible) {
    throw Errors.conflict("Generation job is not eligible for retry", {
      reason: state.retryEligibility.reason,
    });
  }

  await prisma.generationJob.update({
    where: { id: job.id },
    data: { status: "queued", errorCode: null },
  });
  await enqueueExistingGenerationJob(job);
  await writeAudit(request, actor, {
    action: "ops.deadletter.requeue",
    targetType: "generation_job",
    targetId: job.id,
    reason: body.reason,
    before: { status: job.status, errorCode: job.errorCode },
    after: { status: "queued" },
  });
  return ok({ queued: true });
}

async function discardGenerationJob(request: Request, jobId: string) {
  const actor = await actorWithPermission(request, "ops.deadletter.write");
  const body = discardSchema.parse(await jsonBody(request));
  if (body.confirmation !== jobId) {
    throw Errors.badRequest("Confirmation did not match discard target");
  }
  const job = await prisma.generationJob.findUnique({ where: { id: jobId } });
  if (!job) throw Errors.notFound("Generation job not found");
  if (!["failed", "blocked", "refunded"].includes(job.status)) {
    throw Errors.badRequest("Only failed, blocked, or refunded jobs can be discarded");
  }
  // Guard + refund inside one transaction, keyed on the same idempotency key the
  // generation pipeline uses, so a refund already issued elsewhere never doubles.
  const refundedNow = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "generation_jobs" WHERE id = ${job.id} FOR UPDATE`;
    const settlement = await ensureGenerationSettlementLinks(tx, job.id);
    const amount = Math.min(job.costDreamcoins, settlement.refundable);
    const willRefund = amount > 0;
    if (willRefund) {
      await appendLedger(
        tx,
        job.userId,
        amount,
        "refund",
        job.id,
        `generation:${job.id}:refund`,
      );
    }
    await tx.generationJob.update({
      where: { id: job.id },
      data: { errorCode: job.errorCode ?? "discarded", version: { increment: 1 } },
    });
    return willRefund;
  });
  await writeAudit(request, actor, {
    action: "ops.deadletter.discard",
    targetType: "generation_job",
    targetId: job.id,
    reason: body.reason,
    before: { status: job.status, errorCode: job.errorCode },
    after: { status: job.status, settlement: refundedNow ? "refunded" : "already_settled", refunded: refundedNow },
  });
  return ok({ discarded: true, refunded: refundedNow });
}

// SPEC: Dead-letter 运营台 —— 列出重试耗尽/不可恢复（failed|blocked）的 job，支持单/批 requeue 与 discard。
// INTENT: 单/批 requeue 与 discard 都绑定具体 job id 确认；批量记一条审计 + 子项列表（§12）。
// INVARIANTS: 退款幂等 —— 已有 refund ledger 的 job 不再二次退款；requeue 跳过已退款 job。
async function deadLetterQueue(request: Request) {
  await actorWithPermission(request, "ops.queue.read");
  const url = new URL(request.url);
  const statusParam = url.searchParams.get("status");
  const statuses = statusParam
    ? statusParam.split(",").map((status) => status.trim()).filter(Boolean)
    : ["failed", "blocked"];
  const errorCode = url.searchParams.get("errorCode")?.trim() || undefined;
  const mode = url.searchParams.get("mode")?.trim();
  const jobs = await prisma.generationJob.findMany({
    where: {
      status: { in: statuses },
      errorCode: errorCode ? { contains: errorCode } : undefined,
      mode: mode && mode !== "all" ? mode : undefined,
    },
    include: { assets: true, events: { orderBy: { createdAt: "asc" } } },
    orderBy: { updatedAt: "desc" },
    take: clampInt(url.searchParams.get("limit"), 1, 200, 100),
  });
  const refundedIds = await refundedJobIds(jobs.map((job) => job.id));
  return ok({
    items: jobs.map((job) => ({
      ...redactJob(job),
      ledgerState: refundedIds.has(job.id) ? "refunded" : "reserved",
      retryEligibility: deriveGenerationJobState({
        status: job.status,
          completedAt: job.completedAt,
          finishedAt: job.finishedAt,
        errorCode: job.errorCode,
        assets: job.assets,
        events: job.events,
        ledgerEntries: refundedIds.has(job.id)
          ? [{ reason: "refund", delta: job.costDreamcoins }]
          : [],
      }).retryEligibility,
    })),
  });
}

async function requeueDeadLetterBatch(request: Request) {
  const actor = await actorWithPermission(request, "generation.job.requeue");
  const body = deadLetterBatchSchema.parse(await jsonBody(request));
  if (body.confirmation !== deadLetterBatchConfirmation(body.jobIds)) {
    throw Errors.badRequest("Batch requeue confirmation did not match selected jobs");
  }
  const jobs = await prisma.generationJob.findMany({
    where: { id: { in: body.jobIds } },
    include: { assets: true, events: { orderBy: { createdAt: "asc" } } },
  });
  const refundedIds = await refundedJobIds(body.jobIds);
  const requeued: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const job of jobs) {
    const retryEligibility = deriveGenerationJobState({
      status: job.status,
      completedAt: job.completedAt,
      finishedAt: job.finishedAt,
      errorCode: job.errorCode,
      assets: job.assets,
      events: job.events,
      ledgerEntries: refundedIds.has(job.id)
        ? [{ reason: "refund", delta: job.costDreamcoins }]
        : [],
    }).retryEligibility;
    if (!retryEligibility.eligible) {
      skipped.push({ id: job.id, reason: retryEligibility.reason });
      continue;
    }
    await prisma.generationJob.update({
      where: { id: job.id },
      data: { status: "queued", errorCode: null },
    });
    await enqueueExistingGenerationJob(job);
    requeued.push(job.id);
  }
  for (const id of missingIds(body.jobIds, jobs)) skipped.push({ id, reason: "not_found" });
  await writeAudit(request, actor, {
    action: "ops.deadletter.requeue",
    targetType: "generation_job_batch",
    targetId: `${body.jobIds.length} jobs`,
    reason: body.reason,
    after: { requeued, skipped },
  });
  return ok({ requeued, skipped });
}

async function discardDeadLetterBatch(request: Request) {
  const actor = await actorWithPermission(request, "ops.deadletter.write");
  const body = deadLetterBatchSchema.parse(await jsonBody(request));
  if (body.confirmation !== deadLetterBatchConfirmation(body.jobIds)) {
    throw Errors.badRequest("Batch discard confirmation did not match selected jobs");
  }
  const jobs = await prisma.generationJob.findMany({ where: { id: { in: body.jobIds } } });
  const discarded: string[] = [];
  const refundedNow: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const job of jobs) {
    if (!["failed", "blocked", "refunded"].includes(job.status)) {
      skipped.push({ id: job.id, reason: "not_discardable" });
      continue;
    }
    // Re-check + refund inside the transaction, keyed idempotently so a refund
    // issued by the pipeline (or a concurrent discard) is never doubled.
    const didRefund = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "generation_jobs" WHERE id = ${job.id} FOR UPDATE`;
      const settlement = await ensureGenerationSettlementLinks(tx, job.id);
      const amount = Math.min(job.costDreamcoins, settlement.refundable);
      const willRefund = amount > 0;
      if (willRefund) {
        await appendLedger(
          tx,
          job.userId,
          amount,
          "refund",
          job.id,
          `generation:${job.id}:refund`,
        );
      }
      await tx.generationJob.update({
        where: { id: job.id },
        data: { errorCode: job.errorCode ?? "discarded", version: { increment: 1 } },
      });
      return willRefund;
    });
    discarded.push(job.id);
    if (didRefund) refundedNow.push(job.id);
  }
  for (const id of missingIds(body.jobIds, jobs)) skipped.push({ id, reason: "not_found" });
  await writeAudit(request, actor, {
    action: "ops.deadletter.discard",
    targetType: "generation_job_batch",
    targetId: `${body.jobIds.length} jobs`,
    reason: body.reason,
    after: { discarded, refunded: refundedNow, skipped },
  });
  return ok({ discarded, refunded: refundedNow, skipped });
}

async function refundedJobIds(jobIds: string[]) {
  if (jobIds.length === 0) return new Set<string>();
  const refunds = await prisma.dreamcoinLedger.findMany({
    where: { sourceId: { in: jobIds }, reason: "refund" },
    select: { sourceId: true },
  });
  return new Set(refunds.map((entry) => entry.sourceId).filter((id): id is string => Boolean(id)));
}

function missingIds(requested: string[], found: { id: string }[]) {
  const foundIds = new Set(found.map((job) => job.id));
  return requested.filter((id) => !foundIds.has(id));
}

function deadLetterBatchConfirmation(jobIds: string[]) {
  return jobIds.join(",");
}

async function listModelProfiles(request: Request) {
  await actorWithPermission(request, "generation.config.read");
  const url = new URL(request.url);
  const mode = url.searchParams.get("mode") ?? undefined;
  const profiles = await prisma.generationModelProfile.findMany({
    where: { mode },
    orderBy: [{ profileKey: "asc" }, { version: "desc" }],
  });
  return ok({ items: profiles });
}

type ModelImportKind = z.infer<typeof modelImportKindSchema>;

type ModelImportAsset = {
  kind: ModelImportKind;
  name: string;
  path: string;
  format: "safetensors" | "gguf";
  sizeBytes: number;
  modifiedAt: string;
  draftPatch: Record<string, unknown>;
};

type ModelImportRegistryEntry = {
  kind: ModelImportKind;
  path: string;
  registeredAt: string;
};

type ModelImportRegistry = {
  version: 1;
  assets: ModelImportRegistryEntry[];
};

const modelImportRegistrySchema = z.object({
  version: z.number().optional(),
  assets: z
    .array(
      z.object({
        kind: modelImportKindSchema,
        path: z.string().trim().min(1).max(1_000),
        registeredAt: z.string().trim().optional(),
      }),
    )
    .default([]),
});

const IMPORT_EXTENSIONS: Record<ModelImportKind, string[]> = {
  model: [".safetensors", ".gguf"],
  lora: [".safetensors"],
  llm: [".gguf", ".safetensors"],
  vae: [".safetensors", ".gguf"],
};

async function listModelImports(request: Request) {
  await actorWithPermission(request, "generation.config.read");
  const dirs = modelImportDirs();
  const scannedItems = (
    await Promise.all((["model", "lora", "llm", "vae"] as const).map((kind) => scanImportDir(kind, dirs[kind])))
  ).flat();
  const registeredItems = await registeredModelImportAssets();
  const items = dedupeModelImportAssets([...scannedItems, ...registeredItems]);
  return ok({
    roots: dirs,
    maxUploadBytes: modelUploadMaxBytes(),
    items: items.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)),
  });
}

async function registerModelImport(request: Request) {
  const actor = await actorWithPermission(request, "generation.config.write");
  const body = modelImportRegisterSchema.parse(await jsonBody(request));
  const { assets, sourceType, resolvedPath } = await modelImportAssetsFromPath(body.kind, body.path);
  await upsertModelImportRegistryEntries(assets);
  await writeAudit(request, actor, {
    action: sourceType === "directory" ? "generation.model_import.register_directory" : "generation.model_import.register",
    targetType: sourceType === "directory" ? `generation_${body.kind}_asset_directory` : `generation_${body.kind}_asset`,
    targetId: resolvedPath,
    reason: body.reason,
    after: {
      kind: body.kind,
      sourceType,
      count: assets.length,
      assets: assets.slice(0, 50).map((asset) => ({
        path: asset.path,
        format: asset.format,
        sizeBytes: asset.sizeBytes,
      })),
    },
  });
  return ok({ asset: assets[0], assets, roots: modelImportDirs() });
}

async function registeredModelImportAssets() {
  const registry = await readModelImportRegistry();
  const assets = await Promise.all(
    registry.assets.map(async (entry) => {
      try {
        return await modelImportAssetFromPath(entry.kind, entry.path);
      } catch {
        return null;
      }
    }),
  );
  return assets.filter((asset): asset is ModelImportAsset => asset !== null);
}

async function upsertModelImportRegistryEntries(assets: ModelImportAsset[]) {
  const registry = await readModelImportRegistry();
  const incomingKeys = new Set(assets.map((asset) => registryEntryKey(asset.kind, asset.path)));
  const existing = registry.assets.filter(
    (entry) => !incomingKeys.has(registryEntryKey(entry.kind, entry.path)),
  );
  await writeModelImportRegistry({
    version: 1,
    assets: [
      ...existing,
      ...assets.map((asset) => ({
        kind: asset.kind,
        path: asset.path,
        registeredAt: new Date().toISOString(),
      })),
    ],
  });
}

async function readModelImportRegistry(): Promise<ModelImportRegistry> {
  const registryPath = modelImportRegistryPath();
  const text = await readFile(registryPath, "utf8").catch((error: unknown) => {
    if (isMissingFileError(error)) return null;
    throw error;
  });
  if (!text) return { version: 1, assets: [] };

  try {
    const parsed = modelImportRegistrySchema.safeParse(JSON.parse(text) as unknown);
    if (!parsed.success) return { version: 1, assets: [] };
    return {
      version: 1,
      assets: parsed.data.assets.map((entry) => ({
        kind: entry.kind,
        path: path.resolve(/*turbopackIgnore: true*/ expandHome(entry.path)),
        registeredAt: entry.registeredAt ?? new Date(0).toISOString(),
      })),
    };
  } catch {
    return { version: 1, assets: [] };
  }
}

async function writeModelImportRegistry(registry: ModelImportRegistry) {
  const registryPath = modelImportRegistryPath();
  await mkdir(path.dirname(registryPath), { recursive: true });
  await writeFile(
    registryPath,
    `${JSON.stringify({ version: 1, assets: dedupeRegistryEntries(registry.assets) }, null, 2)}\n`,
    "utf8",
  );
}

function modelImportRegistryPath() {
  return path.join(modelImportDirs().root, "registry.json");
}

function dedupeModelImportAssets(items: ModelImportAsset[]) {
  const byKey = new Map<string, ModelImportAsset>();
  for (const item of items) {
    byKey.set(`${item.kind}:${item.path}`, item);
  }
  return Array.from(byKey.values());
}

function dedupeRegistryEntries(entries: ModelImportRegistryEntry[]) {
  const byKey = new Map<string, ModelImportRegistryEntry>();
  for (const entry of entries) {
    const resolvedPath = path.resolve(/*turbopackIgnore: true*/ expandHome(entry.path));
    byKey.set(registryEntryKey(entry.kind, resolvedPath), { ...entry, path: resolvedPath });
  }
  return Array.from(byKey.values());
}

function registryEntryKey(kind: ModelImportKind, filePath: string) {
  return `${kind}:${path.resolve(/*turbopackIgnore: true*/ expandHome(filePath))}`;
}

function isMissingFileError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function uploadModelImport(request: Request) {
  const actor = await actorWithPermission(request, "generation.config.write");
  const form = await request.formData();
  const kind = modelImportKindSchema.parse(String(form.get("kind") ?? "model"));
  const file = form.get("file");
  if (!(file instanceof File)) throw Errors.badRequest("Upload requires a file field");
  if (file.size <= 0) throw Errors.badRequest("Uploaded file is empty");
  const maxBytes = modelUploadMaxBytes();
  if (file.size > maxBytes) {
    throw Errors.badRequest(`Uploaded file exceeds limit (${maxBytes} bytes)`);
  }

  const safeName = safeImportFileName(file.name);
  assertImportExtension(kind, safeName);
  const targetDir = modelImportDirs()[kind];
  await mkdir(targetDir, { recursive: true });
  const destination = await uniqueImportPath(targetDir, safeName);
  const webStream = file.stream() as unknown as Parameters<typeof Readable.fromWeb>[0];
  await pipeline(Readable.fromWeb(webStream), createWriteStream(destination));
  const asset = await modelImportAssetFromPath(kind, destination);

  await writeAudit(request, actor, {
    action: "generation.model_import.upload",
    targetType: `generation_${kind}_asset`,
    targetId: asset.path,
    after: {
      kind: asset.kind,
      format: asset.format,
      name: asset.name,
      sizeBytes: asset.sizeBytes,
    },
  });
  return ok({ asset, roots: modelImportDirs() });
}

function modelImportRoot() {
  const configuredRoot = process.env.ADMIN_MODEL_LIBRARY_DIR?.trim();
  const defaultBase = process.env.IDREAM_REPO_ROOT?.trim() || process.cwd();
  const baseRoot = path.resolve(/*turbopackIgnore: true*/ expandHome(defaultBase));
  if (!configuredRoot) return path.join(baseRoot, "data", "model-imports");

  const expandedRoot = expandHome(configuredRoot);
  const resolvedRoot = path.isAbsolute(expandedRoot)
    ? expandedRoot
    : path.join(/*turbopackIgnore: true*/ baseRoot, expandedRoot);
  return path.resolve(/*turbopackIgnore: true*/ resolvedRoot);
}

function modelUploadMaxBytes() {
  const raw = Number.parseInt(process.env.ADMIN_MODEL_UPLOAD_MAX_BYTES ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 20 * 1024 * 1024 * 1024;
}

function modelImportDirs() {
  const root = modelImportRoot();
  return {
    root,
    model: path.join(root, "checkpoints"),
    lora: path.join(root, "loras"),
    llm: path.join(root, "encoders"),
    vae: path.join(root, "vae"),
    converted: path.join(root, "gguf"),
  };
}

function expandHome(value: string) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

async function scanImportDir(kind: ModelImportKind, dir: string, depth = 0): Promise<ModelImportAsset[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const assets: ModelImportAsset[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && depth < 2) {
      assets.push(...(await scanImportDir(kind, fullPath, depth + 1)));
      continue;
    }
    if (!entry.isFile() || !isAllowedImportFile(kind, entry.name)) continue;
    const info = await stat(fullPath).catch(() => null);
    if (!info?.isFile()) continue;
    assets.push(await modelImportAsset(kind, fullPath, info.size, info.mtime));
    if (assets.length >= 300) break;
  }
  return assets;
}

async function modelImportAssetFromPath(kind: ModelImportKind, rawPath: string) {
  const filePath = path.resolve(/*turbopackIgnore: true*/ expandHome(rawPath));
  assertImportExtension(kind, filePath);
  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile()) throw Errors.badRequest("Model import path must point to a readable file");
  return modelImportAsset(kind, filePath, info.size, info.mtime);
}

async function modelImportAssetsFromPath(kind: ModelImportKind, rawPath: string) {
  const resolvedPath = path.resolve(/*turbopackIgnore: true*/ expandHome(rawPath));
  const info = await stat(resolvedPath).catch(() => null);
  if (!info) throw Errors.badRequest("Model import path must point to a readable file or directory");
  if (info.isFile()) {
    return {
      sourceType: "file" as const,
      resolvedPath,
      assets: [await modelImportAssetFromPath(kind, resolvedPath)],
    };
  }
  if (!info.isDirectory()) {
    throw Errors.badRequest("Model import path must point to a readable file or directory");
  }
  const assets = await scanImportDir(kind, resolvedPath);
  if (assets.length === 0) {
    throw Errors.badRequest(`${kind} directory import found no supported files`);
  }
  return {
    sourceType: "directory" as const,
    resolvedPath,
    assets,
  };
}

async function modelImportAsset(
  kind: ModelImportKind,
  filePath: string,
  sizeBytes: number,
  modifiedAt: Date,
): Promise<ModelImportAsset> {
  const format = modelFormatFromPath(filePath);
  const metadataText =
    format === "safetensors" ? await readSafetensorsMetadataText(filePath) : "";
  return {
    kind,
    name: path.basename(filePath),
    path: filePath,
    format,
    sizeBytes,
    modifiedAt: modifiedAt.toISOString(),
    draftPatch: modelImportDraftPatch(kind, filePath, format, metadataText),
  };
}

function modelImportDraftPatch(
  kind: ModelImportKind,
  filePath: string,
  format: "safetensors" | "gguf",
  metadataText = "",
): Record<string, unknown> {
  const slug = slugFromFilePath(filePath);
  if (kind === "lora") {
    return {
      loraModelDir: path.dirname(filePath),
      lora: {
        key: slug,
        path: filePath,
        fileName: path.basename(filePath),
        weight: 1,
        enabled: true,
      },
    };
  }
  if (kind === "llm") return { llmPath: filePath };
  if (kind === "vae") return { vaePath: filePath };

  const isKrea2Import = isKrea2ModelImport(slug, filePath);
  const isComfyuiFp8Krea2Import = isComfyuiFp8Krea2ModelImport(slug, filePath, metadataText);
  if (isComfyuiFp8Krea2Import) {
    return {
      profileTemplate: "reference_identity_comfyui",
      profileKey: `comfyui_${slug}`,
      label: `${titleFromSlug(slug)} ComfyUI candidate`,
      runner: "comfyui",
      pipelineModel: slug,
      sourceModelPath: filePath,
      diffusionModelPath: filePath,
      convertedModelPath: "",
      modelFormat: format,
      conversionEnabled: false,
      steps: "10",
      sampler: "er_sde",
      scheduler: "simple",
      cfgScale: "1",
      runnerConfig: {
        apiModelId: slug,
        profileTemplate: "reference_identity_comfyui",
        templateIntent: "comfyui_reference_identity",
        verificationStatus: "requires_comfyui_fp8_krea2_runtime",
        componentStatus: {
          workflow: "metadata_embedded_not_imported",
          textEncoder: "requires_comfyui_qwen3vl_text_encoder",
          vae: "requires_comfyui_krea2_vae",
        },
        assetFormat: "fp8_scaled_comfyui_checkpoint",
        note: "This Krea2 asset is a ComfyUI fp8-scaled checkpoint. Keep it as a ComfyUI draft until an imported workflow and local runtime probe pass.",
        capabilities: {
          textToImage: true,
          stableSeed: true,
          referenceImages: true,
          initImage: true,
          lora: false,
        },
      },
    };
  }
  const convertedPath =
    format === "safetensors" && !isKrea2Import
      ? path.join(modelImportDirs().converted, `${slug}-q8_0.gguf`)
      : filePath;
  const krea2Patch = isKrea2Import
    ? {
        llmPath: path.join(os.homedir(), ".localai/models/krea2/text_encoders/Qwen3VL-4B-Instruct-Q4_K_M.gguf"),
        vaePath: path.join(os.homedir(), ".localai/models/krea2/vae/wan_2.1_vae.safetensors"),
        backend: "vae=cpu",
        steps: "10",
        sampler: "er_sde",
        scheduler: "simple",
        cfgScale: "1",
      }
    : {};
  return {
    profileKey: `sdcpp_${slug}`,
    label: titleFromSlug(slug),
    runner: "sd_cpp",
    pipelineModel: slug,
    sourceModelPath: filePath,
    diffusionModelPath: format === "safetensors" ? filePath : "",
    convertedModelPath: format === "safetensors" && isKrea2Import ? "" : convertedPath,
    modelFormat: format,
    conversionEnabled: format === "safetensors" && !isKrea2Import,
    conversionType: "q8_0",
    conversionSourceArg: "model",
    ...krea2Patch,
  };
}

function isKrea2ModelImport(slug: string, filePath: string) {
  return /krea[-_ ]?2/i.test(`${slug} ${filePath}`);
}

function isComfyuiFp8Krea2ModelImport(slug: string, filePath: string, metadataText: string) {
  const haystack = `${slug} ${filePath} ${metadataText}`.toLowerCase();
  return (
    /krea[-_ ]?2/i.test(haystack) &&
    (haystack.includes("comfyui") || haystack.includes("checkpointloadersimple")) &&
    (haystack.includes("fp8") || haystack.includes("fp8_scaled") || haystack.includes("comfy_quant"))
  );
}

async function readSafetensorsMetadataText(filePath: string) {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(filePath, "r");
    const sizeBuffer = Buffer.alloc(8);
    await handle.read(sizeBuffer, 0, 8, 0);
    const headerLength = Number(sizeBuffer.readBigUInt64LE(0));
    if (!Number.isFinite(headerLength) || headerLength <= 0 || headerLength > 8 * 1024 * 1024) {
      return "";
    }
    const headerBuffer = Buffer.alloc(headerLength);
    await handle.read(headerBuffer, 0, headerLength, 8);
    const header = JSON.parse(headerBuffer.toString("utf8")) as unknown;
    if (!isRecord(header)) return "";
    const metadata = isRecord(header.__metadata__) ? header.__metadata__ : {};
    const metadataText = Object.entries(metadata)
      .map(([key, value]) => `${key}:${typeof value === "string" ? value : JSON.stringify(value)}`)
      .join("\n");
    return metadataText.slice(0, 80_000);
  } catch {
    return "";
  } finally {
    await handle?.close().catch(() => {});
  }
}

function safeImportFileName(name: string) {
  const baseName = path.basename(name).replace(/[^a-zA-Z0-9._-]+/g, "_");
  if (!baseName || baseName === "." || baseName === "..") {
    throw Errors.badRequest("Uploaded file name is invalid");
  }
  return baseName;
}

async function uniqueImportPath(dir: string, name: string) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate =
      attempt === 0
        ? path.join(dir, name)
        : path.join(dir, `${base}-${randomUUID().slice(0, 8)}${ext}`);
    const exists = await stat(candidate).then(
      () => true,
      () => false,
    );
    if (!exists) return candidate;
  }
  throw Errors.badRequest("Could not allocate a unique upload file name");
}

function assertImportExtension(kind: ModelImportKind, filePath: string) {
  if (!isAllowedImportFile(kind, filePath)) {
    throw Errors.badRequest(`${kind} import supports ${IMPORT_EXTENSIONS[kind].join(", ")} files`);
  }
}

function isAllowedImportFile(kind: ModelImportKind, filePath: string) {
  const lower = filePath.toLowerCase();
  return IMPORT_EXTENSIONS[kind].some((ext) => lower.endsWith(ext));
}

function modelFormatFromPath(filePath: string): "safetensors" | "gguf" {
  return filePath.toLowerCase().endsWith(".gguf") ? "gguf" : "safetensors";
}

function slugFromFilePath(filePath: string) {
  return (
    path
      .basename(filePath)
      .replace(/\.[^.]+$/, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 90) || "model"
  );
}

function titleFromSlug(slug: string) {
  return slug
    .split("_")
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function assertTargetConfirmation(value: string, targetId: string) {
  if (value !== targetId) throw Errors.badRequest("Confirmation did not match target");
}

// SPEC: P2 Task 7 —— workflowKey（可空）指向 gen workflow 描述符（packages/gen/workflows），
// 供入队时覆盖 profile.pipelineModel 路由到具体 workflow。留空/null 表示"沿用 pipelineModel"
// （不校验，因为它就是不引用任何 workflow）。非空必须命中已知描述符，否则 400。
// INVARIANT: 复用 generation-catalog.ts 的 60s 描述符缓存（workflowKeyExists），不重复扫目录。
async function assertKnownWorkflowKey(workflowKey: string | null | undefined) {
  if (!workflowKey) return;
  if (!(await workflowKeyExists(workflowKey))) {
    throw Errors.badRequest("Unknown workflowKey", { workflowKey });
  }
}

async function createModelProfile(request: Request) {
  if (!modelDiagnosticsEnabled()) throw Errors.notFound("Admin API route not found");
  const actor = await actorWithPermission(request, "generation.config.write");
  const body = modelProfileSchema.parse(await jsonBody(request));
  validateModelProfileConfig(body);
  await assertKnownWorkflowKey(body.workflowKey);
  const runnerConfig = normalizedModelProfileRunnerConfig(body);
  const latest = await prisma.generationModelProfile.findFirst({
    where: { profileKey: body.profileKey },
    orderBy: { version: "desc" },
  });
  const profile = await prisma.generationModelProfile.create({
    data: {
      ...body,
      workflowKey: body.workflowKey ?? null,
      requiredEntitlement: body.requiredEntitlement ?? null,
      sourceModelPath: body.sourceModelPath ?? null,
      convertedModelPath: body.convertedModelPath ?? null,
      allowedOrientations: toInputJson(body.allowedOrientations),
      runnerConfig: runnerConfig ? toInputJson(runnerConfig) : undefined,
      dryRunSummary: body.dryRunSummary ? toInputJson(body.dryRunSummary) : undefined,
      version: (latest?.version ?? 0) + 1,
      status: "draft",
    },
  });
  await writeAudit(request, actor, {
    action: "generation.profile.create",
    targetType: "generation_model_profile",
    targetId: profile.id,
    after: { profileKey: profile.profileKey, version: profile.version, status: profile.status },
  });
  return ok({ profile });
}

async function patchModelProfile(request: Request, id: string) {
  const body = modelProfilePatchSchema.parse(await jsonBody(request));
  if (!modelDiagnosticsEnabled() && !isOperationalModelProfileDisablePatch(body)) {
    throw Errors.notFound("Admin API route not found");
  }
  const actor = await actorWithPermission(request, "generation.config.write");
  const before = await prisma.generationModelProfile.findUnique({ where: { id } });
  if (!before) throw Errors.notFound("Model profile not found");
  if (before.status !== "draft") {
    const forbiddenKeys = definedPatchKeys(body).filter(
      (key) => !["enabled", "reason", "confirmation"].includes(key),
    );
    if (body.enabled !== false || forbiddenKeys.length > 0) {
      throw Errors.badRequest("Only draft profiles can be edited; active profiles may only be disabled");
    }
  } else if (body.enabled === true) {
    throw Errors.badRequest("Draft profiles cannot be enabled directly; publish the profile after verification");
  }
  if (body.enabled === false && before.enabled) {
    if (!body.reason || !body.confirmation) {
      throw Errors.badRequest("Disabling a profile requires reason and target confirmation");
    }
    assertTargetConfirmation(body.confirmation, before.id);
  }
  const shouldPersistRunnerConfig =
    body.runnerConfig !== undefined || body.pipelineModel !== undefined || body.runner !== undefined;
  // Only re-validate/normalize the runner config when the patch actually changes it. A
  // disable-only PATCH (the emergency kill-switch) must NOT run the strict sd_cpp schema over
  // a profile's existing, possibly-legacy runnerConfig — a known-field violation there would
  // throw 400 and block disabling a misbehaving profile.
  let runnerConfig: ReturnType<typeof normalizedModelProfileRunnerConfig> | undefined;
  if (shouldPersistRunnerConfig) {
    const nextConfigInput: ModelProfileConfigInput = {
      profileKey: body.profileKey ?? before.profileKey,
      label: body.label ?? before.label,
      mode: body.mode ?? (before.mode as "image" | "video"),
      runner: body.runner ?? (before.runner as "pipeline" | "sd_cpp" | "mlx" | "comfyui" | "external"),
      pipelineModel: body.pipelineModel ?? before.pipelineModel,
      sourceModelPath: body.sourceModelPath === undefined ? before.sourceModelPath : body.sourceModelPath,
      convertedModelPath:
        body.convertedModelPath === undefined ? before.convertedModelPath : body.convertedModelPath,
      modelFormat: body.modelFormat ?? (before.modelFormat as "safetensors" | "gguf" | "diffusers" | "external"),
      runnerConfig: body.runnerConfig ?? jsonRecord(before.runnerConfig),
    };
    validateModelProfileConfig(nextConfigInput);
    runnerConfig = normalizedModelProfileRunnerConfig(nextConfigInput);
  }
  await assertKnownWorkflowKey(body.workflowKey);

  const updated = await prisma.generationModelProfile.update({
    where: { id },
    data: {
      profileKey: body.profileKey,
      label: body.label,
      mode: body.mode,
      runner: body.runner,
      pipelineModel: body.pipelineModel,
      workflowKey: body.workflowKey === undefined ? undefined : body.workflowKey,
      sourceModelPath: body.sourceModelPath === undefined ? undefined : body.sourceModelPath,
      convertedModelPath:
        body.convertedModelPath === undefined ? undefined : body.convertedModelPath,
      modelFormat: body.modelFormat,
      runnerConfig: shouldPersistRunnerConfig && runnerConfig ? toInputJson(runnerConfig) : undefined,
      defaultWidth: body.defaultWidth,
      defaultHeight: body.defaultHeight,
      allowedOrientations: body.allowedOrientations
        ? toInputJson(body.allowedOrientations)
        : undefined,
      steps: body.steps,
      sampler: body.sampler,
      scheduler: body.scheduler,
      cfgScale: body.cfgScale,
      costMultiplier: body.costMultiplier,
      requiredEntitlement:
        body.requiredEntitlement === undefined ? undefined : body.requiredEntitlement,
      maxCount: body.maxCount,
      concurrencyLimit: body.concurrencyLimit,
      enabled: body.enabled,
      rolloutPercent: body.rolloutPercent,
      dryRunSummary: body.dryRunSummary ? toInputJson(body.dryRunSummary) : undefined,
    },
  });
  await writeAudit(request, actor, {
    action: body.enabled === false ? "generation.profile.disable" : "generation.profile.update",
    targetType: "generation_model_profile",
    targetId: id,
    reason: body.reason,
    before: profileAuditSnapshot(before),
    after: profileAuditSnapshot(updated),
  });
  return ok({ profile: updated });
}

function isOperationalModelProfileDisablePatch(body: z.infer<typeof modelProfilePatchSchema>) {
  if (body.enabled !== false) return false;
  return definedPatchKeys(body).every((key) => ["enabled", "reason", "confirmation"].includes(key));
}

async function publishModelProfile(request: Request, id: string) {
  const actor = await actorWithPermission(request, "generation.config.write");
  const body = publishSchema.parse(await jsonBody(request));
  const profile = await prisma.generationModelProfile.findUnique({ where: { id } });
  if (!profile) throw Errors.notFound("Model profile not found");
  assertTargetConfirmation(body.confirmation, profile.id);
  if (profile.status !== "draft") throw Errors.badRequest("Only draft profiles can be published");
  if (profile.mode === "video" && !(await featureEnabled("video_gen"))) {
    throw Errors.forbidden("Video generation is disabled by feature flag");
  }

  const dryRunSummary = body.dryRunSummary
    ? toInputJson({
        ...jsonRecord(profile.dryRunSummary),
        ...body.dryRunSummary,
      })
    : profile.dryRunSummary;
  if (!dryRunSummary) throw Errors.badRequest("Publish requires dry-run summary");
  assertModelProfilePublishable(profile, dryRunSummary);

  const previous = await prisma.generationModelProfile.findFirst({
    where: { profileKey: profile.profileKey, status: "active" },
  });
  const published = await prisma.$transaction(async (tx) => {
    await tx.generationModelProfile.updateMany({
      where: { profileKey: profile.profileKey, status: "active" },
      data: { status: "archived", archivedAt: new Date() },
    });
    return tx.generationModelProfile.update({
      where: { id },
      data: {
        status: "active",
        enabled: true,
        rolloutPercent: profile.rolloutPercent > 0 ? profile.rolloutPercent : 100,
        dryRunSummary,
        publishedAt: new Date(),
        archivedAt: null,
      },
    });
  });
  await writeAudit(request, actor, {
    action: "generation.profile.publish",
    targetType: "generation_model_profile",
    targetId: id,
    reason: body.reason,
    before: previous ? profileAuditSnapshot(previous) : null,
    after: profileAuditSnapshot(published),
  });
  return ok({ profile: published, previousActiveId: previous?.id ?? null });
}

function assertModelProfilePublishable(
  profile: {
    mode: string;
    sourceModelPath: string | null;
    convertedModelPath: string | null;
    runnerConfig: Prisma.JsonValue;
  },
  dryRunSummary: Prisma.JsonValue | Prisma.InputJsonValue,
) {
  const summary = jsonRecord(dryRunSummary);
  const runnerConfig = jsonRecord(profile.runnerConfig);
  const verificationStatus = stringFromRecord(runnerConfig, "verificationStatus");
  if (!verificationStatus && requiresModelVerification(profile, runnerConfig)) {
    throw Errors.badRequest("Publish requires a passed model verification status", {
      verificationStatus: null,
    });
  }
  if (verificationStatus && !["passed", "verified", "manual_passed"].includes(verificationStatus)) {
    throw Errors.badRequest("Publish requires a passed model verification status", {
      verificationStatus,
    });
  }
  const badComponentStatuses = modelProfileBadComponentStatuses(runnerConfig.componentStatus);
  if (badComponentStatuses.length > 0) {
    throw Errors.badRequest("Publish requires all model components to be available", {
      componentStatus: badComponentStatuses,
    });
  }

  const failureMode = stringFromRecord(summary, "failureMode");
  if (failureMode) {
    throw Errors.badRequest("Publish requires a dry run without failureMode", {
      failureMode,
    });
  }

  const sampleCount = numberFromRecord(summary, "sampleCount");
  const minSamples = profile.mode === "image" ? imageProfilePublishMinSamples : 1;
  if (sampleCount === undefined || sampleCount < minSamples) {
    throw Errors.badRequest(`Publish requires at least ${minSamples} dry-run samples`, {
      sampleCount,
      minSamples,
    });
  }

  const successRate = numberFromRecord(summary, "successRate");
  if (successRate !== undefined && successRate < modelProfilePublishMinRate) {
    throw Errors.badRequest("Publish requires dry-run successRate >= 0.8", {
      successRate,
    });
  }

  if (profile.mode === "image") {
    const consistencyRate = firstNumberFromRecord(summary, [
      "consistencyRate",
      "consistencyPassRate",
      "identityConsistencyRate",
      "manualConsistencyRate",
    ]);
    if (consistencyRate === undefined || consistencyRate < modelProfilePublishMinRate) {
      throw Errors.badRequest("Publish requires image consistencyRate >= 0.8", {
        consistencyRate,
      });
    }
  }
}

function modelProfileBadComponentStatuses(value: unknown) {
  const componentStatus = jsonRecord(value);
  return Object.entries(componentStatus).flatMap(([key, rawValue]) => {
    const status = modelComponentStatusValue(rawValue);
    return status && isBadModelComponentStatus(status) ? [{ key, status }] : [];
  });
}

function modelComponentStatusValue(value: unknown) {
  const rawStatus = typeof value === "string" ? value : isRecord(value) ? stringFromRecord(value, "status") ?? "" : "";
  const status = rawStatus.trim();
  const normalized = status.toLowerCase();
  if (normalized.startsWith("available:")) return "available";
  if (normalized.startsWith("missing:")) return "missing";
  if (normalized.startsWith("failed:")) return "failed";
  if (normalized.startsWith("unsupported:")) return "unsupported";
  return status;
}

function isBadModelComponentStatus(status: string) {
  const normalized = status.toLowerCase();
  return [
    "missing",
    "failed",
    "unsupported",
    "not_imported",
    "required",
    "requires_",
    "unavailable",
  ].some((marker) => normalized.includes(marker));
}

function requiresModelVerification(
  profile: {
    mode: string;
    sourceModelPath: string | null;
    convertedModelPath: string | null;
  },
  runnerConfig: Record<string, unknown>,
) {
  if (profile.mode !== "image") return false;
  return Boolean(
    profile.sourceModelPath ||
      profile.convertedModelPath ||
      stringFromRecord(runnerConfig, "diffusionModelPath") ||
      stringFromRecord(runnerConfig, "modelPath") ||
      stringFromRecord(runnerConfig, "workflowPath"),
  );
}

async function rollbackModelProfile(request: Request, id: string) {
  const actor = await actorWithPermission(request, "generation.config.write");
  const body = rollbackSchema.parse(await jsonBody(request));
  const current = await prisma.generationModelProfile.findUnique({ where: { id } });
  if (!current) throw Errors.notFound("Model profile not found");
  assertTargetConfirmation(body.confirmation, current.id);
  const previous = await prisma.generationModelProfile.findFirst({
    where: {
      profileKey: current.profileKey,
      status: "archived",
      version: { lt: current.version },
    },
    orderBy: { version: "desc" },
  });
  if (!previous) throw Errors.notFound("No previous profile version to roll back to");
  const restored = await prisma.$transaction(async (tx) => {
    await tx.generationModelProfile.updateMany({
      where: { profileKey: current.profileKey, status: "active" },
      data: { status: "archived", archivedAt: new Date() },
    });
    return tx.generationModelProfile.update({
      where: { id: previous.id },
      data: { status: "active", enabled: true, publishedAt: new Date(), archivedAt: null },
    });
  });
  await writeAudit(request, actor, {
    action: "generation.profile.rollback",
    targetType: "generation_model_profile",
    targetId: current.id,
    reason: body.reason,
    before: profileAuditSnapshot(current),
    after: profileAuditSnapshot(restored),
  });
  return ok({ profile: restored, fromVersion: current.version, toVersion: restored.version });
}

async function createProfileTestJob(request: Request, id: string) {
  const actor = await actorWithPermission(request, "generation.config.write");
  const body = modelProfileTestJobSchema.parse(await jsonBody(request));
  const profile = await prisma.generationModelProfile.findUnique({ where: { id } });
  if (!profile) throw Errors.notFound("Model profile not found");
  assertTargetConfirmation(body.confirmation, profile.id);
  if (profile.status === "archived") {
    throw Errors.badRequest("Archived profiles cannot create test jobs");
  }
  if (profile.mode !== "image") {
    throw Errors.badRequest("Admin test image currently supports image profiles only");
  }
  const allowedOrientations = jsonStringArray(profile.allowedOrientations);
  const orientation = body.orientation ?? allowedOrientations[0] ?? "1:1";
  if (allowedOrientations.length > 0 && !allowedOrientations.includes(orientation)) {
    throw Errors.badRequest("Orientation is not allowed for this profile", {
      orientation,
      allowedOrientations,
    });
  }
  const outputCount = Math.min(body.outputCount, profile.maxCount, 4);
  const controls = profileTestControls(profile, orientation);
  const prompt = body.prompt?.trim() || `Admin test image for ${profile.label}`;
  const negativePrompt = body.negativePrompt?.trim() || null;
  const job = await prisma.$transaction(async (tx) => {
    const created = await tx.generationJob.create({
      data: {
        userId: actor.id,
        mode: "image",
        prompt,
        negativePrompt,
        controls: toInputJson(controls),
        presetIds: [],
        model: profile.pipelineModel,
        profileId: profile.profileKey,
        profileVersion: profile.version,
        orientation,
        outputCount,
        status: "queued",
        costDreamcoins: 0,
        provider: profile.runner,
      },
    });
    await appendAdminGenerationEvent(tx, created.id, "created", "Admin profile test job accepted", {
      profileId: profile.profileKey,
      profileVersion: profile.version,
      source: "admin_generation_config",
    });
    await appendAdminGenerationEvent(tx, created.id, "queued", "Admin profile test job queued", {});
    return created;
  });

  try {
    await enqueueExistingGenerationJob(job);
  } catch (error) {
    await prisma.$transaction(async (tx) => {
      const failedAt = new Date();
      await tx.generationJob.update({
        where: { id: job.id },
        data: { status: "failed", errorCode: "queue_enqueue_failed", completedAt: null, finishedAt: failedAt, deliveredOutputCount: 0, version: { increment: 1 } },
      });
      const attempt = await tx.generationAttempt.findFirst({
        where: { requestId: job.id },
        orderBy: { attemptNo: "desc" },
      });
      if (attempt) {
        await recordGenerationAttemptEvent(tx, {
          eventId: `${attempt.id}:terminal`,
          attemptId: attempt.id,
          eventType: "generation.attempt.failed.v1",
          outcome: "failed",
          occurredAt: failedAt,
          payload: { requestId: job.id, errorCode: "queue_enqueue_failed" },
          errorCode: "queue_enqueue_failed",
          retryability: "retryable",
        });
      }
      await appendAdminGenerationEvent(tx, job.id, "failed", "Admin test job enqueue failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    throw Errors.internal("Generation queue unavailable", { jobId: job.id });
  }

  await writeAudit(request, actor, {
    action: "generation.profile.test_job",
    targetType: "generation_model_profile",
    targetId: profile.id,
    reason: body.reason,
    after: {
      jobId: job.id,
      profileKey: profile.profileKey,
      profileVersion: profile.version,
      orientation,
      outputCount,
    },
  });
  return ok({ job: redactJob(job) }, { status: 202 });
}

type ModelProfileConfigInput = {
  profileKey: string;
  label: string;
  mode: "image" | "video";
  runner: "pipeline" | "sd_cpp" | "mlx" | "comfyui" | "external";
  pipelineModel: string;
  sourceModelPath?: string | null;
  convertedModelPath?: string | null;
  modelFormat: "safetensors" | "gguf" | "diffusers" | "external";
  runnerConfig?: Record<string, unknown>;
};

function validateModelProfileConfig(input: ModelProfileConfigInput) {
  if (input.runner !== "sd_cpp") return;
  const config = input.runnerConfig ? sdcppRunnerConfigSchema.parse(input.runnerConfig) : {};
  const apiModelId = stringFromRecord(config, "apiModelId");
  if (apiModelId && apiModelId !== input.pipelineModel) {
    throw Errors.badRequest("sd_cpp runnerConfig.apiModelId must match pipelineModel");
  }
  if (isKrea2ModelProfile(input)) {
    const llmPath = stringFromRecord(config, "llmPath");
    const vaePath = stringFromRecord(config, "vaePath");
    if (llmPath && isKnownKrea2IncompatibleTextEncoder(llmPath)) {
      throw Errors.badRequest("Krea2 sd_cpp profiles require a Qwen3-VL 4B text encoder");
    }
    if (vaePath && isKnownKrea2IncompatibleVae(vaePath)) {
      throw Errors.badRequest("Krea2 sd_cpp profiles require wan_2.1_vae.safetensors");
    }
  }
  const conversion = config.conversion;
  const sourcePath = firstText([
    input.sourceModelPath,
    config.diffusionModelPath,
    config.modelPath,
  ]);
  const convertedPath = firstText([input.convertedModelPath, conversion?.outputPath]);

  if (input.modelFormat === "safetensors" && sourcePath && !hasKnownModelExtension(sourcePath)) {
    throw Errors.badRequest("sd_cpp safetensors profile sourceModelPath must point to a model file");
  }
  if (input.modelFormat === "gguf") {
    const ggufPath = firstText([convertedPath, sourcePath]);
    if (ggufPath && !ggufPath.endsWith(".gguf")) {
      throw Errors.badRequest("sd_cpp gguf profile must use a .gguf source or converted model path");
    }
  }
  if (conversion?.enabled) {
    if (!sourcePath) throw Errors.badRequest("sd_cpp conversion requires a source model path");
    if (!sourcePath.endsWith(".safetensors")) {
      throw Errors.badRequest("sd_cpp conversion currently expects a .safetensors source model");
    }
    if (!convertedPath) throw Errors.badRequest("sd_cpp conversion requires convertedModelPath or conversion.outputPath");
    if (!convertedPath.endsWith(".gguf")) {
      throw Errors.badRequest("sd_cpp conversion output must be a .gguf path");
    }
  }
}

function normalizedModelProfileRunnerConfig(input: ModelProfileConfigInput) {
  if (input.runner !== "sd_cpp") return input.runnerConfig;
  const config = input.runnerConfig ? sdcppRunnerConfigSchema.parse(input.runnerConfig) : {};
  const apiModelId = stringFromRecord(config, "apiModelId");
  if (apiModelId && apiModelId !== input.pipelineModel) {
    throw Errors.badRequest("sd_cpp runnerConfig.apiModelId must match pipelineModel");
  }
  return pruneUndefined({
    ...config,
    apiModelId: input.pipelineModel,
    capabilities: normalizedModelCapabilities(config.capabilities, true),
  });
}

function normalizedModelCapabilities(value: unknown, sdCppDefault: boolean) {
  const capabilities = jsonRecord(value);
  return {
    textToImage: booleanFromRecord(capabilities, "textToImage", true),
    stableSeed: booleanFromRecord(capabilities, "stableSeed", true),
    referenceImages: booleanFromRecord(capabilities, "referenceImages", false),
    initImage: booleanFromRecord(capabilities, "initImage", sdCppDefault),
    lora: booleanFromRecord(capabilities, "lora", false),
  };
}

function firstText(values: Array<string | null | undefined>) {
  return values.find((value): value is string => Boolean(value?.trim()))?.trim();
}

function hasKnownModelExtension(value: string) {
  return [".safetensors", ".gguf", ".ckpt", ".pt", ".pth"].some((suffix) =>
    value.toLowerCase().endsWith(suffix),
  );
}

function isKrea2ModelProfile(input: {
  pipelineModel: string;
  sourceModelPath?: string | null;
  convertedModelPath?: string | null;
  runnerConfig?: Record<string, unknown>;
}) {
  const config = input.runnerConfig ?? {};
  return [
    input.pipelineModel,
    input.sourceModelPath,
    input.convertedModelPath,
    stringFromRecord(config, "diffusionModelPath"),
    stringFromRecord(config, "modelPath"),
  ].some((value) => (value ? /krea[-_ ]?2/i.test(value) : false));
}

function isKnownKrea2IncompatibleTextEncoder(value: string) {
  const lowered = value.toLowerCase();
  return lowered.includes("qwen3-4b-instruct") || lowered.includes("z-image");
}

function isKnownKrea2IncompatibleVae(value: string) {
  const lowered = value.toLowerCase();
  return (
    lowered.endsWith("/ae.safetensors") ||
    lowered.includes("flux.1-ae") ||
    lowered.includes("qwen_image_vae") ||
    lowered.includes("z-image")
  );
}

function profileTestControls(
  profile: {
    profileKey: string;
    version: number;
    runner: string;
    pipelineModel: string;
    sourceModelPath: string | null;
    convertedModelPath: string | null;
    modelFormat: string;
    runnerConfig: Prisma.JsonValue | null;
    steps: number;
    sampler: string;
    scheduler: string;
    cfgScale: number;
    defaultWidth: number;
    defaultHeight: number;
  },
  orientation: string,
) {
  const dimensions = dimensionsForImageOrientation({
    orientation,
    defaultWidth: profile.defaultWidth,
    defaultHeight: profile.defaultHeight,
  });
  return pruneUndefined({
    orientation,
    model: profile.profileKey,
    profileId: profile.profileKey,
    width: dimensions.width,
    height: dimensions.height,
    adminTest: true,
    sdcpp: profile.runner === "sd_cpp" ? sdcppProfileRuntimeConfig(profile) : undefined,
  });
}

function sdcppProfileRuntimeConfig(profile: {
  profileKey: string;
  version: number;
  pipelineModel: string;
  sourceModelPath: string | null;
  convertedModelPath: string | null;
  modelFormat: string;
  runnerConfig: Prisma.JsonValue | null;
  steps: number;
  sampler: string;
  scheduler: string;
  cfgScale: number;
  defaultWidth: number;
  defaultHeight: number;
}) {
  const config = jsonRecord(profile.runnerConfig);
  const conversion = jsonRecord(config.conversion);
  return pruneUndefined({
    profileKey: profile.profileKey,
    profileVersion: profile.version,
    apiModelId: profile.pipelineModel,
    modelFormat: profile.modelFormat,
    sourceModelPath: profile.sourceModelPath,
    convertedModelPath: profile.convertedModelPath,
    modelPath: stringFromRecord(config, "modelPath"),
    diffusionModelPath: stringFromRecord(config, "diffusionModelPath"),
    llmPath: stringFromRecord(config, "llmPath"),
    vaePath: stringFromRecord(config, "vaePath"),
    llmVisionPath: stringFromRecord(config, "llmVisionPath"),
    clipLPath: stringFromRecord(config, "clipLPath"),
    clipGPath: stringFromRecord(config, "clipGPath"),
    t5xxlPath: stringFromRecord(config, "t5xxlPath"),
    backend: stringFromRecord(config, "backend"),
    loraModelDir: stringFromRecord(config, "loraModelDir"),
    loraApplyMode: stringFromRecord(config, "loraApplyMode"),
    loras: normalizeSdcppLoras(config.loras),
    conversion:
      conversion.enabled === true
        ? pruneUndefined({
            enabled: true,
            targetFormat: "gguf",
            outputPath: stringFromRecord(conversion, "outputPath") ?? profile.convertedModelPath,
            type: stringFromRecord(conversion, "type") ?? "q8_0",
            sourceArg: stringFromRecord(conversion, "sourceArg") ?? "model",
            convertName: conversion.convertName === true,
            tensorTypeRules: stringFromRecord(conversion, "tensorTypeRules"),
          })
        : undefined,
    steps: profile.steps,
    sampler: profile.sampler,
    scheduler: profile.scheduler,
    cfgScale: profile.cfgScale,
    defaultWidth: profile.defaultWidth,
    defaultHeight: profile.defaultHeight,
  });
}

function normalizeSdcppLoras(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const loras = value
    .filter(isRecord)
    .map((item) =>
      pruneUndefined({
        key: stringFromRecord(item, "key"),
        path: stringFromRecord(item, "path"),
        weight: typeof item.weight === "number" && Number.isFinite(item.weight) ? item.weight : 1,
        enabled: item.enabled !== false,
      }),
    )
    .filter((item) => typeof item.key === "string" || typeof item.path === "string");
  return loras.length ? loras : undefined;
}

function stringFromRecord(value: Record<string, unknown>, key: string) {
  const child = value[key];
  return typeof child === "string" && child.trim() ? child.trim() : undefined;
}

function booleanFromRecord(value: Record<string, unknown>, key: string, fallback: boolean) {
  const child = value[key];
  return typeof child === "boolean" ? child : fallback;
}

function numberFromRecord(value: Record<string, unknown>, key: string) {
  const child = value[key];
  return typeof child === "number" && Number.isFinite(child) ? child : undefined;
}

function firstNumberFromRecord(value: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const child = numberFromRecord(value, key);
    if (child !== undefined) return child;
  }
  return undefined;
}

function pruneUndefined(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined));
}

async function listRecipes(request: Request) {
  await actorWithPermission(request, "generation.config.read");
  const url = new URL(request.url);
  const mode = url.searchParams.get("mode") ?? undefined;
  const templates = await prisma.generationRecipe.findMany({
    where: { mode },
    orderBy: [{ recipeKey: "asc" }, { version: "desc" }],
  });
  return ok({ items: templates });
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
  const presets = await prisma.generationPreset.findMany({
    where: { scope: "built_in" },
    orderBy: [{ type: "asc" }, { label: "asc" }],
  });
  return ok({ items: presets });
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

// SPEC: 定价规则控制面 —— draft→active→archived 版本化发布，复用 model-profile 范式。
// INTENT: 接通已存在的 PricingRule（generationCost 已按 mode 读 active 规则），让改价可版本化/审计/回滚，
//         而不再改 seed/代码。读 billing.read（admin+support），写 config.pricing.write（admin only）。
// INVARIANTS: 每个 mode 至多一个 active 规则（发布时归档同 mode 旧 active）；ruleKey 维护版本号与回滚链。
// EXAMPLE: image baseCost 5→4 走 create(draft) → publish（旧 active 归档），可一键 rollback 回 v1。
async function listPricingRules(request: Request) {
  await actorWithPermission(request, "billing.read");
  const url = new URL(request.url);
  const mode = url.searchParams.get("mode") ?? undefined;
  const status = url.searchParams.get("status") ?? undefined;
  const rules = await prisma.pricingRule.findMany({
    where: { mode, status },
    orderBy: [{ ruleKey: "asc" }, { version: "desc" }],
  });
  return ok({ items: rules });
}

async function createPricingRule(request: Request) {
  const actor = await actorWithPermission(request, "config.pricing.write");
  const body = pricingRuleSchema.parse(await jsonBody(request));
  if (body.confirmation !== body.ruleKey) {
    throw Errors.badRequest("Confirmation did not match pricing rule key");
  }
  const latest = await prisma.pricingRule.findFirst({
    where: { ruleKey: body.ruleKey },
    orderBy: { version: "desc" },
  });
  const rule = await prisma.pricingRule.create({
    data: {
      ruleKey: body.ruleKey,
      label: body.label,
      mode: body.mode,
      baseCost: body.baseCost,
      multiplier: body.multiplier,
      effectiveFrom: body.effectiveFrom ? new Date(body.effectiveFrom) : null,
      version: (latest?.version ?? 0) + 1,
      status: "draft",
    },
  });
  await writeAudit(request, actor, {
    action: "config.pricing.create",
    targetType: "pricing_rule",
    targetId: rule.id,
    reason: body.reason,
    after: pricingAuditSnapshot(rule),
  });
  return ok({ rule });
}

async function patchPricingRule(request: Request, id: string) {
  const actor = await actorWithPermission(request, "config.pricing.write");
  const body = pricingRulePatchSchema.parse(await jsonBody(request));
  const before = await prisma.pricingRule.findUnique({ where: { id } });
  if (!before) throw Errors.notFound("Pricing rule not found");
  if (before.status !== "draft") throw Errors.badRequest("Only draft pricing rules can be edited");
  const updated = await prisma.pricingRule.update({
    where: { id },
    data: {
      label: body.label,
      baseCost: body.baseCost,
      multiplier: body.multiplier,
      effectiveFrom:
        body.effectiveFrom === undefined
          ? undefined
          : body.effectiveFrom === null
            ? null
            : new Date(body.effectiveFrom),
    },
  });
  await writeAudit(request, actor, {
    action: "config.pricing.update",
    targetType: "pricing_rule",
    targetId: id,
    before: pricingAuditSnapshot(before),
    after: pricingAuditSnapshot(updated),
  });
  return ok({ rule: updated });
}

async function publishPricingRule(request: Request, id: string) {
  const actor = await actorWithPermission(request, "config.pricing.write");
  const body = pricingPublishSchema.parse(await jsonBody(request));
  const { previous, published } = await prisma.$transaction(async (tx) => {
    const rule = await tx.pricingRule.findUnique({ where: { id } });
    if (!rule) throw Errors.notFound("Pricing rule not found");
    assertTargetConfirmation(body.confirmation, rule.id);
    if (rule.status !== "draft") throw Errors.badRequest("Only draft pricing rules can be published");
    // 高危：改价发布在硬门控开启时需双人审批凭据（见 enforceApproval）。
    await enforceApproval("config.pricing.publish", id, tx);
    // 同 mode 旧 active 全部归档，保证 generationCost 读到的 active 唯一（资金侧 SSoT）。
    const previous = await tx.pricingRule.findFirst({
      where: { mode: rule.mode, status: "active" },
    });
    const effectiveFrom = body.effectiveFrom
      ? new Date(body.effectiveFrom)
      : (rule.effectiveFrom ?? new Date());
    await tx.pricingRule.updateMany({
      where: { mode: rule.mode, status: "active" },
      data: { status: "archived", archivedAt: new Date() },
    });
    const published = await tx.pricingRule.update({
      where: { id },
      data: { status: "active", effectiveFrom, publishedAt: new Date(), archivedAt: null },
    });
    return { previous, published };
  });
  await writeAudit(request, actor, {
    action: "config.pricing.publish",
    targetType: "pricing_rule",
    targetId: id,
    reason: body.reason,
    before: previous ? pricingAuditSnapshot(previous) : null,
    after: pricingAuditSnapshot(published),
  });
  return ok({ rule: published, previousActiveId: previous?.id ?? null });
}

async function rollbackPricingRule(request: Request, id: string) {
  const actor = await actorWithPermission(request, "config.pricing.write");
  const body = rollbackSchema.parse(await jsonBody(request));
  const current = await prisma.pricingRule.findUnique({ where: { id } });
  if (!current) throw Errors.notFound("Pricing rule not found");
  assertTargetConfirmation(body.confirmation, current.id);
  const previous = await prisma.pricingRule.findFirst({
    where: { ruleKey: current.ruleKey, status: "archived", version: { lt: current.version } },
    orderBy: { version: "desc" },
  });
  if (!previous) throw Errors.notFound("No previous pricing rule version to roll back to");
  const restored = await prisma.$transaction(async (tx) => {
    await tx.pricingRule.updateMany({
      where: { mode: current.mode, status: "active" },
      data: { status: "archived", archivedAt: new Date() },
    });
    return tx.pricingRule.update({
      where: { id: previous.id },
      data: { status: "active", publishedAt: new Date(), archivedAt: null },
    });
  });
  await writeAudit(request, actor, {
    action: "config.pricing.rollback",
    targetType: "pricing_rule",
    targetId: current.id,
    reason: body.reason,
    before: pricingAuditSnapshot(current),
    after: pricingAuditSnapshot(restored),
  });
  return ok({ rule: restored, fromVersion: current.version, toVersion: restored.version });
}

async function moderationQueue(request: Request) {
  await actorWithPermission(request, "safety.review.read");
  const url = new URL(request.url);
  const id = url.searchParams.get("id")?.trim() || undefined;
  const targetType = url.searchParams.get("targetType")?.trim() || undefined;
  const targetId = url.searchParams.get("targetId")?.trim() || undefined;
  const requestedStatuses = url.searchParams
    .get("status")
    ?.split(",")
    .map((status) => status.trim())
    .filter(Boolean);
  const statuses = requestedStatuses?.length
    ? requestedStatuses
    : ["open", "triaged", "reviewing"];
  const reportWhere: Prisma.ContentReportWhereInput = {
    id,
    targetType,
    targetId,
    status: { in: statuses },
  };
  const reports = await prisma.contentReport.findMany({
    where: reportWhere,
    include: { reporter: true, reviews: true },
    orderBy: [{ priority: "asc" }, { createdAt: "desc" }],
    take: clampInt(url.searchParams.get("limit"), 1, 200, 100),
  });
  const blockedMedia = await prisma.mediaAsset.findMany({
    where: { safetyStatus: "blocked", deletedAt: null },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  const appeals = await prisma.appeal.findMany({
    where: { status: "open" },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  return ok({
    reports,
    blockedMedia: blockedMedia.map((asset) => ({
      id: asset.id,
      ownerId: asset.ownerId,
      type: asset.type,
      safetyStatus: asset.safetyStatus,
      createdAt: asset.createdAt,
    })),
    appeals,
  });
}

async function moderationDecision(request: Request, reportId: string) {
  const actor = await actorWithPermission(request, "safety.review.write");
  const body = adminDecisionSchema.parse(await jsonBody(request));
  if (body.decision === "actioned" && body.confirmation !== reportId && body.confirmation !== "TAKEDOWN") {
    throw Errors.badRequest("Actioned decisions require target confirmation");
  }
  const report = await prisma.contentReport.findUnique({ where: { id: reportId } });
  if (!report) throw Errors.notFound("Report not found");
  // Atomic decision: review + report-status + takedown succeed or fail together,
  // guarded so an already-resolved report can't be re-decided (double takedown /
  // audit confusion). A failed takedown (e.g. unknown target) rolls everything
  // back, so the report is never marked handled without content being removed.
  const { review, updated } = await prisma.$transaction(async (tx) => {
    const current = await tx.contentReport.findUnique({ where: { id: reportId } });
    if (!current) throw Errors.notFound("Report not found");
    if (["actioned", "no_violation", "duplicate", "closed"].includes(current.status)) {
      throw Errors.conflict("Report already has a terminal decision");
    }
    const review = await tx.moderationReview.create({
      data: {
        reportId,
        reviewerId: actor.id,
        decision: body.decision,
        policyCode: body.policyCode,
        notes: body.notes,
      },
    });
    const updated = await tx.contentReport.update({
      where: { id: reportId },
      data: { status: body.decision },
    });
    if (body.decision === "actioned") {
      await applyModerationAction(current.targetType, current.targetId, tx);
    }
    const adminCase = await ensureReviewCaseForReport(tx, current);
    if (!adminCase) throw Errors.conflict("Open report did not produce a Review Case");
    const evidence = await tx.caseEvidence.findUniqueOrThrow({
      where: {
        caseId_sourceType_sourceId: {
          caseId: adminCase.id,
          sourceType: "content_report",
          sourceId: current.id,
        },
      },
    });
    await recordReviewCaseDecision(tx, {
      caseId: adminCase.id,
      actor,
      decision: body.decision,
      summary: body.notes ?? body.reason,
      evidenceRefs: [evidence.id],
      downstreamVerified: true,
      requestId: request.headers.get("x-request-id") ?? randomUUID(),
    });
    return { review, updated };
  });
  await writeAudit(request, actor, {
    action: "safety.review.decision",
    targetType: report.targetType,
    targetId: report.targetId,
    reason: body.reason,
    before: { reportId, status: report.status, policyCode: report.category },
    after: { reportId, status: updated.status, policyCode: body.policyCode },
  });
  return ok({ review, report: updated });
}

async function appealDecision(request: Request, appealId: string) {
  const actor = await actorWithPermission(request, "safety.review.write");
  const body = appealDecisionSchema.parse(await jsonBody(request));
  const expectedConfirmation = appealOutcomeConfirmation(body.outcome);
  if (body.confirmation !== expectedConfirmation && body.confirmation !== appealId) {
    throw Errors.badRequest(`Appeal decision requires confirmation ${expectedConfirmation}`);
  }
  const before = await prisma.appeal.findUnique({ where: { id: appealId } });
  if (!before) throw Errors.notFound("Appeal not found");
  if (body.outcome !== "open" && before.status !== "open") {
    throw Errors.conflict("Appeal already has a terminal decision");
  }

  const { appeal, restored } = await prisma.$transaction(async (tx) => {
    const current = await tx.appeal.findUnique({ where: { id: appealId } });
    if (!current) throw Errors.notFound("Appeal not found");
    if (body.outcome !== "open" && current.status !== "open") {
      throw Errors.conflict("Appeal already has a terminal decision");
    }
    const restoreResult =
      body.outcome === "overturned"
        ? await restoreAppealTarget(current.targetType, current.targetId, tx)
        : { targetRestored: false };
    const updated = await tx.appeal.update({
      where: { id: appealId },
      data:
        body.outcome === "open"
          ? { status: "open", reviewerId: null, resolvedAt: null }
          : { status: body.outcome, reviewerId: actor.id, resolvedAt: new Date() },
    });
    const adminCase = await ensureReviewCaseForAppeal(tx, current);
    if (!adminCase) throw Errors.conflict("Open appeal did not produce a Review Case");
    const evidence = await tx.caseEvidence.findUniqueOrThrow({
      where: {
        caseId_sourceType_sourceId: {
          caseId: adminCase.id,
          sourceType: "appeal",
          sourceId: current.id,
        },
      },
    });
    await recordReviewCaseDecision(tx, {
      caseId: adminCase.id,
      actor,
      decision: body.outcome,
      summary: body.notes ?? `Appeal ${body.outcome}`,
      evidenceRefs: [evidence.id],
      downstreamVerified: body.outcome !== "open",
      requestId: request.headers.get("x-request-id") ?? randomUUID(),
    });
    return { appeal: updated, restored: restoreResult };
  });

  await writeAudit(request, actor, {
    action: "safety.appeal.decision",
    targetType: "appeal",
    targetId: appeal.id,
    reason: body.reason,
    before: {
      status: before.status,
      targetType: before.targetType,
      targetId: before.targetId,
    },
    after: {
      status: appeal.status,
      targetType: appeal.targetType,
      targetId: appeal.targetId,
      notes: body.notes,
      ...restored,
    },
  });

  return ok({ appeal, target: restored });
}

function appealOutcomeConfirmation(outcome: z.infer<typeof appealDecisionSchema>["outcome"]) {
  if (outcome === "upheld") return "UPHOLD";
  if (outcome === "overturned") return "OVERTURN";
  if (outcome === "modified") return "MODIFY";
  return "REOPEN";
}

async function billingLedger(request: Request) {
  await actorWithPermission(request, "billing.read");
  const url = new URL(request.url);
  const userId = url.searchParams.get("userId") ?? undefined;
  const reason = url.searchParams.get("reason") ?? undefined;
  const entries = await prisma.dreamcoinLedger.findMany({
    where: { userId, reason },
    include: { user: true },
    orderBy: { createdAt: "desc" },
    take: clampInt(url.searchParams.get("limit"), 1, 100, 50),
  });
  return ok({
    items: entries.map((entry) => ({
      id: entry.id,
      userId: entry.userId,
      userEmail: entry.user.email,
      delta: entry.delta,
      balanceAfter: entry.balanceAfter,
      reason: entry.reason,
      sourceId: entry.sourceId,
      createdAt: entry.createdAt,
    })),
  });
}

// SPEC: 订阅运营视图 —— 按 user/status 查订阅，定位"付了钱没生效/要退款"的工单。只读。
// INTENT: 受控 beta 客服排障所需；订阅级退款仍走 billing.ledger.adjust（带关联 id），不自建退款网关。
async function listSubscriptions(request: Request) {
  await actorWithPermission(request, "billing.read");
  const url = new URL(request.url);
  const userId = url.searchParams.get("userId")?.trim() || undefined;
  const status = url.searchParams.get("status")?.trim() || undefined;
  const subscriptions = await prisma.subscription.findMany({
    where: { userId, status },
    include: { plan: true, user: true },
    orderBy: { createdAt: "desc" },
    take: clampInt(url.searchParams.get("limit"), 1, 100, 50),
  });
  return ok({
    items: subscriptions.map((subscription) => ({
      id: subscription.id,
      userId: subscription.userId,
      userEmail: subscription.user.email,
      plan: subscription.plan.slug,
      billingPeriod: subscription.plan.billingPeriod,
      provider: subscription.provider,
      status: subscription.status,
      currentPeriodEnd: subscription.currentPeriodEnd,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      providerSubscriptionId: subscription.providerSubscriptionId,
      createdAt: subscription.createdAt,
    })),
  });
}

// SPEC: 资金对账只读报表 —— 按时间窗对 DreamcoinLedger 分 reason 聚合 + 活跃订阅数，给运营每日对账。
// INTENT: 只读，不写；数与 ledger 求和一致。默认窗口最近 30 天。
async function billingReconciliation(request: Request) {
  await actorWithPermission(request, "billing.read");
  const url = new URL(request.url);
  const now = new Date();
  const fromParam = url.searchParams.get("from");
  const toParam = url.searchParams.get("to");
  const to = toParam ? new Date(toParam) : now;
  const from = fromParam ? new Date(fromParam) : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw Errors.badRequest("Invalid reconciliation window");
  }
  const [grouped, activeSubscriptions] = await Promise.all([
    prisma.dreamcoinLedger.groupBy({
      by: ["reason"],
      where: { createdAt: { gte: from, lte: to } },
      _sum: { delta: true },
      _count: { _all: true },
    }),
    prisma.subscription.count({ where: { status: "active" } }),
  ]);
  const byReason = grouped
    .map((row) => ({ reason: row.reason, totalDelta: row._sum.delta ?? 0, count: row._count._all }))
    .sort((a, b) => a.reason.localeCompare(b.reason));
  const totals = byReason.reduce(
    (acc, row) => ({ net: acc.net + row.totalDelta, entries: acc.entries + row.count }),
    { net: 0, entries: 0 },
  );
  return ok({
    window: { from: from.toISOString(), to: to.toISOString() },
    activeSubscriptions,
    byReason,
    totals,
  });
}

async function billingAdjustment(request: Request) {
  const actor = await actorWithPermission(request, "billing.ledger.adjust");
  const body = ledgerAdjustmentSchema.parse(await jsonBody(request));
  const expectedConfirmation = ledgerAdjustmentConfirmation(body.userId, body.delta);
  if (body.confirmation !== expectedConfirmation) {
    throw Errors.badRequest("Confirmation did not match ledger adjustment target");
  }
  const entry = await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: body.userId } });
    if (!user) throw Errors.notFound("User not found");
    // 高危：大额 ledger 调整在硬门控开启时需双人审批凭据。
    if (Math.abs(body.delta) >= LEDGER_APPROVAL_THRESHOLD) {
      await enforceApproval("billing.ledger.adjust", body.userId, tx);
    }
    return appendLedger(tx, body.userId, body.delta, "admin_adjust", body.sourceId ?? randomUUID());
  });
  await writeAudit(request, actor, {
    action: "billing.ledger.adjust",
    targetType: "user",
    targetId: body.userId,
    reason: body.reason,
    after: {
      ledgerEntryId: entry.id,
      delta: entry.delta,
      balanceAfter: entry.balanceAfter,
      sourceId: entry.sourceId,
    },
  });
  return ok({ ledgerEntry: entry });
}

function ledgerAdjustmentConfirmation(userId: string, delta: number) {
  return `${userId}:${delta}`;
}

function featureFlagConfirmation(key: string, enabled: boolean | undefined) {
  if (enabled === undefined) return `${key}:updated`;
  return `${key}:${enabled === false ? "disabled" : "enabled"}`;
}

async function listFeatureFlags(request: Request) {
  await actorWithPermission(request, "ops.queue.read");
  const flags = await prisma.featureFlag.findMany({ orderBy: { key: "asc" } });
  return ok({ items: flags });
}

async function patchFeatureFlag(request: Request, key: string) {
  const actor = await actorWithPermission(request, "config.feature_flag.write");
  const body = flagPatchSchema.parse(await jsonBody(request));
  if (isHardPolicyFlag(key)) {
    throw Errors.forbidden("Hard safety policy flags cannot be changed");
  }
  const expectedConfirmation = featureFlagConfirmation(key, body.enabled);
  if (body.confirmation !== expectedConfirmation) {
    throw Errors.badRequest("Confirmation did not match feature flag action");
  }
  const before = await prisma.featureFlag.findUnique({ where: { key } });
  if (before?.hardPolicy) throw Errors.forbidden("Hard safety policy flags cannot be changed");
  const updated = await prisma.featureFlag.upsert({
    where: { key },
    update: {
      enabled: body.enabled,
      rolloutPercent: body.rolloutPercent,
      targetRoles: body.targetRoles ? toInputJson(body.targetRoles) : undefined,
      targetPlans: body.targetPlans ? toInputJson(body.targetPlans) : undefined,
      description: body.description,
      version: { increment: 1 },
    },
    create: {
      key,
      label: key,
      description: body.description,
      enabled: body.enabled ?? false,
      rolloutPercent: body.rolloutPercent ?? 0,
      targetRoles: toInputJson(body.targetRoles ?? []),
      targetPlans: toInputJson(body.targetPlans ?? []),
    },
  });
  await writeAudit(request, actor, {
    action: "config.feature_flag.write",
    targetType: "feature_flag",
    targetId: key,
    reason: body.reason,
    before: before ? flagAuditSnapshot(before) : null,
    after: flagAuditSnapshot(updated),
  });
  return ok({ flag: updated });
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

async function auditLog(request: Request) {
  await actorWithPermission(request, "audit.read");
  const url = new URL(request.url);
  const action = url.searchParams.get("action") ?? undefined;
  const actorId = url.searchParams.get("actorId") ?? undefined;
  const targetType = url.searchParams.get("targetType") ?? undefined;
  const logs = await prisma.adminAuditLog.findMany({
    where: { action, actorId, targetType },
    orderBy: { createdAt: "desc" },
    take: clampInt(url.searchParams.get("limit"), 1, 200, 80),
  });
  return ok({ items: logs });
}

async function listSupportRequests(request: Request) {
  await actorWithPermission(request, "support.request.read");
  const url = new URL(request.url);
  const ticketId = url.searchParams.get("ticketId")?.trim() || undefined;
  const userId = url.searchParams.get("userId")?.trim() || undefined;
  const assignedToId = url.searchParams.get("assignedToId")?.trim() || undefined;
  const category = url.searchParams.get("category")?.trim() || undefined;
  const sla = supportSlaStateFromUnknown(url.searchParams.get("sla"));
  const requestedStatuses = url.searchParams
    .get("status")
    ?.split(",")
    .map((status) => status.trim())
    .filter(Boolean);
  const statusFilter = requestedStatuses?.length && !requestedStatuses.includes("all")
    ? requestedStatuses.includes("active")
      ? { notIn: ["resolved", "closed"] }
      : { in: requestedStatuses }
    : undefined;
  const where: Prisma.SupportRequestWhereInput = {
    ticketId,
    userId,
    assignedToId,
    category,
    status: statusFilter,
  };
  const items = await prisma.supportRequest.findMany({
    where,
    include: {
      assignedTo: { select: { id: true, email: true, displayName: true, role: true } },
      user: { select: { id: true, email: true, displayName: true, role: true } },
    },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    take: clampInt(url.searchParams.get("limit"), 1, 200, 100),
  });
  const dtos = items.map((item) => supportRequestDTO(item));
  return ok({ items: sla === "all" ? dtos : dtos.filter((item) => item.slaState === sla) });
}

async function patchSupportRequest(request: Request, ticketId: string) {
  const actor = await actorWithPermission(request, "support.request.write");
  const body = supportRequestPatchSchema.parse(await jsonBody(request));
  if (body.confirmation !== ticketId && body.confirmation !== "UPDATE") {
    throw Errors.badRequest("Support request updates require ticket confirmation");
  }
  const before = await prisma.supportRequest.findUnique({ where: { ticketId } });
  if (!before) throw Errors.notFound("Support request not found");
  const terminal = body.status === "resolved" || body.status === "closed";
  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.supportRequest.update({
      where: { ticketId },
      data: {
        assignedToId: body.assignedToId === undefined ? undefined : body.assignedToId,
        priority: body.priority,
        resolutionNotes: body.resolutionNotes === undefined ? undefined : body.resolutionNotes,
        resolvedAt: body.status === undefined ? undefined : terminal ? new Date() : null,
        status: body.status,
      },
      include: {
        assignedTo: { select: { id: true, email: true, displayName: true, role: true } },
        user: { select: { id: true, email: true, displayName: true, role: true } },
      },
    });
    await synchronizeSupportCaseFromRequest(tx, row);
    return row;
  });

  await writeAudit(request, actor, {
    action: "support.request.update",
    targetType: "support_request",
    targetId: ticketId,
    reason: body.reason,
    before: {
      assignedToId: before.assignedToId,
      priority: before.priority,
      resolutionNotes: before.resolutionNotes,
      status: before.status,
    },
    after: {
      assignedToId: updated.assignedToId,
      priority: updated.priority,
      resolutionNotes: updated.resolutionNotes,
      status: updated.status,
    },
  });

  return ok({ request: supportRequestDTO(updated) });
}

async function escalateSupportRequest(request: Request, ticketId: string) {
  const actor = await actorWithPermission(request, "support.request.write");
  const body = supportRequestEscalateSchema.parse(await jsonBody(request));
  if (body.confirmation !== ticketId && body.confirmation !== "ESCALATE") {
    throw Errors.badRequest("Support escalation requires ticket confirmation");
  }
  const before = await prisma.supportRequest.findUnique({
    where: { ticketId },
    include: {
      assignedTo: { select: { id: true, email: true, displayName: true, role: true } },
      user: { select: { id: true, email: true, displayName: true, role: true } },
    },
  });
  if (!before) throw Errors.notFound("Support request not found");
  if (before.status === "resolved" || before.status === "closed") {
    throw Errors.badRequest("Resolved or closed support requests cannot be escalated");
  }
  const beforeSla = supportRequestSla(before);
  if (beforeSla.state !== "overdue" && beforeSla.state !== "due_soon") {
    throw Errors.badRequest("Only due-soon or overdue support requests can be escalated");
  }
  const escalatedAt = new Date();
  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.supportRequest.update({
      where: { ticketId },
      data: {
        assignedToId: before.assignedToId ?? actor.id,
        priority: 1,
        slaEscalatedAt: escalatedAt,
        slaEscalatedById: actor.id,
        slaEscalationReason: body.reason,
        status: before.status === "received" ? "open" : before.status,
      },
      include: {
        assignedTo: { select: { id: true, email: true, displayName: true, role: true } },
        user: { select: { id: true, email: true, displayName: true, role: true } },
      },
    });
    await synchronizeSupportCaseFromRequest(tx, row);
    return row;
  });

  await writeAudit(request, actor, {
    action: "support.request.escalate",
    targetType: "support_request",
    targetId: ticketId,
    reason: body.reason,
    before: {
      assignedToId: before.assignedToId,
      priority: before.priority,
      slaEscalatedAt: before.slaEscalatedAt,
      slaState: beforeSla.state,
      status: before.status,
    },
    after: {
      assignedToId: updated.assignedToId,
      priority: updated.priority,
      slaEscalatedAt: updated.slaEscalatedAt,
      slaState: supportRequestSla(updated).state,
      status: updated.status,
    },
  });

  return ok({ request: supportRequestDTO(updated) });
}

type SupportRequestRow = Prisma.SupportRequestGetPayload<{
  include: {
    assignedTo: { select: { id: true; email: true; displayName: true; role: true } };
    user: { select: { id: true; email: true; displayName: true; role: true } };
  };
}>;

function supportRequestDTO(request: SupportRequestRow) {
  const sla = supportRequestSla(request);
  return {
    id: request.id,
    ticketId: request.ticketId,
    userId: request.userId,
    userEmail: request.user.email,
    userName: request.user.displayName ?? request.user.email,
    category: request.category,
    subject: request.subject,
    description: request.description,
    diagnosticConsent: request.diagnosticConsent,
    sourcePath: request.sourcePath,
    status: request.status,
    priority: request.priority,
    assignedToId: request.assignedToId,
    assignedToEmail: request.assignedTo?.email ?? null,
    assignedToName: request.assignedTo?.displayName ?? request.assignedTo?.email ?? null,
    slaEscalatedAt: request.slaEscalatedAt?.toISOString() ?? null,
    slaEscalatedById: request.slaEscalatedById,
    slaEscalationReason: request.slaEscalationReason,
    resolutionNotes: request.resolutionNotes,
    resolvedAt: request.resolvedAt?.toISOString() ?? null,
    slaDueAt: sla.dueAt?.toISOString() ?? null,
    slaHoursRemaining: sla.hoursRemaining,
    slaState: sla.state,
    createdAt: request.createdAt.toISOString(),
    updatedAt: request.updatedAt.toISOString(),
  };
}

const supportSlaHoursByPriority = new Map([
  [1, 4],
  [2, 12],
  [3, 24],
  [4, 48],
  [5, 72],
]);

type SupportSlaState = "all" | "overdue" | "due_soon" | "on_track" | "paused" | "closed";

function supportSlaStateFromUnknown(value: string | null): SupportSlaState {
  if (value === "overdue" || value === "due_soon" || value === "on_track" || value === "paused" || value === "closed") {
    return value;
  }
  return "all";
}

function supportRequestSla(request: SupportRequestRow) {
  if (request.status === "resolved" || request.status === "closed") {
    return { dueAt: null, hoursRemaining: null, state: "closed" as const };
  }
  if (request.status === "waiting_on_user") {
    return { dueAt: null, hoursRemaining: null, state: "paused" as const };
  }
  const hours = supportSlaHoursByPriority.get(request.priority) ?? 24;
  const dueAt = new Date(request.createdAt.getTime() + hours * 60 * 60 * 1000);
  const hoursRemaining = Math.ceil((dueAt.getTime() - Date.now()) / (60 * 60 * 1000));
  const state = hoursRemaining < 0 ? "overdue" : hoursRemaining <= 4 ? "due_soon" : "on_track";
  return { dueAt, hoursRemaining, state };
}

async function viewPlaintext(request: Request) {
  const actor = await actorWithPermission(request, "support.plaintext.view");
  const body = plaintextViewSchema.parse(await jsonBody(request));
  if (body.confirmation !== body.targetId) {
    throw Errors.badRequest("Confirmation did not match plaintext target");
  }
  const target = await plaintextTarget(body.targetType, body.targetId);
  if (!target) throw Errors.notFound("Plaintext target not found");
  const grant = body.ticketId
    ? await prisma.supportConsentGrant.findFirst({
        where: {
          userId: target.ownerId,
          ticketId: body.ticketId,
          targetType: body.targetType,
          targetId: body.targetId,
          expiresAt: { gt: new Date() },
        },
      })
    : null;
  const hold = body.legalHoldId
    ? await prisma.legalHold.findFirst({
        where: {
          id: body.legalHoldId,
          targetType: body.targetType,
          targetId: body.targetId,
          status: "active",
        },
      })
    : null;
  if (!grant && !hold) {
    throw Errors.forbidden("Plaintext view requires active support consent or legal hold");
  }
  const plaintext = hold
    ? target.plaintext
    : plaintextAllowedByConsent(target.plaintext, grant?.scope);
  if (Object.keys(plaintext).length === 0) {
    throw Errors.forbidden("Plaintext view grant does not authorize any plaintext fields");
  }

  await writeAudit(request, actor, {
    action: "support.plaintext.view",
    targetType: body.targetType,
    targetId: body.targetId,
    reason: body.reason,
    after: {
      ticketId: grant?.ticketId ?? null,
      legalHoldId: hold?.id ?? null,
      viewedFields: Object.keys(plaintext),
    },
  });

  return ok({
    target: {
      type: body.targetType,
      id: body.targetId,
      ownerId: target.ownerId,
    },
    plaintext,
    authorization: {
      ticketId: grant?.ticketId ?? null,
      legalHoldId: hold?.id ?? null,
    },
  });
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
  const where: Prisma.CharacterWhereInput = { status, visibility, creatorId, deletedAt: null };
  if (search) {
    where.OR = [{ id: { contains: search } }, { name: { contains: search } }];
  }
  const orderBy: Prisma.CharacterOrderByWithRelationInput =
    sort === "popular" ? { stats: { chatsCount: "desc" } } : { createdAt: "desc" };
  const items = await prisma.character.findMany({
    where,
    orderBy,
    take: clampInt(url.searchParams.get("limit"), 1, 100, 60),
    select: {
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
    },
  });
  return ok({ items });
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
  const after = await prisma.character.update({
    where: { id },
    data: { visibility: body.visibility },
  });
  await writeAudit(request, actor, {
    action: "content.visibility.write",
    targetType: "character",
    targetId: id,
    reason: body.reason,
    before: { visibility: before.visibility },
    after: { visibility: after.visibility },
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
  const after = await prisma.character.update({
    where: { id },
    data: { status: body.status },
  });
  await writeAudit(request, actor, {
    action: "content.status.write",
    targetType: "character",
    targetId: id,
    reason: body.reason,
    before: { status: before.status },
    after: { status: after.status },
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

// ── F4 Redeem code / Referral 运营面 ──
async function listRedeemCodes(request: Request) {
  await actorWithPermission(request, "growth.promo.read");
  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? undefined;
  const codes = await prisma.redeemCode.findMany({
    where: { status },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { _count: { select: { redemptions: true } } },
  });
  // 不回明文 code（只存 hash），运营按 id + reward 元数据管理。
  const items = codes.map((code) => ({
    id: code.id,
    reward: code.reward,
    status: code.status,
    maxRedemptions: code.maxRedemptions,
    redemptions: code._count.redemptions,
    expiresAt: code.expiresAt,
    createdAt: code.createdAt,
  }));
  return ok({ items });
}

async function createRedeemCode(request: Request) {
  const actor = await actorWithPermission(request, "growth.promo.write");
  const body = redeemCodeCreateSchema.parse(await jsonBody(request));
  if (body.confirmation !== body.code) {
    throw Errors.badRequest("Confirmation did not match");
  }
  const codeHash = redeemCodeHash(body.code);
  const existing = await prisma.redeemCode.findFirst({
    where: { codeHash: { in: redeemCodeHashCandidates(body.code) } },
  });
  if (existing) throw Errors.badRequest("Redeem code already exists");
  const code = await prisma.redeemCode.create({
    data: {
      codeHash,
      reward: toInputJson(body.reward),
      status: "active",
      maxRedemptions: body.maxRedemptions ?? null,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
    },
  });
  // 审计不写明文 code，只记 id + reward 元数据。
  await writeAudit(request, actor, {
    action: "promo.redeem_code.create",
    targetType: "redeem_code",
    targetId: code.id,
    reason: body.reason,
    after: { reward: body.reward, maxRedemptions: code.maxRedemptions, expiresAt: code.expiresAt },
  });
  return ok({ id: code.id, status: code.status });
}

async function disableRedeemCode(request: Request, id: string) {
  const actor = await actorWithPermission(request, "growth.promo.write");
  const body = promoDisableSchema.parse(await jsonBody(request));
  const before = await prisma.redeemCode.findUnique({ where: { id } });
  if (!before) throw Errors.notFound("Redeem code not found");
  assertTargetConfirmation(body.confirmation, before.id);
  const after = await prisma.redeemCode.update({ where: { id }, data: { status: "disabled" } });
  await writeAudit(request, actor, {
    action: "promo.redeem_code.disable",
    targetType: "redeem_code",
    targetId: id,
    reason: body.reason,
    before: { status: before.status },
    after: { status: after.status },
  });
  return ok({ id: after.id, status: after.status });
}

async function listReferrals(request: Request) {
  await actorWithPermission(request, "growth.promo.read");
  const url = new URL(request.url);
  const inviterId = url.searchParams.get("inviterId") ?? undefined;
  const status = url.searchParams.get("status") ?? undefined;
  const items = await prisma.referral.findMany({
    where: { inviterId, status },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return ok({ items });
}

// ── F5 双人审批（AdminActionRequest）──
async function listApprovals(request: Request) {
  await actorWithPermission(request, "admin.approval.review");
  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? "pending";
  const items = await prisma.adminActionRequest.findMany({
    where: { status },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return ok({ items });
}

async function createApproval(request: Request) {
  // 发起方须持目标 action 的 permission key（不能请求自己无权做的事）。
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  const body = approvalCreateSchema.parse(await jsonBody(request));
  if (body.confirmation !== approvalRequestConfirmation(body.targetId, body.action)) {
    throw Errors.badRequest("Confirmation did not match approval target");
  }
  if (!isPermissionKey(body.permissionKey)) throw Errors.badRequest("Unknown permission key");
  const perms = await effectivePermissions(user.id, user.role);
  if (!perms.has(body.permissionKey)) {
    throw Errors.forbidden("Cannot request an action you lack permission for", {
      permission: body.permissionKey,
    });
  }
  const actor: AdminActor = { id: user.id, role: user.role };
  const created = await prisma.adminActionRequest.create({
    data: {
      requestedById: actor.id,
      permissionKey: body.permissionKey,
      action: body.action,
      targetType: body.targetType,
      targetId: body.targetId,
      payload: toInputJson(body.payload),
      status: "pending",
      reason: body.reason,
    },
  });
  await writeAudit(request, actor, {
    action: "admin.approval.request",
    targetType: body.targetType,
    targetId: body.targetId,
    reason: body.reason,
    after: { requestId: created.id, permissionKey: body.permissionKey, action: body.action },
  });
  return ok({ request: created });
}

function approvalRequestConfirmation(targetId: string, action: string) {
  return `${targetId}:${action}`;
}

async function approveApproval(request: Request, id: string) {
  const actor = await actorWithPermission(request, "admin.approval.review");
  const body = approvalDecisionSchema.parse(await jsonBody(request));
  const req = await prisma.adminActionRequest.findUnique({ where: { id } });
  if (!req) throw Errors.notFound("Approval request not found");
  assertTargetConfirmation(body.confirmation, req.id);
  if (req.status !== "pending") throw Errors.badRequest("Approval request is not pending");
  // 不变量：审批人 ≠ 发起人。
  if (req.requestedById === actor.id) {
    throw Errors.badRequest("Approver must differ from requester");
  }
  // 不变量：审批人须持该请求声明的 permission key。
  if (!isPermissionKey(req.permissionKey)) {
    throw Errors.badRequest("Request has an unknown permission key");
  }
  const perms = await effectivePermissions(actor.id, actor.role);
  if (!perms.has(req.permissionKey)) {
    throw Errors.forbidden("Approver lacks the permission required by this request", {
      permission: req.permissionKey,
    });
  }
  const updated = await prisma.adminActionRequest.update({
    where: { id },
    data: { status: "approved", approvedById: actor.id, decidedAt: new Date() },
  });
  await writeAudit(request, actor, {
    action: "admin.approval.approve",
    targetType: req.targetType,
    targetId: req.targetId,
    reason: body.reason,
    before: { status: "pending" },
    after: { status: "approved", requestId: updated.id, permissionKey: req.permissionKey },
  });
  return ok({ request: updated });
}

async function rejectApproval(request: Request, id: string) {
  const actor = await actorWithPermission(request, "admin.approval.review");
  const body = approvalDecisionSchema.parse(await jsonBody(request));
  const req = await prisma.adminActionRequest.findUnique({ where: { id } });
  if (!req) throw Errors.notFound("Approval request not found");
  assertTargetConfirmation(body.confirmation, req.id);
  if (req.status !== "pending") throw Errors.badRequest("Approval request is not pending");
  const updated = await prisma.adminActionRequest.update({
    where: { id },
    data: { status: "rejected", approvedById: actor.id, decidedAt: new Date() },
  });
  await writeAudit(request, actor, {
    action: "admin.approval.reject",
    targetType: req.targetType,
    targetId: req.targetId,
    reason: body.reason,
    before: { status: "pending" },
    after: { status: "rejected", requestId: updated.id },
  });
  return ok({ request: updated });
}

// ── F6 Chat 运营面（代理到 chat 服务内部 admin 只读 API；尊重 DB 边界，默认不回明文） ──
// INTENT: chat 服务不可达/未配置时降级返回 configured:false（与既有 chat BFF 降级一致），不抛 500。
type ChatAdminProxyResult = {
  configured: boolean;
  data: unknown | null;
  diagnostics: {
    reason?: "missing_url" | "unreachable" | "unauthorized" | "upstream_error" | "bad_json";
    status?: number;
    serviceUrlConfigured: boolean;
  };
};

async function proxyChatAdmin(path: string): Promise<ChatAdminProxyResult> {
  if (!env.CHAT_SERVICE_URL) {
    return {
      configured: false,
      data: null,
      diagnostics: { reason: "missing_url", serviceUrlConfigured: false },
    };
  }
  try {
    const res = await fetch(`${env.CHAT_SERVICE_URL}${path}`, {
      headers: { "x-internal-token": env.INTERNAL_TOKEN },
    });
    if (!res.ok) {
      return {
        configured: false,
        data: null,
        diagnostics: {
          reason: res.status === 401 ? "unauthorized" : "upstream_error",
          status: res.status,
          serviceUrlConfigured: true,
        },
      };
    }
    try {
      return {
        configured: true,
        data: (await res.json()) as unknown,
        diagnostics: { serviceUrlConfigured: true },
      };
    } catch {
      return {
        configured: false,
        data: null,
        diagnostics: { reason: "bad_json", serviceUrlConfigured: true },
      };
    }
  } catch {
    // 故意降级：chat 服务暂不可达不应让 admin 控制台整体 500。
    return {
      configured: false,
      data: null,
      diagnostics: { reason: "unreachable", serviceUrlConfigured: true },
    };
  }
}

async function chatOpsOverview(request: Request) {
  await actorWithPermission(request, "chat.ops.read");
  const result = await proxyChatAdmin("/internal/admin/overview");
  return ok({
    configured: result.configured,
    diagnostics: result.diagnostics,
    overview: isRecord(result.data) ? result.data : null,
  });
}

async function chatOpsProviderHealth(request: Request) {
  await actorWithPermission(request, "chat.ops.read");
  const result = await proxyChatAdmin("/internal/admin/provider-health");
  return ok({
    configured: result.configured,
    diagnostics: result.diagnostics,
    ...(isRecord(result.data) ? result.data : { items: [] }),
  });
}

async function chatOpsSessions(request: Request) {
  await actorWithPermission(request, "chat.ops.read");
  const url = new URL(request.url);
  const params = new URLSearchParams();
  const userId = url.searchParams.get("userId");
  const characterId = url.searchParams.get("characterId");
  const status = url.searchParams.get("status");
  if (userId) params.set("userId", userId);
  if (characterId) params.set("characterId", characterId);
  if (status) params.set("status", status);
  params.set("limit", String(clampInt(url.searchParams.get("limit"), 1, 100, 50)));
  const result = await proxyChatAdmin(`/internal/admin/sessions?${params.toString()}`);
  return ok({
    configured: result.configured,
    diagnostics: result.diagnostics,
    ...(isRecord(result.data) ? result.data : { items: [] }),
  });
}

async function chatOpsUsage(request: Request) {
  await actorWithPermission(request, "chat.ops.read");
  const url = new URL(request.url);
  const params = new URLSearchParams();
  const userId = url.searchParams.get("userId");
  if (userId) params.set("userId", userId);
  params.set("limit", String(clampInt(url.searchParams.get("limit"), 1, 100, 50)));
  const result = await proxyChatAdmin(`/internal/admin/usage?${params.toString()}`);
  return ok({
    configured: result.configured,
    diagnostics: result.diagnostics,
    ...(isRecord(result.data) ? result.data : { items: [] }),
  });
}

async function chatOpsModerationEvents(request: Request) {
  await actorWithPermission(request, "chat.ops.read");
  const url = new URL(request.url);
  const params = new URLSearchParams();
  const status = url.searchParams.get("status");
  const layer = url.searchParams.get("layer");
  const policyCode = url.searchParams.get("policyCode");
  const targetType = url.searchParams.get("targetType");
  const targetId = url.searchParams.get("targetId");
  if (status) params.set("status", status);
  if (layer) params.set("layer", layer);
  if (policyCode) params.set("policyCode", policyCode);
  if (targetType) params.set("targetType", targetType);
  if (targetId) params.set("targetId", targetId);
  params.set("limit", String(clampInt(url.searchParams.get("limit"), 1, 100, 50)));
  const result = await proxyChatAdmin(`/internal/admin/moderation-events?${params.toString()}`);
  return ok({
    configured: result.configured,
    diagnostics: result.diagnostics,
    ...(isRecord(result.data) ? result.data : { items: [] }),
  });
}

export async function actorWithPermission(
  request: Request,
  permission: PermissionKey,
  resource?: { readonly characterId?: string },
): Promise<AdminActor> {
  const bff = await verifyAdminBffRequest(request);
  if (!bff.ok) {
    throw Errors.unauthorized("Admin BFF authentication failed", { reason: bff.reason });
  }
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  const effective = await effectivePermissions(user.id, user.role);
  if (!effective.has(permission)) {
    throw Errors.forbidden("Missing admin permission", { permission });
  }
  if (resource?.characterId && permission.startsWith("character.")) {
    const allowedCharacterIds = await effectiveCharacterIdsForPermission(user.id, user.role, permission);
    if (allowedCharacterIds !== null && !allowedCharacterIds.has(resource.characterId)) {
      throw Errors.forbidden("Character is outside the effective permission scope", {
        permission,
        characterId: resource.characterId,
      });
    }
  }
  return { id: user.id, role: user.role };
}

export async function writeAudit(
  request: Request,
  actor: AdminActor,
  input: {
    action: string;
    targetType: string;
    targetId: string;
    reason?: string;
    before?: unknown;
    after?: unknown;
  },
) {
  return prisma.adminAuditLog.create({
    data: {
      actorId: actor.id,
      actorRole: actor.role,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      reason: input.reason,
      before: input.before === undefined ? undefined : toInputJson(stripSensitive(input.before)),
      after: input.after === undefined ? undefined : toInputJson(stripSensitive(input.after)),
      requestId: request.headers.get("x-request-id") ?? randomUUID(),
      ipHash: hashHeader(request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip")),
      userAgent: request.headers.get("user-agent") ?? undefined,
    },
  });
}

async function appendAdminGenerationEvent(
  tx: Prisma.TransactionClient,
  jobId: string,
  type: string,
  message: string,
  metadata: Record<string, unknown>,
) {
  return tx.generationJobEvent.create({
    data: {
      jobId,
      type,
      message,
      metadata: toInputJson(metadata),
    },
  });
}

function redactJob(job: {
  id: string;
  userId: string;
  derivedFromJobId?: string | null;
  mode: string;
  prompt: string | null;
  negativePrompt: string | null;
  presetIds: Prisma.JsonValue;
  model: string | null;
  profileId: string | null;
  profileVersion: number | null;
  recipeId: string | null;
  recipeVersion: number | null;
  orientation: string | null;
  outputCount: number;
  status: string;
  costDreamcoins: number;
  provider: string | null;
  errorCode: string | null;
  createdAt: Date;
  updatedAt?: Date;
  completedAt: Date | null;
  assets?: Array<{
    id: string;
    type: string;
    url: string;
    thumbnailUrl: string | null;
    storageKey?: string | null;
    safetyStatus: string;
    createdAt: Date;
  }>;
}) {
  return {
    id: job.id,
    userId: job.userId,
    derivedFromJobId: job.derivedFromJobId ?? null,
    mode: job.mode,
    model: job.model,
    profileId: job.profileId,
    profileVersion: job.profileVersion,
    recipeId: job.recipeId,
    recipeVersion: job.recipeVersion,
    presetIds: job.presetIds,
    orientation: job.orientation,
    outputCount: job.outputCount,
    status: job.status,
    costDreamcoins: job.costDreamcoins,
    provider: job.provider,
    errorCode: job.errorCode,
    promptHidden: Boolean(job.prompt),
    negativePromptHidden: Boolean(job.negativePrompt),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
    assets: job.assets?.filter(isReadableMediaAsset).map(redactMediaAsset) ?? [],
  };
}

function redactMediaAsset(asset: {
  id: string;
  type: string;
  url: string;
  thumbnailUrl: string | null;
  storageKey?: string | null;
  safetyStatus: string;
  createdAt: Date;
}) {
  return {
    id: asset.id,
    type: asset.type,
    url: asset.url,
    thumbnailUrl: asset.thumbnailUrl ?? asset.url,
    safetyStatus: asset.safetyStatus,
    createdAt: asset.createdAt,
  };
}

function isReadableMediaAsset(asset: { storageKey?: string | null }) {
  if ((process.env.BLOB_PROVIDER ?? "mock") !== "mock") return true;
  if (!asset.storageKey) return true;
  return existsSync(resolveLocalBlobPath(asset.storageKey));
}

function publicUser(user: {
  id: string;
  email: string;
  displayName: string | null;
  name: string | null;
  role: string;
  status: string;
  createdAt: Date;
}) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName ?? user.name,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt,
  };
}

function profileAuditSnapshot(profile: {
  profileKey: string;
  mode: string;
  runner: string;
  pipelineModel: string;
  sourceModelPath: string | null;
  convertedModelPath: string | null;
  modelFormat: string;
  steps: number;
  sampler: string;
  scheduler: string;
  cfgScale: number;
  costMultiplier: number;
  requiredEntitlement: string | null;
  enabled: boolean;
  rolloutPercent: number;
  version: number;
  status: string;
}) {
  return {
    profileKey: profile.profileKey,
    mode: profile.mode,
    runner: profile.runner,
    pipelineModel: profile.pipelineModel,
    sourceModelPath: profile.sourceModelPath,
    convertedModelPath: profile.convertedModelPath,
    modelFormat: profile.modelFormat,
    steps: profile.steps,
    sampler: profile.sampler,
    scheduler: profile.scheduler,
    cfgScale: profile.cfgScale,
    costMultiplier: profile.costMultiplier,
    requiredEntitlement: profile.requiredEntitlement,
    enabled: profile.enabled,
    rolloutPercent: profile.rolloutPercent,
    version: profile.version,
    status: profile.status,
  };
}

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

function pricingAuditSnapshot(rule: {
  ruleKey: string;
  mode: string;
  baseCost: number;
  multiplier: number;
  version: number;
  status: string;
}) {
  return {
    ruleKey: rule.ruleKey,
    mode: rule.mode,
    baseCost: rule.baseCost,
    multiplier: rule.multiplier,
    version: rule.version,
    status: rule.status,
  };
}

function flagAuditSnapshot(flag: {
  key: string;
  enabled: boolean;
  rolloutPercent: number;
  version: number;
}) {
  return {
    key: flag.key,
    enabled: flag.enabled,
    rolloutPercent: flag.rolloutPercent,
    version: flag.version,
  };
}

async function plaintextTarget(
  targetType: "generation_job" | "media",
  targetId: string,
): Promise<{ ownerId: string; plaintext: PlaintextFields } | null> {
  if (targetType === "generation_job") {
    const job = await prisma.generationJob.findUnique({ where: { id: targetId } });
    if (!job) return null;
    return {
      ownerId: job.userId,
      plaintext: {
        prompt: job.prompt,
        negativePrompt: job.negativePrompt,
      },
    };
  }

  const media = await prisma.mediaAsset.findUnique({ where: { id: targetId } });
  if (!media) return null;
  return {
    ownerId: media.ownerId,
    plaintext: {
      prompt: media.prompt,
    },
  };
}

async function applyModerationAction(
  targetType: string,
  targetId: string,
  db: Prisma.TransactionClient | typeof prisma = prisma,
) {
  // INVARIANT: "actioned" must actually take content down. Feed items wrap a
  // character, so resolve and remove it; unknown target types throw so the
  // decision transaction rolls back instead of marking a report falsely handled.
  if (targetType === "character") {
    await db.character.updateMany({
      where: { id: targetId },
      data: { status: "removed" },
    });
    return;
  }
  if (targetType === "media") {
    await db.mediaAsset.updateMany({
      where: { id: targetId },
      data: { safetyStatus: "blocked", visibility: "private" },
    });
    return;
  }
  if (targetType === "feed_item") {
    const characterId = feedItemCharacterId(targetId);
    if (!characterId) {
      throw Errors.badRequest(`Cannot resolve feed_item moderation target: ${targetId}`);
    }
    await db.character.updateMany({
      where: { id: characterId },
      data: { status: "removed" },
    });
    return;
  }
  throw Errors.badRequest(`Unsupported moderation target type: ${targetType}`);
}

async function restoreAppealTarget(
  targetType: string,
  targetId: string,
  db: Prisma.TransactionClient | typeof prisma = prisma,
) {
  if (targetType === "character") {
    const result = await db.character.updateMany({
      where: { id: targetId },
      data: { status: "approved" },
    });
    return { targetRestored: result.count > 0, restoredTargetType: targetType };
  }
  if (targetType === "feed_item") {
    const characterId = feedItemCharacterId(targetId);
    if (!characterId) {
      return { targetRestored: false, restoredTargetType: targetType, restoreReason: "unresolvable_feed_item" };
    }
    const result = await db.character.updateMany({
      where: { id: characterId },
      data: { status: "approved" },
    });
    return { targetRestored: result.count > 0, restoredTargetType: targetType, restoredTargetId: characterId };
  }
  if (targetType === "media") {
    const result = await db.mediaAsset.updateMany({
      where: { id: targetId },
      data: { safetyStatus: "passed" },
    });
    return { targetRestored: result.count > 0, restoredTargetType: targetType };
  }
  if (targetType === "user_profile") {
    const result = await db.user.updateMany({
      where: { id: targetId, status: { not: "deleted" } },
      data: { status: "active" },
    });
    return { targetRestored: result.count > 0, restoredTargetType: targetType };
  }
  return { targetRestored: false, restoredTargetType: targetType, restoreReason: "manual_followup_required" };
}

// Feed item ids are encoded as `character:<id>` (see ourdream feed handlers).
function feedItemCharacterId(itemId: string) {
  const decoded = decodeURIComponent(itemId);
  return decoded.startsWith("character:") ? decoded.slice("character:".length) : null;
}

async function featureEnabled(key: string) {
  const flag = await prisma.featureFlag.findUnique({ where: { key } });
  return Boolean(flag?.enabled);
}

// SPEC: 双人审批硬门控（ADMIN_PHASE3_DESIGN §5.2）。feature flag `dual_approval_enforced`
// 开启时，高危执行端点须先存在一条 action+targetId 匹配且 status=approved 的 AdminActionRequest；
// 执行前消费它（status=consumed，一次性防重放）。flag 关闭（受控 beta 默认）→ 不强制，行为不变。
// INVARIANTS: 无凭据→403；有凭据→放行并消费；同凭据二次执行→无可用凭据→403。
export const DUAL_APPROVAL_FLAG = "dual_approval_enforced" as const;
export const LEDGER_APPROVAL_THRESHOLD = 1000;

async function enforceApproval(
  action: string,
  targetId: string,
  db: Prisma.TransactionClient | typeof prisma = prisma,
) {
  const flag = await db.featureFlag.findUnique({ where: { key: DUAL_APPROVAL_FLAG } });
  if (!flag?.enabled) return;
  const approved = await db.adminActionRequest.findFirst({
    where: { action, targetId, status: "approved" },
    orderBy: { decidedAt: "desc" },
  });
  if (!approved) {
    throw Errors.forbidden("Dual approval required: no approved request for this action", {
      action,
      targetId,
    });
  }
  // 条件消费：并发下只有一个请求能从 approved → consumed；其余视为无可用凭据。
  const consumed = await db.adminActionRequest.updateMany({
    where: { id: approved.id, status: "approved" },
    data: { status: "consumed" },
  });
  if (consumed.count !== 1) {
    throw Errors.forbidden("Dual approval required: approved request was already consumed", {
      action,
      targetId,
    });
  }
}

type ExistingGenerationJob = {
  id: string;
  userId: string;
  characterId: string | null;
  mode: string;
  prompt: string | null;
  negativePrompt: string | null;
  controls: Prisma.JsonValue;
  presetIds: Prisma.JsonValue;
  model: string | null;
  profileId?: string | null;
  profileVersion?: number | null;
  orientation: string | null;
  outputCount: number;
  seed?: string | null;
  referenceAssetIds?: Prisma.JsonValue | null;
};

export async function enqueueExistingGenerationJob(job: ExistingGenerationJob) {
  return enqueueGenerationAttempt(job);
}

export async function enqueueGenerationAttempt(
  job: ExistingGenerationJob,
  suppliedAttempt?: { readonly attemptId: string; readonly attemptNo: number },
) {
  const attempt = await prisma.$transaction(async (tx) => {
    const row = suppliedAttempt
      ? await tx.generationAttempt.findUniqueOrThrow({ where: { id: suppliedAttempt.attemptId } })
      : await tx.generationAttempt.upsert({
          where: { requestId_attemptNo: { requestId: job.id, attemptNo: 1 } },
          create: { requestId: job.id, attemptNo: 1, status: "queued" },
          update: {},
        });
    await recordGenerationAttemptQueuedEvent(tx, row);
    return row;
  });
  if (attempt.requestId !== job.id || (suppliedAttempt && attempt.attemptNo !== suppliedAttempt.attemptNo)) {
    throw Errors.conflict("Generation Attempt does not belong to the requested generation authority");
  }
  const controls = await internalExistingGenerationControls(job);
  const modelCapabilities = modelCapabilitiesFromControls(controls);
  const referenceImages =
    job.mode === "image" && (modelCapabilities.referenceImages || modelCapabilities.initImage)
      ? filterReferenceImagesForCapabilities(
          await imageReferenceInputsForGenerationJob({
            userId: job.userId,
            characterId: job.characterId,
            controls,
            referenceAssetIds: job.referenceAssetIds,
          }),
          modelCapabilities,
        )
      : [];
  const common = {
    version: 1 as const,
    requestId: `admin_requeue_${randomUUID()}`,
    generationJobId: job.id,
    attemptId: attempt.id,
    attemptNo: attempt.attemptNo,
    userId: job.userId,
    characterId: job.characterId,
    prompt: job.prompt ?? `${job.mode === "video" ? "Video" : "Image"} generation ${job.id}`,
    negativePrompt: job.negativePrompt,
    controls,
    seed: job.seed ?? job.id,
    model: job.model ?? (job.mode === "video" ? "mock-video" : "mock-image"),
    outputPrefix: `gen/${job.id}/`,
  };
  const payload: ImageGeneratePayload | VideoGeneratePayload =
    job.mode === "video"
      ? {
          ...common,
          kind: "video",
          seconds: numericControl(controls, "seconds", 4),
        }
      : {
          ...common,
          kind: "image",
          presetIds: jsonStringArray(job.presetIds),
          orientation: job.orientation ?? stringControl(controls, "orientation", "portrait"),
          count: job.outputCount,
          ...(referenceImages.length > 0 ? { referenceImages } : {}),
        };
  await jobQueue.enqueue({
    queue: job.mode === "video" ? "ai.video.generate" : "ai.image.generate",
    payload: toInputJson(payload),
    dedupeKey: suppliedAttempt
      ? `generation:${job.id}:attempt:${attempt.attemptNo}`
      : `generation:${job.id}`,
    maxAttempts: 3,
  });
}

async function internalExistingGenerationControls(job: {
  controls: Prisma.JsonValue;
  profileId?: string | null;
  profileVersion?: number | null;
}) {
  const controls = jsonRecord(job.controls);
  if (!job.profileId || !job.profileVersion) return controls;
  const profile = await prisma.generationModelProfile.findFirst({
    where: {
      version: job.profileVersion,
      OR: [{ profileKey: job.profileId }, { id: job.profileId }],
    },
  });
  if (!profile) return controls;
  return pruneUndefined({
    ...controls,
    modelCapabilities: generationModelCapabilities(profile.runner, profile.runnerConfig),
    sdcpp: profile.runner === "sd_cpp" ? sdcppProfileRuntimeConfig(profile) : undefined,
  });
}

function generationModelCapabilities(runner: string, runnerConfig: Prisma.JsonValue | null) {
  const config = jsonRecord(runnerConfig);
  return normalizedModelCapabilities(config.capabilities, runner === "sd_cpp");
}

function modelCapabilitiesFromControls(controls: Record<string, unknown>) {
  const capabilities = jsonRecord(controls.modelCapabilities);
  return {
    textToImage: booleanFromRecord(capabilities, "textToImage", true),
    stableSeed: booleanFromRecord(capabilities, "stableSeed", true),
    referenceImages: booleanFromRecord(capabilities, "referenceImages", false),
    initImage: booleanFromRecord(capabilities, "initImage", false),
    lora: booleanFromRecord(capabilities, "lora", false),
  };
}

function filterReferenceImagesForCapabilities(
  images: Awaited<ReturnType<typeof imageReferenceInputsForGenerationJob>>,
  capabilities: ReturnType<typeof modelCapabilitiesFromControls>,
) {
  return images.filter((image) => {
    if (image.role === "source_image") return capabilities.initImage;
    return capabilities.referenceImages;
  });
}

async function dreamcoinBalance(userId: string, tx: Prisma.TransactionClient | typeof prisma = prisma) {
  const aggregate = await tx.dreamcoinLedger.aggregate({
    where: { userId },
    _sum: { delta: true },
  });
  return aggregate._sum.delta ?? 0;
}

async function appendLedger(
  tx: Prisma.TransactionClient,
  userId: string,
  delta: number,
  reason: string,
  sourceId?: string,
  idempotencyKey?: string,
) {
  if (idempotencyKey) {
    const existing = await tx.dreamcoinLedger.findUnique({ where: { idempotencyKey } });
    if (existing) {
      await linkGenerationLedgerEntry(tx, existing);
      return existing;
    }
  }
  await lockUserLedger(tx, userId);
  const balance = await dreamcoinBalance(userId, tx);
  const created = await tx.dreamcoinLedger.create({
    data: {
      userId,
      delta,
      balanceAfter: balance + delta,
      reason,
      sourceId,
      idempotencyKey,
    },
  });
  await linkGenerationLedgerEntry(tx, created);
  return created;
}

async function lockUserLedger(tx: Prisma.TransactionClient, userId: string) {
  await tx.$queryRaw`SELECT id FROM "users" WHERE id = ${userId} FOR UPDATE`;
}

export async function jsonBody(request: Request): Promise<unknown> {
  if (request.method === "GET" || request.method === "DELETE") return {};
  const text = await request.text();
  if (!text) return {};
  return JSON.parse(text) as unknown;
}

export function toInputJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function jsonStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function definedPatchKeys(value: object) {
  return Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .map(([key]) => key);
}

function plaintextAllowedByConsent(
  plaintext: PlaintextFields,
  scope: Prisma.JsonValue | undefined,
) {
  const fields = consentScopeFields(scope);
  const output: PlaintextFields = {};
  for (const [field, value] of Object.entries(plaintext)) {
    if (fields.has(field)) output[field] = value;
  }
  return output;
}

function consentScopeFields(scope: Prisma.JsonValue | undefined) {
  if (!isRecord(scope)) return new Set<string>();
  const fields = scope.fields;
  if (!Array.isArray(fields)) return new Set<string>();
  return new Set(fields.filter((field): field is string => typeof field === "string"));
}

function stringControl(
  controls: Record<string, unknown>,
  key: string,
  fallback: string,
) {
  const value = controls[key];
  return typeof value === "string" && value.trim() ? value : fallback;
}

function numericControl(
  controls: Record<string, unknown>,
  key: string,
  fallback: number,
) {
  const value = controls[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return value;
}

export function clampInt(value: string | null, min: number, max: number, fallback: number) {
  const parsed = value ? Number.parseInt(value, 10) : fallback;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function stripSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSensitive);
  if (!isRecord(value)) return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (["prompt", "negativePrompt", "body", "password", "token", "secret"].includes(key)) {
      output[key] = "[redacted]";
    } else {
      output[key] = stripSensitive(child);
    }
  }
  return output;
}

function hashHeader(value: string | null) {
  if (!value) return undefined;
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function isHardPolicyFlag(key: string) {
  const normalized = key.toLowerCase();
  const compact = normalized.replace(/[^a-z0-9]/g, "");
  return (
    normalized.includes("hard_policy") ||
    compact.includes("hardpolicy") ||
    normalized.includes("age_gate") ||
    compact.includes("agegate") ||
    normalized.includes("underage") ||
    normalized.includes("minor_safety") ||
    compact.includes("minorsafety")
  );
}
