import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import type { ImageGeneratePayload, VideoGeneratePayload } from "@/server/ai/schemas";
import { jobQueue } from "@/server/jobs/queue";
import { assertPermission, type PermissionKey } from "@/server/admin/permissions";
import { getAuthCtx, requireUser, type ActorRole } from "@/server/lib/auth";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";

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

const requeueSchema = z.object({
  reason: z.string().trim().max(2_000).optional(),
  confirmation: z.union([z.boolean(), z.string()]).optional(),
});

const discardSchema = z.object({
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

const plaintextViewSchema = z.object({
  targetType: z.enum(["generation_job", "media"]),
  targetId: z.string().trim().min(1).max(160),
  ticketId: z.string().trim().max(160).optional(),
  legalHoldId: z.string().trim().max(160).optional(),
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
  }

  if (resource === "moderation") {
    if (id === "queue" && !action && method === "GET") return moderationQueue(request);
    if (id && action === "decision" && method === "POST") {
      return moderationDecision(request, id);
    }
  }

  if (resource === "billing") {
    if (id === "ledger" && !action && method === "GET") return billingLedger(request);
    if (id === "adjustments" && !action && method === "POST") {
      return billingAdjustment(request);
    }
  }

  if (resource === "feature-flags") {
    if (!id && method === "GET") return listFeatureFlags(request);
    if (id && !action && method === "PATCH") return patchFeatureFlag(request, id);
  }

  if (resource === "audit-log" && !id && method === "GET") return auditLog(request);

  if (resource === "support" && id === "plaintext" && action === "view" && method === "POST") {
    return viewPlaintext(request);
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

async function actorWithPermission(request: Request, permission: PermissionKey): Promise<AdminActor> {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  assertPermission(user.role, permission);
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
