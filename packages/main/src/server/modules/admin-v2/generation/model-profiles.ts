// SPEC: the Generation model-profile authority — the catalogue an operator reads, and the
//       draft → active → archived lifecycle they drive (create, edit, publish, roll back).
// INTENT: migrated from the v1 `generation/model-profiles` dispatcher branch. The publish
//         admissibility rules came over verbatim: they are the only thing standing between a
//         half-verified checkpoint and live traffic, so this migration does not relax them.
// INVARIANT: `ADMIN_MODEL_DIAGNOSTICS_ENABLED` gates authoring (create / edit) but never the
//            emergency disable patch — turning a misbehaving profile off must not depend on a
//            diagnostics flag. The gate is asserted after authentication so an unauthenticated
//            caller still gets 401 rather than a 404 that leaks the flag state.
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { workflowKeyExists } from "@/server/modules/generation/generation-catalog";
import {
  actorWithPermission,
  jsonBody,
  queryParams,
  type AdminActor,
} from "@/server/modules/admin-v2/shared/authority";
import { executeAtomicIdempotentMutation } from "@/server/modules/admin-v2/shared/atomic-mutation";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";
import {
  decodeAdminListCursor,
  encodeAdminListCursor,
} from "@/server/modules/admin-v2/shared/list-cursor";
import { jsonRecord, jsonStrings, toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";

/** SPEC: the request id every Admin authority stamps onto its audit rows. */
export function adminRequestId(request: Request) {
  return request.headers.get("x-request-id")?.trim() || crypto.randomUUID();
}

export function modelDiagnosticsEnabled() {
  return process.env.ADMIN_MODEL_DIAGNOSTICS_ENABLED === "true";
}

export function assertModelDiagnosticsEnabled() {
  if (!modelDiagnosticsEnabled()) throw Errors.notFound("Admin API route not found");
}

const imageProfilePublishMinSamples = 20;
const modelProfilePublishMinRate = 0.8;

const profileSelect = {
  id: true,
  profileKey: true,
  label: true,
  mode: true,
  runner: true,
  pipelineModel: true,
  workflowKey: true,
  sourceModelPath: true,
  convertedModelPath: true,
  modelFormat: true,
  runnerConfig: true,
  defaultWidth: true,
  defaultHeight: true,
  allowedOrientations: true,
  steps: true,
  sampler: true,
  scheduler: true,
  cfgScale: true,
  costMultiplier: true,
  requiredEntitlement: true,
  maxCount: true,
  concurrencyLimit: true,
  enabled: true,
  rolloutPercent: true,
  version: true,
  status: true,
  dryRunSummary: true,
  publishedAt: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.GenerationModelProfileSelect;

type ProfileRow = Prisma.GenerationModelProfileGetPayload<{ select: typeof profileSelect }>;

export function modelProfileView(profile: ProfileRow) {
  return {
    id: profile.id,
    profileKey: profile.profileKey,
    label: profile.label,
    mode: profile.mode,
    runner: profile.runner,
    pipelineModel: profile.pipelineModel,
    workflowKey: profile.workflowKey,
    sourceModelPath: profile.sourceModelPath,
    convertedModelPath: profile.convertedModelPath,
    modelFormat: profile.modelFormat,
    runnerConfig: profile.runnerConfig ?? null,
    defaultWidth: profile.defaultWidth,
    defaultHeight: profile.defaultHeight,
    allowedOrientations: jsonStrings(profile.allowedOrientations),
    steps: profile.steps,
    sampler: profile.sampler,
    scheduler: profile.scheduler,
    cfgScale: profile.cfgScale,
    costMultiplier: profile.costMultiplier,
    requiredEntitlement: profile.requiredEntitlement,
    maxCount: profile.maxCount,
    concurrencyLimit: profile.concurrencyLimit,
    enabled: profile.enabled,
    rolloutPercent: profile.rolloutPercent,
    version: profile.version,
    status: profile.status,
    dryRunSummary: profile.dryRunSummary ?? null,
    publishedAt: profile.publishedAt?.toISOString() ?? null,
    archivedAt: profile.archivedAt?.toISOString() ?? null,
    createdAt: profile.createdAt.toISOString(),
    updatedAt: profile.updatedAt.toISOString(),
  };
}

export async function listGenerationModelProfiles(request: Request) {
  await actorWithPermission(request, "generation.config.read");
  const query = queryParams(request, "GET /api/v2/admin/generation/model-profiles");
  const queryIdentity = { search: query.search, mode: query.mode, status: query.status };
  const limit = query.limit ?? null;
  const cursorKeys = query.cursor
    ? decodeAdminListCursor(query.cursor, "generation_profiles", queryIdentity)
    : undefined;
  const cursorWhere: Prisma.GenerationModelProfileWhereInput | undefined = cursorKeys
    ? (() => {
        const profileKey = cursorString(cursorKeys, 0);
        const version = cursorNumber(cursorKeys, 1);
        const id = cursorString(cursorKeys, 2);
        return {
          OR: [
            { profileKey: { gt: profileKey } },
            { profileKey, version: { lt: version } },
            { profileKey, version, id: { gt: id } },
          ],
        };
      })()
    : undefined;
  const profiles = await prisma.generationModelProfile.findMany({
    where: {
      mode: query.mode,
      status: query.status,
      OR: query.search
        ? [
            { id: { contains: query.search } },
            { profileKey: { contains: query.search } },
            { label: { contains: query.search } },
          ]
        : undefined,
      AND: cursorWhere,
    },
    orderBy: [{ profileKey: "asc" }, { version: "desc" }, { id: "asc" }],
    take: limit === null ? undefined : limit + 1,
    select: profileSelect,
  });
  const page = limit === null ? profiles : profiles.slice(0, limit);
  const last = page.at(-1);
  const hasNextPage = limit !== null && profiles.length > limit;
  return {
    items: page.map(modelProfileView),
    pageInfo: {
      endCursor: hasNextPage && last
        ? encodeAdminListCursor("generation_profiles", queryIdentity, [
            last.profileKey,
            last.version,
            last.id,
          ])
        : null,
      hasNextPage,
    },
    asOf: new Date().toISOString(),
    freshness: "fresh" as const,
  };
}

async function createModelProfileAuthority(
  tx: Prisma.TransactionClient,
  input: {
    readonly actor: AdminActor;
    readonly requestId: string;
    readonly body: {
      readonly profileKey: string;
      readonly label: string;
      readonly mode: "image" | "video";
      readonly runner: string;
      readonly pipelineModel: string;
      readonly workflowKey?: string | null;
      readonly sourceModelPath?: string | null;
      readonly convertedModelPath?: string | null;
      readonly modelFormat: "safetensors" | "gguf" | "diffusers" | "external";
      readonly runnerConfig?: Record<string, unknown>;
      readonly defaultWidth: number;
      readonly defaultHeight: number;
      readonly allowedOrientations: readonly string[];
      readonly steps: number;
      readonly sampler: string;
      readonly scheduler: string;
      readonly cfgScale: number;
      readonly costMultiplier: number;
      readonly requiredEntitlement?: string | null;
      readonly maxCount: number;
      readonly concurrencyLimit: number;
      readonly enabled: boolean;
      readonly rolloutPercent: number;
      readonly dryRunSummary?: Record<string, unknown>;
    };
  },
) {
  const { body } = input;
  await assertKnownWorkflowKey(body.workflowKey);
  const latest = await tx.generationModelProfile.findFirst({
    where: { profileKey: body.profileKey },
    orderBy: { version: "desc" },
    select: { version: true },
  });
  const profile = await tx.generationModelProfile.create({
    data: {
      profileKey: body.profileKey,
      label: body.label,
      mode: body.mode,
      runner: body.runner,
      pipelineModel: body.pipelineModel,
      workflowKey: body.workflowKey ?? null,
      sourceModelPath: body.sourceModelPath ?? null,
      convertedModelPath: body.convertedModelPath ?? null,
      modelFormat: body.modelFormat,
      runnerConfig: body.runnerConfig ? toInputJson(body.runnerConfig) : undefined,
      defaultWidth: body.defaultWidth,
      defaultHeight: body.defaultHeight,
      allowedOrientations: toInputJson(body.allowedOrientations),
      steps: body.steps,
      sampler: body.sampler,
      scheduler: body.scheduler,
      cfgScale: body.cfgScale,
      costMultiplier: body.costMultiplier,
      requiredEntitlement: body.requiredEntitlement ?? null,
      maxCount: body.maxCount,
      concurrencyLimit: body.concurrencyLimit,
      enabled: body.enabled,
      rolloutPercent: body.rolloutPercent,
      dryRunSummary: body.dryRunSummary ? toInputJson(body.dryRunSummary) : undefined,
      version: (latest?.version ?? 0) + 1,
      status: "draft",
    },
    select: profileSelect,
  });
  await writeProfileAudit(tx, input.actor, input.requestId, {
    action: "generation.profile.create",
    targetId: profile.id,
    after: { profileKey: profile.profileKey, version: profile.version, status: profile.status },
  });
  return { profile: modelProfileView(profile) };
}

export type ModelProfilePatchBody = {
  readonly profileKey?: string;
  readonly label?: string;
  readonly mode?: "image" | "video";
  readonly runner?: string;
  readonly pipelineModel?: string;
  readonly workflowKey?: string | null;
  readonly sourceModelPath?: string | null;
  readonly convertedModelPath?: string | null;
  readonly modelFormat?: "safetensors" | "gguf" | "diffusers" | "external";
  readonly runnerConfig?: Record<string, unknown>;
  readonly defaultWidth?: number;
  readonly defaultHeight?: number;
  readonly allowedOrientations?: readonly string[];
  readonly steps?: number;
  readonly sampler?: string;
  readonly scheduler?: string;
  readonly cfgScale?: number;
  readonly costMultiplier?: number;
  readonly requiredEntitlement?: string | null;
  readonly maxCount?: number;
  readonly concurrencyLimit?: number;
  readonly enabled?: boolean;
  readonly rolloutPercent?: number;
  readonly dryRunSummary?: Record<string, unknown>;
  readonly reason?: string;
  readonly confirmation?: string;
};

/** SPEC: a disable-only patch is the kill switch; everything else is draft authoring. */
export function isOperationalModelProfileDisablePatch(body: ModelProfilePatchBody) {
  if (body.enabled !== false) return false;
  return definedKeys(body).every((key) => ["enabled", "reason", "confirmation"].includes(key));
}

async function patchModelProfileAuthority(
  tx: Prisma.TransactionClient,
  input: {
    readonly actor: AdminActor;
    readonly requestId: string;
    readonly profileId: string;
    readonly body: ModelProfilePatchBody;
  },
) {
  const { body, profileId } = input;
  const before = await tx.generationModelProfile.findUnique({
    where: { id: profileId },
    select: profileSelect,
  });
  if (!before) throw Errors.notFound("Model profile not found");
  if (before.status !== "draft") {
    const forbiddenKeys = definedKeys(body).filter(
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
  // INVARIANT: a disable-only PATCH must not rewrite runnerConfig — disabling a misbehaving
  // profile can never depend on its runner config parsing.
  const shouldPersistRunnerConfig =
    body.runnerConfig !== undefined || body.pipelineModel !== undefined || body.runner !== undefined;
  const runnerConfig = shouldPersistRunnerConfig
    ? body.runnerConfig ?? jsonRecord(before.runnerConfig)
    : undefined;
  await assertKnownWorkflowKey(body.workflowKey);

  const updated = await tx.generationModelProfile.update({
    where: { id: profileId },
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
    select: profileSelect,
  });
  await writeProfileAudit(tx, input.actor, input.requestId, {
    action: body.enabled === false ? "generation.profile.disable" : "generation.profile.update",
    targetId: profileId,
    reason: body.reason,
    before: profileAuditSnapshot(before),
    after: profileAuditSnapshot(updated),
  });
  return { profile: modelProfileView(updated) };
}

async function publishModelProfileAuthority(
  tx: Prisma.TransactionClient,
  input: {
    readonly actor: AdminActor;
    readonly requestId: string;
    readonly profileId: string;
    readonly body: {
      readonly reason: string;
      readonly confirmation: string;
      readonly dryRunSummary?: Record<string, unknown>;
    };
  },
) {
  const { body, profileId } = input;
  const profile = await tx.generationModelProfile.findUnique({
    where: { id: profileId },
    select: profileSelect,
  });
  if (!profile) throw Errors.notFound("Model profile not found");
  assertTargetConfirmation(body.confirmation, profile.id);
  if (profile.status !== "draft") throw Errors.badRequest("Only draft profiles can be published");
  if (profile.mode === "video" && !(await featureEnabled(tx, "video_gen"))) {
    throw Errors.forbidden("Video generation is disabled by feature flag");
  }

  const dryRunSummary = body.dryRunSummary
    ? mergeModelProfilePublishEvidence(profile.dryRunSummary, body.dryRunSummary)
    : profile.dryRunSummary;
  if (!dryRunSummary) throw Errors.badRequest("Publish requires dry-run summary");
  assertModelProfilePublishable(profile, dryRunSummary);
  const verifiedSummary = profile.mode === "image"
    ? await attachVerifiedProfileTestEvidence(tx, profile, dryRunSummary)
    : dryRunSummary;

  const previous = await tx.generationModelProfile.findFirst({
    where: { profileKey: profile.profileKey, status: "active" },
    select: profileSelect,
  });
  await tx.generationModelProfile.updateMany({
    where: { profileKey: profile.profileKey, status: "active" },
    data: { status: "archived", archivedAt: new Date() },
  });
  const published = await tx.generationModelProfile.update({
    where: { id: profileId },
    data: {
      status: "active",
      enabled: true,
      rolloutPercent: profile.rolloutPercent > 0 ? profile.rolloutPercent : 100,
      dryRunSummary: verifiedSummary,
      publishedAt: new Date(),
      archivedAt: null,
    },
    select: profileSelect,
  });
  await writeProfileAudit(tx, input.actor, input.requestId, {
    action: "generation.profile.publish",
    targetId: profileId,
    reason: body.reason,
    before: previous ? profileAuditSnapshot(previous) : null,
    after: profileAuditSnapshot(published),
  });
  return { profile: modelProfileView(published), previousActiveId: previous?.id ?? null };
}

async function rollbackModelProfileAuthority(
  tx: Prisma.TransactionClient,
  input: {
    readonly actor: AdminActor;
    readonly requestId: string;
    readonly profileId: string;
    readonly body: { readonly reason: string; readonly confirmation: string };
  },
) {
  const { body, profileId } = input;
  const current = await tx.generationModelProfile.findUnique({
    where: { id: profileId },
    select: profileSelect,
  });
  if (!current) throw Errors.notFound("Model profile not found");
  assertTargetConfirmation(body.confirmation, current.id);
  const previous = await tx.generationModelProfile.findFirst({
    where: {
      profileKey: current.profileKey,
      status: "archived",
      version: { lt: current.version },
    },
    orderBy: { version: "desc" },
    select: { id: true },
  });
  if (!previous) throw Errors.notFound("No previous profile version to roll back to");
  await tx.generationModelProfile.updateMany({
    where: { profileKey: current.profileKey, status: "active" },
    data: { status: "archived", archivedAt: new Date() },
  });
  const restored = await tx.generationModelProfile.update({
    where: { id: previous.id },
    data: { status: "active", enabled: true, publishedAt: new Date(), archivedAt: null },
    select: profileSelect,
  });
  await writeProfileAudit(tx, input.actor, input.requestId, {
    action: "generation.profile.rollback",
    targetId: current.id,
    reason: body.reason,
    before: profileAuditSnapshot(current),
    after: profileAuditSnapshot(restored),
  });
  return {
    profile: modelProfileView(restored),
    fromVersion: current.version,
    toVersion: restored.version,
  };
}

export function assertTargetConfirmation(value: string, targetId: string) {
  if (value !== targetId) throw Errors.badRequest("Confirmation did not match target");
}

// SPEC: workflowKey (nullable) points at a gen workflow descriptor; empty means "stay on
// pipelineModel". A non-empty key must resolve, or the profile would describe a route nothing
// can execute.
// INVARIANT: reuses generation-catalog's descriptor cache — never rescans the directory here.
async function assertKnownWorkflowKey(workflowKey: string | null | undefined) {
  if (!workflowKey) return;
  if (!(await workflowKeyExists(workflowKey))) {
    throw Errors.badRequest("Unknown workflowKey", { workflowKey });
  }
}

async function featureEnabled(tx: Prisma.TransactionClient, key: string) {
  const flag = await tx.featureFlag.findUnique({ where: { key }, select: { enabled: true } });
  return Boolean(flag?.enabled);
}

async function attachVerifiedProfileTestEvidence(
  tx: Prisma.TransactionClient,
  profile: { id: string; profileKey: string; version: number },
  summaryValue: Prisma.JsonValue | Prisma.InputJsonValue,
): Promise<Prisma.InputJsonValue> {
  const summary = jsonRecord(summaryValue as Prisma.JsonValue);
  const reviewedSamples = firstNumberFromRecord(summary, [
    "consistencySampleCount",
    "sampleCount",
  ]) ?? 0;
  const evidence = await tx.generationJob.aggregate({
    where: {
      profileId: { in: [profile.id, profile.profileKey] },
      profileVersion: profile.version,
      sourceType: "admin_profile_test",
      status: "completed",
    },
    _count: { _all: true },
    _sum: { deliveredOutputCount: true },
  });
  const completedOutputs = evidence._sum.deliveredOutputCount ?? 0;
  if (reviewedSamples > completedOutputs) {
    throw Errors.badRequest(
      "Publish requires completed profile-test outputs for every reviewed consistency sample",
      {
        reviewedSamples,
        completedOutputs,
        completedJobs: evidence._count._all,
      },
    );
  }
  return toInputJson({
    ...summary,
    profileTestJobCount: evidence._count._all,
    profileTestOutputCount: completedOutputs,
    profileTestEvidenceVerifiedAt: new Date().toISOString(),
  });
}

function mergeModelProfilePublishEvidence(
  storedSummary: Prisma.JsonValue,
  submittedSummary: Record<string, unknown>,
): Prisma.InputJsonValue {
  const stored = jsonRecord(storedSummary);
  const consistencySampleCount =
    numberFromRecord(submittedSummary, "consistencySampleCount") ??
    numberFromRecord(submittedSummary, "sampleCount");
  const consistencyPassCount = numberFromRecord(submittedSummary, "consistencyPassCount");
  const consistencyRate = firstNumberFromRecord(submittedSummary, [
    "consistencyRate",
    "consistencyPassRate",
    "identityConsistencyRate",
    "manualConsistencyRate",
  ]);
  const reviewUrl = stringFromRecord(submittedSummary, "reviewUrl");
  const reviewSource =
    stringFromRecord(submittedSummary, "reviewSource") ??
    stringFromRecord(submittedSummary, "source");
  const reviewStatus =
    stringFromRecord(submittedSummary, "reviewStatus") ??
    stringFromRecord(submittedSummary, "status");

  return toInputJson({
    ...stored,
    ...(consistencySampleCount === undefined ? {} : { consistencySampleCount }),
    ...(consistencyPassCount === undefined ? {} : { consistencyPassCount }),
    ...(consistencyRate === undefined ? {} : { consistencyRate }),
    ...(reviewUrl ? { reviewUrl } : {}),
    ...(reviewSource ? { reviewSource } : {}),
    ...(reviewStatus ? { reviewStatus } : {}),
  });
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
  const summary = jsonRecord(dryRunSummary as Prisma.JsonValue);
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
    throw Errors.badRequest("Publish requires a dry run without failureMode", { failureMode });
  }

  const sampleCount = profile.mode === "image"
    ? firstNumberFromRecord(summary, ["consistencySampleCount", "sampleCount"])
    : numberFromRecord(summary, "sampleCount");
  const minSamples = profile.mode === "image" ? imageProfilePublishMinSamples : 1;
  if (sampleCount === undefined || sampleCount < minSamples) {
    throw Errors.badRequest(
      profile.mode === "image"
        ? `Publish requires at least ${minSamples} reviewed consistency samples`
        : `Publish requires at least ${minSamples} configuration-check samples`,
      { sampleCount, minSamples },
    );
  }

  const configurationPassRate = firstNumberFromRecord(summary, [
    "configurationPassRate",
    "successRate",
  ]);
  if (configurationPassRate === undefined || configurationPassRate < modelProfilePublishMinRate) {
    throw Errors.badRequest("Publish requires configuration-check pass rate >= 0.8", {
      configurationPassRate: configurationPassRate ?? null,
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
      throw Errors.badRequest("Publish requires image consistencyRate >= 0.8", { consistencyRate });
    }
  }
}

function modelProfileBadComponentStatuses(value: unknown) {
  const componentStatus = jsonRecord(value as Prisma.JsonValue);
  return Object.entries(componentStatus).flatMap(([key, rawValue]) => {
    const status = modelComponentStatusValue(rawValue);
    return status && isBadModelComponentStatus(status) ? [{ key, status }] : [];
  });
}

function modelComponentStatusValue(value: unknown) {
  const rawStatus = typeof value === "string"
    ? value
    : isRecord(value)
      ? stringFromRecord(value, "status") ?? ""
      : "";
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
  profile: { mode: string; sourceModelPath: string | null; convertedModelPath: string | null },
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

function profileAuditSnapshot(profile: ProfileRow) {
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

export async function writeProfileAudit(
  tx: Prisma.TransactionClient,
  actor: AdminActor,
  requestId: string,
  input: {
    readonly action: string;
    readonly targetId: string;
    readonly targetType?: string;
    readonly reason?: string;
    readonly before?: unknown;
    readonly after?: unknown;
  },
) {
  await tx.adminAuditLog.create({
    data: {
      actorId: actor.id,
      actorRole: actor.role,
      action: input.action,
      targetType: input.targetType ?? "generation_model_profile",
      targetId: input.targetId,
      reason: input.reason,
      before: input.before === undefined ? undefined : toInputJson(input.before),
      after: input.after === undefined ? undefined : toInputJson(input.after),
      requestId,
    },
  });
}

export function stringFromRecord(value: Record<string, unknown>, key: string) {
  const child = value[key];
  return typeof child === "string" && child.trim() ? child.trim() : undefined;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function definedKeys(value: object) {
  return Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .map(([key]) => key);
}

function cursorString(keys: readonly unknown[], index: number) {
  const value = keys[index];
  if (typeof value !== "string" || !value) {
    throw Errors.badRequest("generation_profiles cursor key is invalid");
  }
  return value;
}

function cursorNumber(keys: readonly unknown[], index: number) {
  const value = keys[index];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw Errors.badRequest("generation_profiles cursor key is invalid");
  }
  return value;
}

// ---------------------------------------------------------------------------
// HTTP entry points
// ---------------------------------------------------------------------------

export async function createGenerationModelProfile(request: Request) {
  const actor = await actorWithPermission(request, "generation.config.write");
  assertModelDiagnosticsEnabled();
  const body = await jsonBody(request, "generationModelProfileCreateRequestSchema+idempotency-key");
  const requestId = adminRequestId(request);
  return executeAtomicIdempotentMutation({
    environment: env.APP_ENV,
    actor,
    idempotencyKey: requireIdempotencyKey(request),
    requestId,
    commandType: "generation.profile.create",
    target: { type: "generation_model_profile", id: body.profileKey },
    payload: body,
    mutate: (tx) => createModelProfileAuthority(tx, { actor, requestId, body }),
  });
}

export async function patchGenerationModelProfile(request: Request, profileId: string) {
  const actor = await actorWithPermission(request, "generation.config.write");
  const body = await jsonBody(request, "generationModelProfilePatchRequestSchema+idempotency-key");
  // The kill switch stays reachable with diagnostics off; authoring does not.
  if (!isOperationalModelProfileDisablePatch(body)) assertModelDiagnosticsEnabled();
  const requestId = adminRequestId(request);
  return executeAtomicIdempotentMutation({
    environment: env.APP_ENV,
    actor,
    idempotencyKey: requireIdempotencyKey(request),
    requestId,
    commandType: "generation.profile.update",
    target: { type: "generation_model_profile", id: profileId },
    payload: body,
    mutate: (tx) => patchModelProfileAuthority(tx, { actor, requestId, profileId, body }),
  });
}

export async function publishGenerationModelProfile(request: Request, profileId: string) {
  const actor = await actorWithPermission(request, "generation.config.write");
  const body = await jsonBody(request, "generationPublishCommandRequestSchema+idempotency-key");
  const requestId = adminRequestId(request);
  return executeAtomicIdempotentMutation({
    environment: env.APP_ENV,
    actor,
    idempotencyKey: requireIdempotencyKey(request),
    requestId,
    commandType: "generation.profile.publish",
    target: { type: "generation_model_profile", id: profileId },
    payload: body,
    mutate: (tx) => publishModelProfileAuthority(tx, { actor, requestId, profileId, body }),
  });
}

export async function rollbackGenerationModelProfile(request: Request, profileId: string) {
  const actor = await actorWithPermission(request, "generation.config.write");
  const body = await jsonBody(request, "generationConfigCommandRequestSchema+idempotency-key");
  const requestId = adminRequestId(request);
  return executeAtomicIdempotentMutation({
    environment: env.APP_ENV,
    actor,
    idempotencyKey: requireIdempotencyKey(request),
    requestId,
    commandType: "generation.profile.rollback",
    target: { type: "generation_model_profile", id: profileId },
    payload: body,
    mutate: (tx) => rollbackModelProfileAuthority(tx, { actor, requestId, profileId, body }),
  });
}
