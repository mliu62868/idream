import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import type { ImageGeneratePayload, VideoGeneratePayload } from "@/server/ai/schemas";
import { jobQueue } from "@/server/jobs/queue";
import {
  applyOverrides,
  isPermissionKey,
  resolvePermissions,
  type PermissionKey,
} from "@/server/admin/permissions";
import { effectivePermissions } from "@/server/admin/effective-permissions";
import { getAuthCtx, requireUser, type ActorRole } from "@/server/lib/auth";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";

const FEATURED_SETTING_KEY = "feed.featured";

type ApiMethod = "GET" | "POST" | "PATCH" | "DELETE" | "PUT";
type AdminActor = { id: string; role: ActorRole };
type PlaintextFields = Record<string, string | null>;

const adminDecisionSchema = z.object({
  decision: z.enum(["actioned", "no_violation", "duplicate", "escalated", "closed"]),
  policyCode: z.string().max(120).optional(),
  notes: z.string().max(2_000).optional(),
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
  confirmation: z.union([z.boolean(), z.string()]).optional(),
});

const discardSchema = z.object({
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

const deadLetterBatchSchema = z.object({
  jobIds: z.array(z.string().trim().min(1).max(160)).min(1).max(100),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
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
  sourceModelPath: z.string().trim().max(500).nullable().optional(),
  convertedModelPath: z.string().trim().max(500).nullable().optional(),
  modelFormat: z.enum(["safetensors", "gguf", "diffusers", "external"]).default("safetensors"),
  runnerConfig: z.record(z.string(), z.unknown()).optional(),
  defaultWidth: z.number().int().min(128).max(4096).default(768),
  defaultHeight: z.number().int().min(128).max(4096).default(1024),
  allowedOrientations: z.array(z.string().trim().min(1).max(20)).min(1).max(12),
  steps: z.number().int().min(1).max(150).default(28),
  sampler: z.string().trim().min(1).max(80).default("dpmpp_2m"),
  cfgScale: z.number().min(1).max(30).default(7),
  negativeTemplateId: z.string().trim().max(160).optional(),
  costMultiplier: z.number().min(0.1).max(20).default(1),
  requiredEntitlement: z.string().trim().max(120).nullable().optional(),
  maxCount: z.number().int().min(1).max(8).default(4),
  concurrencyLimit: z.number().int().min(1).max(100).default(1),
  enabled: z.boolean().default(true),
  rolloutPercent: z.number().int().min(0).max(100).default(100),
  dryRunSummary: z.record(z.string(), z.unknown()).optional(),
});

const modelProfilePatchSchema = z.object({
  profileKey: z.string().trim().min(1).max(120).optional(),
  label: z.string().trim().min(1).max(120).optional(),
  mode: z.enum(["image", "video"]).optional(),
  runner: z.enum(["pipeline", "sd_cpp", "mlx", "comfyui", "external"]).optional(),
  pipelineModel: z.string().trim().min(1).max(160).optional(),
  sourceModelPath: z.string().trim().max(500).nullable().optional(),
  convertedModelPath: z.string().trim().max(500).nullable().optional(),
  modelFormat: z.enum(["safetensors", "gguf", "diffusers", "external"]).optional(),
  runnerConfig: z.record(z.string(), z.unknown()).optional(),
  defaultWidth: z.number().int().min(128).max(4096).optional(),
  defaultHeight: z.number().int().min(128).max(4096).optional(),
  allowedOrientations: z.array(z.string().trim().min(1).max(20)).min(1).max(12).optional(),
  steps: z.number().int().min(1).max(150).optional(),
  sampler: z.string().trim().min(1).max(80).optional(),
  cfgScale: z.number().min(1).max(30).optional(),
  negativeTemplateId: z.string().trim().max(160).optional(),
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

const promptTemplateSchema = z.object({
  templateKey: z.string().trim().min(1).max(120),
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

const promptTemplatePatchSchema = promptTemplateSchema.partial();

const publishSchema = z.object({
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.literal("PUBLISH"),
  dryRunSummary: z.record(z.string(), z.unknown()).optional(),
});

const rollbackSchema = z.object({
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.literal("ROLLBACK"),
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
  mode: z.enum(["image", "video"]).default("image"),
  baseCost: z.number().int().min(0).max(100_000),
  multiplier: z.number().min(0.1).max(20).default(1),
  effectiveFrom: z.string().datetime().optional(),
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
  confirmation: z.literal("PUBLISH"),
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
  const [resource, id, action, child] = segments;

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
    if (id === "prompt-templates") {
      if (!action && method === "GET") return listPromptTemplates(request);
      if (!action && method === "POST") return createPromptTemplate(request);
      if (action && !child && method === "PATCH") return patchPromptTemplate(request, action);
      if (action && child === "publish" && method === "POST") {
        return publishPromptTemplate(request, action);
      }
      if (action && child === "rollback" && method === "POST") {
        return rollbackPromptTemplate(request, action);
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
  }
  if (resource === "content" && id === "featured") {
    if (!action && method === "GET") return getFeaturedCharacters(request);
    if (!action && method === "PUT") return putFeaturedCharacters(request);
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
    if (id === "sessions" && !action && method === "GET") return chatOpsSessions(request);
    if (id === "moderation-events" && !action && method === "GET") {
      return chatOpsModerationEvents(request);
    }
  }

  throw Errors.notFound("Admin API route not found", { path: `/admin/${segments.join("/")}` });
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
  if (body.confirmation !== userId && body.confirmation !== body.status.toUpperCase()) {
    throw Errors.badRequest("Confirmation did not match target user or status");
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

async function updateUserRole(request: Request, userId: string) {
  const actor = await actorWithPermission(request, "user.role.write");
  const body = roleChangeSchema.parse(await jsonBody(request));
  if (body.confirmation !== userId && body.confirmation !== "ROLE") {
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
  if (body.confirmation !== userId && body.confirmation !== "PERMISSION") {
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
    timeline: [
      ...job.events.map((event) => ({
        at: event.createdAt,
        type: event.type,
        message: event.message,
        metadata: event.metadata,
      })),
      ...moderationEvents.map((event) => ({
        at: event.createdAt,
        type: `moderation.${event.layer}`,
        status: event.status,
        policyCode: event.policyCode,
      })),
      ...ledger.map((entry) => ({
        at: entry.createdAt,
        type: `ledger.${entry.reason}`,
        delta: entry.delta,
        balanceAfter: entry.balanceAfter,
      })),
      ...(job.completedAt ? [{ at: job.completedAt, type: "job.completed", status: job.status }] : []),
    ],
  });
}

async function requeueGenerationJob(request: Request, jobId: string) {
  const actor = await actorWithPermission(request, "generation.job.requeue");
  const body = requeueSchema.parse(await jsonBody(request));
  if (body.confirmation !== true && body.confirmation !== jobId && body.confirmation !== "REQUEUE") {
    throw Errors.badRequest("Confirmation did not match requeue target");
  }
  const job = await prisma.generationJob.findUnique({ where: { id: jobId } });
  if (!job) throw Errors.notFound("Generation job not found");
  if (job.status !== "failed") {
    throw Errors.badRequest("Only failed jobs can be requeued");
  }
  const refunded = await prisma.dreamcoinLedger.findFirst({
    where: { sourceId: job.id, reason: "refund" },
  });
  if (refunded) {
    throw Errors.conflict("Refunded jobs require a new paid generation request");
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
  if (body.confirmation !== jobId && body.confirmation !== "DISCARD") {
    throw Errors.badRequest("Confirmation did not match discard target");
  }
  const job = await prisma.generationJob.findUnique({ where: { id: jobId } });
  if (!job) throw Errors.notFound("Generation job not found");
  if (!["failed", "blocked", "refunded"].includes(job.status)) {
    throw Errors.badRequest("Only failed, blocked, or refunded jobs can be discarded");
  }
  const alreadyRefunded = await prisma.dreamcoinLedger.findFirst({
    where: { sourceId: job.id, reason: "refund" },
  });
  await prisma.$transaction(async (tx) => {
    if (!alreadyRefunded && job.costDreamcoins > 0) {
      await appendLedger(tx, job.userId, job.costDreamcoins, "refund", job.id);
    }
    await tx.generationJob.update({
      where: { id: job.id },
      data: { status: "refunded", errorCode: job.errorCode ?? "discarded" },
    });
  });
  await writeAudit(request, actor, {
    action: "ops.deadletter.discard",
    targetType: "generation_job",
    targetId: job.id,
    reason: body.reason,
    before: { status: job.status, errorCode: job.errorCode },
    after: { status: "refunded", refunded: !alreadyRefunded },
  });
  return ok({ discarded: true, refunded: !alreadyRefunded });
}

// SPEC: Dead-letter 运营台 —— 列出重试耗尽/不可恢复（failed|blocked）的 job，支持单/批 requeue 与 discard。
// INTENT: requeue/discard 单条 API 已存在且测试覆盖；本节只新增「列表（带退款状态）+ 批量」前端运营所需后端，
//         不改动单条 handler（零回归）。批量记一条审计 + 子项列表（§12）。
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
    orderBy: { updatedAt: "desc" },
    take: clampInt(url.searchParams.get("limit"), 1, 200, 100),
  });
  const refundedIds = await refundedJobIds(jobs.map((job) => job.id));
  return ok({
    items: jobs.map((job) => ({
      ...redactJob(job),
      ledgerState: refundedIds.has(job.id) ? "refunded" : "reserved",
    })),
  });
}

async function requeueDeadLetterBatch(request: Request) {
  const actor = await actorWithPermission(request, "generation.job.requeue");
  const body = deadLetterBatchSchema.parse(await jsonBody(request));
  if (body.confirmation !== "REQUEUE") {
    throw Errors.badRequest("Batch requeue requires REQUEUE confirmation");
  }
  const jobs = await prisma.generationJob.findMany({ where: { id: { in: body.jobIds } } });
  const refundedIds = await refundedJobIds(body.jobIds);
  const requeued: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const job of jobs) {
    if (job.status !== "failed") {
      skipped.push({ id: job.id, reason: "not_failed" });
      continue;
    }
    if (refundedIds.has(job.id)) {
      skipped.push({ id: job.id, reason: "refunded" });
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
  if (body.confirmation !== "DISCARD") {
    throw Errors.badRequest("Batch discard requires DISCARD confirmation");
  }
  const jobs = await prisma.generationJob.findMany({ where: { id: { in: body.jobIds } } });
  const refundedIds = await refundedJobIds(body.jobIds);
  const discarded: string[] = [];
  const refundedNow: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const job of jobs) {
    if (!["failed", "blocked", "refunded"].includes(job.status)) {
      skipped.push({ id: job.id, reason: "not_discardable" });
      continue;
    }
    const willRefund = !refundedIds.has(job.id) && job.costDreamcoins > 0;
    await prisma.$transaction(async (tx) => {
      if (willRefund) await appendLedger(tx, job.userId, job.costDreamcoins, "refund", job.id);
      await tx.generationJob.update({
        where: { id: job.id },
        data: { status: "refunded", errorCode: job.errorCode ?? "discarded" },
      });
    });
    discarded.push(job.id);
    if (willRefund) refundedNow.push(job.id);
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

async function createModelProfile(request: Request) {
  const actor = await actorWithPermission(request, "generation.config.write");
  const body = modelProfileSchema.parse(await jsonBody(request));
  const latest = await prisma.generationModelProfile.findFirst({
    where: { profileKey: body.profileKey },
    orderBy: { version: "desc" },
  });
  const profile = await prisma.generationModelProfile.create({
    data: {
      ...body,
      requiredEntitlement: body.requiredEntitlement ?? null,
      sourceModelPath: body.sourceModelPath ?? null,
      convertedModelPath: body.convertedModelPath ?? null,
      allowedOrientations: toInputJson(body.allowedOrientations),
      runnerConfig: body.runnerConfig ? toInputJson(body.runnerConfig) : undefined,
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
  const actor = await actorWithPermission(request, "generation.config.write");
  const body = modelProfilePatchSchema.parse(await jsonBody(request));
  const before = await prisma.generationModelProfile.findUnique({ where: { id } });
  if (!before) throw Errors.notFound("Model profile not found");
  if (before.status !== "draft") {
    const forbiddenKeys = definedPatchKeys(body).filter(
      (key) => !["enabled", "reason", "confirmation"].includes(key),
    );
    if (body.enabled !== false || forbiddenKeys.length > 0) {
      throw Errors.badRequest("Only draft profiles can be edited; active profiles may only be disabled");
    }
  }
  if (body.enabled === false && before.enabled) {
    if (!body.reason || body.confirmation !== "DISABLE") {
      throw Errors.badRequest("Disabling a profile requires reason and DISABLE confirmation");
    }
  }

  const updated = await prisma.generationModelProfile.update({
    where: { id },
    data: {
      profileKey: body.profileKey,
      label: body.label,
      mode: body.mode,
      runner: body.runner,
      pipelineModel: body.pipelineModel,
      sourceModelPath: body.sourceModelPath === undefined ? undefined : body.sourceModelPath,
      convertedModelPath:
        body.convertedModelPath === undefined ? undefined : body.convertedModelPath,
      modelFormat: body.modelFormat,
      runnerConfig: body.runnerConfig ? toInputJson(body.runnerConfig) : undefined,
      defaultWidth: body.defaultWidth,
      defaultHeight: body.defaultHeight,
      allowedOrientations: body.allowedOrientations
        ? toInputJson(body.allowedOrientations)
        : undefined,
      steps: body.steps,
      sampler: body.sampler,
      cfgScale: body.cfgScale,
      negativeTemplateId: body.negativeTemplateId,
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

async function publishModelProfile(request: Request, id: string) {
  const actor = await actorWithPermission(request, "generation.config.write");
  const body = publishSchema.parse(await jsonBody(request));
  const profile = await prisma.generationModelProfile.findUnique({ where: { id } });
  if (!profile) throw Errors.notFound("Model profile not found");
  if (profile.status !== "draft") throw Errors.badRequest("Only draft profiles can be published");
  if (profile.mode === "video" && !(await featureEnabled("video_gen"))) {
    throw Errors.forbidden("Video generation is disabled by feature flag");
  }

  const dryRunSummary = body.dryRunSummary
    ? toInputJson(body.dryRunSummary)
    : profile.dryRunSummary;
  if (!dryRunSummary) throw Errors.badRequest("Publish requires dry-run summary");

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
      data: { status: "active", dryRunSummary, publishedAt: new Date(), archivedAt: null },
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

async function rollbackModelProfile(request: Request, id: string) {
  const actor = await actorWithPermission(request, "generation.config.write");
  const body = rollbackSchema.parse(await jsonBody(request));
  const current = await prisma.generationModelProfile.findUnique({ where: { id } });
  if (!current) throw Errors.notFound("Model profile not found");
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

async function listPromptTemplates(request: Request) {
  await actorWithPermission(request, "generation.config.read");
  const url = new URL(request.url);
  const mode = url.searchParams.get("mode") ?? undefined;
  const templates = await prisma.generationPromptTemplate.findMany({
    where: { mode },
    orderBy: [{ templateKey: "asc" }, { version: "desc" }],
  });
  return ok({ items: templates });
}

async function createPromptTemplate(request: Request) {
  const actor = await actorWithPermission(request, "generation.config.write");
  const body = promptTemplateSchema.parse(await jsonBody(request));
  const latest = await prisma.generationPromptTemplate.findFirst({
    where: { templateKey: body.templateKey },
    orderBy: { version: "desc" },
  });
  const template = await prisma.generationPromptTemplate.create({
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
    after: templateAuditSnapshot(template),
  });
  return ok({ template });
}

async function patchPromptTemplate(request: Request, id: string) {
  const actor = await actorWithPermission(request, "generation.config.write");
  const body = promptTemplatePatchSchema.parse(await jsonBody(request));
  const before = await prisma.generationPromptTemplate.findUnique({ where: { id } });
  if (!before) throw Errors.notFound("Prompt template not found");
  if (before.status !== "draft") throw Errors.badRequest("Only draft templates can be edited");
  const updated = await prisma.generationPromptTemplate.update({
    where: { id },
    data: {
      templateKey: body.templateKey,
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
    before: templateAuditSnapshot(before),
    after: templateAuditSnapshot(updated),
  });
  return ok({ template: updated });
}

async function publishPromptTemplate(request: Request, id: string) {
  const actor = await actorWithPermission(request, "generation.config.write");
  const body = publishSchema.parse(await jsonBody(request));
  const template = await prisma.generationPromptTemplate.findUnique({ where: { id } });
  if (!template) throw Errors.notFound("Prompt template not found");
  if (template.status !== "draft") throw Errors.badRequest("Only draft templates can be published");
  const dryRunSummary = body.dryRunSummary
    ? toInputJson(body.dryRunSummary)
    : template.dryRunSummary;
  if (!dryRunSummary) throw Errors.badRequest("Publish requires dry-run summary");
  const previous = await prisma.generationPromptTemplate.findFirst({
    where: { templateKey: template.templateKey, status: "active" },
  });
  const published = await prisma.$transaction(async (tx) => {
    await tx.generationPromptTemplate.updateMany({
      where: { templateKey: template.templateKey, status: "active" },
      data: { status: "archived", archivedAt: new Date() },
    });
    return tx.generationPromptTemplate.update({
      where: { id },
      data: { status: "active", dryRunSummary, publishedAt: new Date(), archivedAt: null },
    });
  });
  await writeAudit(request, actor, {
    action: "generation.prompt_template.publish",
    targetType: "generation_prompt_template",
    targetId: id,
    reason: body.reason,
    before: previous ? templateAuditSnapshot(previous) : null,
    after: templateAuditSnapshot(published),
  });
  return ok({ template: published, previousActiveId: previous?.id ?? null });
}

async function rollbackPromptTemplate(request: Request, id: string) {
  const actor = await actorWithPermission(request, "generation.config.write");
  const body = rollbackSchema.parse(await jsonBody(request));
  const current = await prisma.generationPromptTemplate.findUnique({ where: { id } });
  if (!current) throw Errors.notFound("Prompt template not found");
  const previous = await prisma.generationPromptTemplate.findFirst({
    where: {
      templateKey: current.templateKey,
      status: "archived",
      version: { lt: current.version },
    },
    orderBy: { version: "desc" },
  });
  if (!previous) throw Errors.notFound("No previous template version to roll back to");
  const restored = await prisma.$transaction(async (tx) => {
    await tx.generationPromptTemplate.updateMany({
      where: { templateKey: current.templateKey, status: "active" },
      data: { status: "archived", archivedAt: new Date() },
    });
    return tx.generationPromptTemplate.update({
      where: { id: previous.id },
      data: { status: "active", publishedAt: new Date(), archivedAt: null },
    });
  });
  await writeAudit(request, actor, {
    action: "generation.prompt_template.rollback",
    targetType: "generation_prompt_template",
    targetId: current.id,
    reason: body.reason,
    before: templateAuditSnapshot(current),
    after: templateAuditSnapshot(restored),
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
  const rule = await prisma.pricingRule.findUnique({ where: { id } });
  if (!rule) throw Errors.notFound("Pricing rule not found");
  if (rule.status !== "draft") throw Errors.badRequest("Only draft pricing rules can be published");
  // 同 mode 旧 active 全部归档，保证 generationCost 读到的 active 唯一（资金侧 SSoT）。
  const previous = await prisma.pricingRule.findFirst({
    where: { mode: rule.mode, status: "active" },
  });
  const effectiveFrom = body.effectiveFrom
    ? new Date(body.effectiveFrom)
    : (rule.effectiveFrom ?? new Date());
  const published = await prisma.$transaction(async (tx) => {
    await tx.pricingRule.updateMany({
      where: { mode: rule.mode, status: "active" },
      data: { status: "archived", archivedAt: new Date() },
    });
    return tx.pricingRule.update({
      where: { id },
      data: { status: "active", effectiveFrom, publishedAt: new Date(), archivedAt: null },
    });
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
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
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
  const review = await prisma.moderationReview.create({
    data: {
      reportId,
      reviewerId: actor.id,
      decision: body.decision,
      policyCode: body.policyCode,
      notes: body.notes,
    },
  });
  const updated = await prisma.contentReport.update({
    where: { id: reportId },
    data: { status: body.decision },
  });
  if (body.decision === "actioned") {
    await applyModerationAction(report.targetType, report.targetId);
  }
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
  if (body.confirmation !== body.userId && body.confirmation !== "ADJUST") {
    throw Errors.badRequest("Confirmation did not match ledger adjustment target");
  }
  const user = await prisma.user.findUnique({ where: { id: body.userId } });
  if (!user) throw Errors.notFound("User not found");
  const entry = await prisma.$transaction((tx) =>
    appendLedger(tx, body.userId, body.delta, "admin_adjust", body.sourceId ?? randomUUID()),
  );
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
  if (body.confirmation !== key && body.confirmation !== "FLAG") {
    throw Errors.badRequest("Confirmation did not match feature flag key");
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

// SPEC: Analytics/BI 概览 —— 漏斗（注册→激活→付费）、生成状态、币经济、Top 事件，按时间窗只读聚合。
// INTENT: 接通早已存在但无 endpoint 的 analytics.export 权限（admin+analyst）；给增长决策一个脱敏聚合看板。
// INVARIANTS: 只读不写；漏斗为窗口内活动口径（非严格 cohort），数与底层表一致；默认窗口最近 30 天。
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
    funnel: { signups, activatedUsers, payingUsers, conversionRate },
    generation: {
      total: generationTotal,
      completed: statusCount("completed"),
      failed: statusCount("failed"),
      blocked: statusCount("blocked"),
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

async function viewPlaintext(request: Request) {
  const actor = await actorWithPermission(request, "support.plaintext.view");
  const body = plaintextViewSchema.parse(await jsonBody(request));
  if (body.confirmation !== body.targetId && body.confirmation !== "VIEW") {
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
  return ok({ character, reports, recentJobs });
}

async function setCharacterVisibility(request: Request, id: string) {
  const actor = await actorWithPermission(request, "content.takedown.write");
  const body = contentVisibilitySchema.parse(await jsonBody(request));
  if (body.confirmation !== id && body.confirmation !== "VISIBILITY") {
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

async function setCharacterStatus(request: Request, id: string) {
  const actor = await actorWithPermission(request, "content.takedown.write");
  const body = contentStatusSchema.parse(await jsonBody(request));
  if (body.confirmation !== id && body.confirmation !== "STATUS") {
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
  if (body.confirmation !== "FEATURED") {
    throw Errors.badRequest("Confirmation did not match featured target");
  }
  const unique = [...new Set(body.characterIds)];
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
  if (body.confirmation !== "CREATE" && body.confirmation !== body.code) {
    throw Errors.badRequest("Confirmation did not match");
  }
  const codeHash = createHash("sha256").update(body.code).digest("hex");
  const existing = await prisma.redeemCode.findUnique({ where: { codeHash } });
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
  if (body.confirmation !== id && body.confirmation !== "DISABLE") {
    throw Errors.badRequest("Confirmation did not match disable target");
  }
  const before = await prisma.redeemCode.findUnique({ where: { id } });
  if (!before) throw Errors.notFound("Redeem code not found");
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

async function approveApproval(request: Request, id: string) {
  const actor = await actorWithPermission(request, "admin.approval.review");
  const body = approvalDecisionSchema.parse(await jsonBody(request));
  const req = await prisma.adminActionRequest.findUnique({ where: { id } });
  if (!req) throw Errors.notFound("Approval request not found");
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
async function proxyChatAdmin(path: string): Promise<unknown | null> {
  if (!env.CHAT_SERVICE_URL) return null;
  try {
    const res = await fetch(`${env.CHAT_SERVICE_URL}${path}`, {
      headers: { "x-internal-token": env.INTERNAL_TOKEN },
    });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    // 故意降级：chat 服务暂不可达不应让 admin 控制台整体 500。
    return null;
  }
}

async function chatOpsOverview(request: Request) {
  await actorWithPermission(request, "chat.ops.read");
  const data = await proxyChatAdmin("/internal/admin/overview");
  return ok({ configured: data !== null, overview: data });
}

async function chatOpsSessions(request: Request) {
  await actorWithPermission(request, "chat.ops.read");
  const url = new URL(request.url);
  const params = new URLSearchParams();
  const userId = url.searchParams.get("userId");
  if (userId) params.set("userId", userId);
  params.set("limit", String(clampInt(url.searchParams.get("limit"), 1, 100, 50)));
  const data = await proxyChatAdmin(`/internal/admin/sessions?${params.toString()}`);
  return ok({ configured: data !== null, ...(isRecord(data) ? data : { items: [] }) });
}

async function chatOpsModerationEvents(request: Request) {
  await actorWithPermission(request, "chat.ops.read");
  const url = new URL(request.url);
  const limit = clampInt(url.searchParams.get("limit"), 1, 100, 50);
  const data = await proxyChatAdmin(`/internal/admin/moderation-events?limit=${limit}`);
  return ok({ configured: data !== null, ...(isRecord(data) ? data : { items: [] }) });
}

async function actorWithPermission(request: Request, permission: PermissionKey): Promise<AdminActor> {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  const effective = await effectivePermissions(user.id, user.role);
  if (!effective.has(permission)) {
    throw Errors.forbidden("Missing admin permission", { permission });
  }
  return { id: user.id, role: user.role };
}

async function writeAudit(
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
  promptTemplateId: string | null;
  promptTemplateVersion: number | null;
  orientation: string | null;
  outputCount: number;
  status: string;
  costDreamcoins: number;
  provider: string | null;
  errorCode: string | null;
  createdAt: Date;
  updatedAt?: Date;
  completedAt: Date | null;
}) {
  return {
    id: job.id,
    userId: job.userId,
    derivedFromJobId: job.derivedFromJobId ?? null,
    mode: job.mode,
    model: job.model,
    profileId: job.profileId,
    profileVersion: job.profileVersion,
    promptTemplateId: job.promptTemplateId,
    promptTemplateVersion: job.promptTemplateVersion,
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
  };
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
    costMultiplier: profile.costMultiplier,
    requiredEntitlement: profile.requiredEntitlement,
    enabled: profile.enabled,
    rolloutPercent: profile.rolloutPercent,
    version: profile.version,
    status: profile.status,
  };
}

function templateAuditSnapshot(template: {
  templateKey: string;
  mode: string;
  useCase: string;
  version: number;
  status: string;
}) {
  return {
    templateKey: template.templateKey,
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

async function applyModerationAction(targetType: string, targetId: string) {
  if (targetType === "character") {
    await prisma.character.updateMany({
      where: { id: targetId },
      data: { status: "removed" },
    });
  }
  if (targetType === "media") {
    await prisma.mediaAsset.updateMany({
      where: { id: targetId },
      data: { safetyStatus: "blocked", visibility: "private" },
    });
  }
}

async function featureEnabled(key: string) {
  const flag = await prisma.featureFlag.findUnique({ where: { key } });
  return Boolean(flag?.enabled);
}

async function enqueueExistingGenerationJob(job: {
  id: string;
  userId: string;
  characterId: string | null;
  mode: string;
  prompt: string | null;
  negativePrompt: string | null;
  controls: Prisma.JsonValue;
  presetIds: Prisma.JsonValue;
  model: string | null;
  orientation: string | null;
  outputCount: number;
}) {
  const controls = jsonRecord(job.controls);
  const common = {
    version: 1 as const,
    requestId: `admin_requeue_${randomUUID()}`,
    generationJobId: job.id,
    userId: job.userId,
    characterId: job.characterId,
    prompt: job.prompt ?? `${job.mode === "video" ? "Video" : "Image"} generation ${job.id}`,
    negativePrompt: job.negativePrompt,
    controls,
    seed: job.id,
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
        };
  await jobQueue.enqueue({
    queue: job.mode === "video" ? "ai.video.generate" : "ai.image.generate",
    payload: toInputJson(payload),
    dedupeKey: `generation:${job.id}`,
    maxAttempts: 3,
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
) {
  const balance = await dreamcoinBalance(userId, tx);
  return tx.dreamcoinLedger.create({
    data: {
      userId,
      delta,
      balanceAfter: balance + delta,
      reason,
      sourceId,
    },
  });
}

async function jsonBody(request: Request): Promise<unknown> {
  if (request.method === "GET" || request.method === "DELETE") return {};
  const text = await request.text();
  if (!text) return {};
  return JSON.parse(text) as unknown;
}

function toInputJson(value: unknown): Prisma.InputJsonValue {
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

function clampInt(value: string | null, min: number, max: number, fallback: number) {
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
