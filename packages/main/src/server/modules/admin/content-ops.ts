import type { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  characterRouteEvaluationMatrixDirections,
  characterRouteEvaluationMatrixKey,
  characterRouteEvaluationMatrixSchemaVersion,
  characterRouteEvaluationOutputsPerDirection,
  characterRouteEvaluationSampleCount,
  incrementCounter,
} from "@idream/shared";
import { recordGenerationAttemptQueuedEvent } from "@/server/ai/generation-attempt-events";
import { dimensionsForImageOrientation } from "@/server/modules/ourdream/generation-dimensions";
import { generationCostDreamcoins } from "@/server/lib/generation-pricing";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import {
  isMediaAssetOperationalForAuthority,
  isSyntheticMediaAsset,
} from "@/server/lib/media-asset-authority";
import {
  mediaAssetAuthorityDependencies,
  mediaAssetAuthorityDependenciesBatch,
} from "@/server/modules/admin-v2/shared/media-asset-authority-dependencies";
import {
  assertMediaAssetCustomerPublishable,
  resolveMediaAssetAuthorityMap,
  type ResolvedMediaAssetAuthority,
} from "@/server/lib/media-asset-authority-query";
import {
  actorWithPermission,
  clampInt,
  jsonBody,
  toInputJson,
  type AdminActor,
} from "./service";
import { adminAuditData } from "./shared/legacy-primitives";
import {
  deriveCreativeRunState,
  refreshContentProductionBatchStats,
  type CreativeRunLedgerFact,
} from "./content-production-state";
import { dispatchCreativeRetryOutbox } from "@/server/modules/admin-v2/creative/retry-executor";
import { canonicalSha256 } from "@/server/modules/admin-v2/shared/canonical-json";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";
import {
  decodeAdminListCursor,
  encodeAdminListCursor,
  parseIsoCursorKey,
} from "@/server/modules/admin-v2/shared/list-cursor";
import { generationWorkflowDescriptor } from "./generation-catalog";
import {
  ensureOperationalGenerationRoute,
  findOperationalGenerationRoute,
} from "@/server/modules/admin-v2/characters/visual-authority";
import { CHARACTER_RELEASE_POLICY_VERSION } from "@/server/modules/admin-v2/characters/release-executor";
import {
  characterVisualProfileSnapshotHash,
  referenceSetSnapshotHash,
} from "@/server/modules/admin-v2/characters/release-snapshot";
import { loadCharacterIdentityBootstrapAuthority } from "@/server/modules/admin-v2/characters/identity-bootstrap-authority";
import {
  lockCharacterGenerationAndMediaAssetAuthorities,
} from "@/server/modules/admin-v2/characters/generation-authority-lock";
import {
  generationSourceVariationAuthority,
  identityCalibrationGenerationModes,
} from "@/server/modules/admin-v2/characters/generation-route-authority";
import {
  operationalMediaAssetPlacementWhere,
  operationalMediaAssetWhere,
} from "@/server/modules/admin/shared/metric-data-scope";

const productionPurposeSchema = z.enum([
  "character_cover",
  "character_hero",
  "character_chat",
  "feed",
  "homepage",
  "seo",
  "template_cover",
  "campaign",
  "model_eval",
  "identity_calibration",
]);

const productionTargetTypeSchema = z.enum([
  "character",
  "route_page",
  "campaign",
  "template",
  "none",
]);

const placementSlotSchema = z.enum([
  "character_avatar",
  "character_hero",
  "character_chat",
  "feed_card",
  "homepage_strip",
  "seo_article",
  "template_cover",
  "campaign",
]);

const releaseOwnedPlacementSlots = new Set(["character_avatar", "character_hero", "character_chat"]);
const assetReviewStatusSchema = z.enum(["draft", "generated", "approved", "rejected", "published", "archived"]);
const consistencyModeSchema = z.enum(["strict", "balanced", "creative"]);
const productionDirectionSchema = z.object({
  id: z.string().trim().min(1).max(180),
  title: z.string().trim().min(2).max(80),
  scenePrompt: z.string().trim().min(12).max(1_200),
  mood: z.string().trim().min(1).max(120),
  setting: z.string().trim().min(1).max(120),
  outfit: z.string().trim().min(1).max(120),
  camera: z.string().trim().min(1).max(120),
  lighting: z.string().trim().min(1).max(120),
}).strict();

const optionalText = (max: number) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().max(max).optional(),
  );

const productionBatchCreateBaseSchema = z.object({
  title: optionalText(160),
  purpose: productionPurposeSchema,
  targetType: productionTargetTypeSchema.default("none"),
  targetId: optionalText(180),
  profileId: z.string().trim().min(1).max(180),
  recipeId: optionalText(180),
  presetIds: z.array(z.string().trim().min(1).max(180)).max(12).default([]),
  referenceAssetIds: z.array(z.string().trim().min(1).max(180)).max(4).default([]),
  bootstrapIdentity: z.boolean().default(false),
  orientation: optionalText(20),
  count: z.number().int().min(1).max(40).default(4),
  brief: optionalText(2_000),
  directions: z.array(productionDirectionSchema).min(1).max(12).optional(),
  outputsPerDirection: z.number().int().min(1).max(24).optional(),
  routeEvaluationMatrixKey: optionalText(160),
  identityExperiment: z.object({
    mode: z.enum(["text_to_image", "image_to_image"]),
    negativePrompt: z.string().trim().max(2_000).default(""),
    seedStrategy: z.enum(["random", "locked", "reuse_source"]),
    baseSeed: z.string().trim().min(1).max(200).optional(),
    sourceAssetId: z.string().trim().min(1).max(180).optional(),
    strength: z.number().min(0.1).max(1).default(0.65),
  }).strict().optional(),
  consistencyMode: consistencyModeSchema.default("balanced"),
  dueAt: optionalText(80),
  priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
  reason: optionalText(2_000),
});

const productionBatchCreateSchema = productionBatchCreateBaseSchema.superRefine((value, ctx) => {
  const characterPurpose = [
    "character_cover",
    "character_hero",
    "character_chat",
    "identity_calibration",
  ]
    .includes(value.purpose);
  const genericPurpose = ["feed", "homepage", "seo", "template_cover", "campaign"]
    .includes(value.purpose);
  if (value.targetType !== "none" && !value.targetId) {
    ctx.addIssue({ code: "custom", path: ["targetId"], message: "Target ID is required for this target type" });
  }
  if (value.targetType === "none" && value.targetId) {
    ctx.addIssue({ code: "custom", path: ["targetId"], message: "Target ID must be omitted for a targetless Run" });
  }
  if (characterPurpose && value.targetType !== "character") {
    ctx.addIssue({
      code: "custom",
      path: ["targetType"],
      message: "Character image purposes must use the dedicated Character target workflow",
    });
  }
  if (genericPurpose && value.targetType !== "none") {
    ctx.addIssue({
      code: "custom",
      path: ["targetType"],
      message: "Generic image Runs must remain targetless until an artifact is reviewed",
    });
  }
  if (!value.directions && value.outputsPerDirection !== undefined) {
    ctx.addIssue({ code: "custom", path: ["outputsPerDirection"], message: "Outputs per direction requires persisted directions" });
  }
  const outputLimit = value.purpose === "model_eval" ? 40 : 24;
  if (value.count > outputLimit) {
    ctx.addIssue({
      code: "custom",
      path: ["count"],
      message: `A ${value.purpose === "model_eval" ? "model evaluation" : "Creative"} Run cannot exceed ${outputLimit} outputs`,
    });
  }
  if (value.directions && value.directions.length * (value.outputsPerDirection ?? 1) > outputLimit) {
    ctx.addIssue({ code: "custom", path: ["outputsPerDirection"], message: `This Run cannot exceed ${outputLimit} outputs` });
  }
  if (
    value.bootstrapIdentity &&
    (value.targetType !== "character" || value.purpose !== "character_cover")
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["bootstrapIdentity"],
      message: "Identity bootstrap is only valid for a Character primary portrait Run",
    });
  }
  if (value.bootstrapIdentity && value.referenceAssetIds.length > 0) {
    ctx.addIssue({
      code: "custom",
      path: ["referenceAssetIds"],
      message: "Identity bootstrap cannot depend on an existing Character reference",
    });
  }
  if (value.targetType !== "character" && value.referenceAssetIds.length > 0) {
    ctx.addIssue({
      code: "custom",
      path: ["referenceAssetIds"],
      message: "Generic image production is text-to-image only and cannot accept reference assets",
    });
  }
  if (value.purpose === "model_eval" && value.targetType !== "character") {
    ctx.addIssue({
      code: "custom",
      path: ["targetType"],
      message: "Identity route evaluation must pin a Character and its current reference authority",
    });
  }
  if (value.purpose === "model_eval" && value.referenceAssetIds.length > 0) {
    ctx.addIssue({
      code: "custom",
      path: ["referenceAssetIds"],
      message: "Route evaluation uses only the Character's sealed canonical Reference Set",
    });
  }
  if (
    value.purpose === "model_eval" &&
    (
      value.count !== characterRouteEvaluationSampleCount ||
      value.outputsPerDirection !==
        characterRouteEvaluationOutputsPerDirection ||
      JSON.stringify(value.directions) !==
        JSON.stringify(characterRouteEvaluationMatrixDirections)
    )
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["directions"],
      message: "Route evaluation must use the canonical 10-direction, 40-sample matrix",
    });
  }
  if (value.purpose === "model_eval" && !value.routeEvaluationMatrixKey) {
    ctx.addIssue({
      code: "custom",
      path: ["routeEvaluationMatrixKey"],
      message: "Route evaluation must pin the canonical matrix key",
    });
  }
  if (
    value.purpose !== "model_eval" &&
    value.routeEvaluationMatrixKey !== undefined
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["routeEvaluationMatrixKey"],
      message: "Only route evaluation Runs may pin a route evaluation matrix key",
    });
  }
  if (value.purpose === "identity_calibration" && !value.identityExperiment) {
    ctx.addIssue({
      code: "custom",
      path: ["identityExperiment"],
      message: "Identity calibration must preserve an immutable experiment snapshot",
    });
  }
  if (value.purpose !== "identity_calibration" && value.identityExperiment) {
    ctx.addIssue({
      code: "custom",
      path: ["identityExperiment"],
      message: "Only identity calibration Runs may include an identity experiment snapshot",
    });
  }
  if (value.purpose === "identity_calibration" && value.referenceAssetIds.length > 0) {
    ctx.addIssue({
      code: "custom",
      path: ["referenceAssetIds"],
      message: "Identity calibration sources must be pinned through the experiment snapshot",
    });
  }
  if (
    value.identityExperiment?.mode === "text_to_image" &&
    value.identityExperiment.sourceAssetId
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["identityExperiment", "sourceAssetId"],
      message: "Text-to-image calibration cannot include a source image",
    });
  }
  if (
    value.identityExperiment?.mode === "image_to_image" &&
    !value.identityExperiment.sourceAssetId
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["identityExperiment", "sourceAssetId"],
      message: "Image-to-image calibration requires a source image",
    });
  }
  if (
    value.identityExperiment?.seedStrategy === "locked" &&
    !value.identityExperiment.baseSeed
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["identityExperiment", "baseSeed"],
      message: "Locked seed calibration requires a base seed",
    });
  }
  if (
    value.identityExperiment?.seedStrategy === "reuse_source" &&
    value.identityExperiment.mode !== "image_to_image"
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["identityExperiment", "seedStrategy"],
      message: "Source seed reuse is only valid for image-to-image calibration",
    });
  }
});

const productionEstimateSchema = productionBatchCreateBaseSchema.pick({
  profileId: true,
  count: true,
});

const itemReviewSchema = z.object({
  reviewNote: optionalText(2_000),
  description: optionalText(2_000),
  rating: z.number().int().min(1).max(5).optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(24).default([]),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

const itemRegenerateSchema = z.object({
  brief: optionalText(2_000),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

const assetPatchSchema = z.object({
  status: assetReviewStatusSchema.optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(48).optional(),
  description: optionalText(2_000),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
}).strict();

const assetBulkSchema = z.object({
  assetIds: z.array(z.string().trim().min(1).max(180)).min(1).max(100),
  status: assetReviewStatusSchema.optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(48).optional(),
  description: optionalText(2_000),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(20_000),
});

const assetBulkPreflightSchema = z.object({
  assetIds: z.array(z.string().trim().min(1).max(180)).min(1).max(100),
}).strict();

const placementCreateSchema = z.object({
  mediaAssetId: z.string().trim().min(1).max(180),
  slot: placementSlotSchema,
  targetType: productionTargetTypeSchema.exclude(["none"]),
  targetId: z.string().trim().min(1).max(180),
  status: z.literal("draft").default("draft"),
  metadata: z.record(z.string(), z.unknown()).default({}),
  reason: z.string().trim().min(3).max(2_000),
});

const placementPatchSchema = z.object({
  status: z.enum(["paused", "archived"]),
  metadata: z.record(z.string(), z.unknown()).optional(),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

function requirePlacementVersion(request: Request) {
  const value = request.headers
    .get("if-match")
    ?.trim()
    .replace(/^W\//, "")
    .replace(/^"|"$/g, "");
  if (!value || !/^\d+$/.test(value)) {
    throw Errors.badRequest("If-Match must contain the current Placement version");
  }
  return Number(value);
}

export const productionBatchInclude = {
  createdBy: { select: { id: true, email: true, displayName: true, name: true } },
  items: {
    include: {
      job: { include: { assets: true } },
      mediaAsset: true,
    },
    orderBy: { itemIndex: "asc" },
  },
} satisfies Prisma.ContentProductionBatchInclude;

const placementInclude = {
  mediaAsset: true,
  createdBy: { select: { id: true, email: true, displayName: true, name: true } },
} satisfies Prisma.MediaAssetPlacementInclude;

type ProductionBatchWithItems = Prisma.ContentProductionBatchGetPayload<{
  include: typeof productionBatchInclude;
}>;

type ContentAssetWithRelations = Prisma.MediaAssetGetPayload<{
  include: {
    sourceJob: true;
    productionItems: { include: { batch: true } };
    placements: true;
  };
}>;

type PlacementWithRelations = Prisma.MediaAssetPlacementGetPayload<{
  include: typeof placementInclude;
}>;

type ContentAssetBase = Omit<
  ContentAssetWithRelations,
  "sourceJob" | "productionItems" | "placements"
>;

async function hydrateContentAssets(
  db: Prisma.TransactionClient | typeof prisma,
  assets: readonly ContentAssetBase[],
): Promise<ContentAssetWithRelations[]> {
  if (assets.length === 0) return [];
  const assetIds = assets.map((asset) => asset.id);
  const sourceJobIds = [
    ...new Set(
      assets.flatMap((asset) => asset.sourceJobId ? [asset.sourceJobId] : []),
    ),
  ];
  const jobs = sourceJobIds.length > 0
    ? await db.generationJob.findMany({
        where: { id: { in: sourceJobIds } },
      })
    : [];
  const items = await db.contentProductionItem.findMany({
    where: { mediaAssetId: { in: assetIds } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const batchIds = [...new Set(items.map((item) => item.batchId))];
  const batches = batchIds.length > 0
    ? await db.contentProductionBatch.findMany({
        where: { id: { in: batchIds } },
      })
    : [];
  const placements = await db.mediaAssetPlacement.findMany({
    where: { mediaAssetId: { in: assetIds } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const jobById = new Map(jobs.map((job) => [job.id, job] as const));
  const batchById = new Map(batches.map((batch) => [batch.id, batch] as const));
  const latestItemByAssetId = new Map<string, (typeof items)[number]>();
  for (const item of items) {
    if (item.mediaAssetId && !latestItemByAssetId.has(item.mediaAssetId)) {
      latestItemByAssetId.set(item.mediaAssetId, item);
    }
  }
  const placementsByAssetId = new Map<string, typeof placements>();
  for (const placement of placements) {
    const existing = placementsByAssetId.get(placement.mediaAssetId) ?? [];
    existing.push(placement);
    placementsByAssetId.set(placement.mediaAssetId, existing);
  }

  return assets.map((asset) => {
    const item = latestItemByAssetId.get(asset.id);
    const batch = item ? batchById.get(item.batchId) : null;
    return {
      ...asset,
      sourceJob: asset.sourceJobId
        ? jobById.get(asset.sourceJobId) ?? null
        : null,
      productionItems: item && batch ? [{ ...item, batch }] : [],
      placements: placementsByAssetId.get(asset.id) ?? [],
    };
  });
}

export async function listProductionBatches(request: Request) {
  await actorWithPermission(request, "content.asset.read");
  const url = new URL(request.url);
  const purpose = productionPurposeSchema.safeParse(url.searchParams.get("purpose")).data;
  const status = url.searchParams.get("status")?.trim() || undefined;
  const targetId = url.searchParams.get("targetId")?.trim() || undefined;
  const batches = await prisma.contentProductionBatch.findMany({
    where: {
      purpose,
      status,
      targetId,
    },
    include: productionBatchInclude,
    orderBy: { createdAt: "desc" },
    take: clampInt(url.searchParams.get("limit"), 1, 100, 50),
  });
  const [ledgerEntries, mediaAuthorityById] = await Promise.all([
    productionBatchLedgerEntries(batches),
    productionBatchMediaAuthority(batches),
  ]);
  return ok({
    items: batches.map((batch) =>
      productionBatchDTO(
        batch,
        ledgerEntriesForBatch(batch, ledgerEntries),
        mediaAuthorityById,
      ),
    ),
  });
}

export async function estimateProductionBatch(request: Request) {
  await actorWithPermission(request, "content.asset.read");
  const body = productionEstimateSchema.parse(await jsonBody(request));
  const profile = await resolveProductionProfile(body.profileId);
  const perItemCostDreamcoins = await generationCostDreamcoins(
    "image",
    1,
    profile.costMultiplier ?? 1,
  );
  return ok({
    perItemCostDreamcoins,
    totalCostDreamcoins: perItemCostDreamcoins * body.count,
  });
}

export type ProductionBatchCreateInput = z.infer<typeof productionBatchCreateSchema>;

export function productionCandidateSeed(input: {
  readonly baseSeed: string | null | undefined;
  readonly batchId: string;
  readonly directionId: string | null;
  readonly variantIndex: number;
}) {
  const baseSeed = input.baseSeed?.trim() || "candidate";
  return [
    baseSeed,
    `batch:${input.batchId}`,
    `direction:${input.directionId ?? "default"}`,
    `variant:${input.variantIndex + 1}`,
  ].join(":");
}

export function identityExperimentCandidateSeed(input: {
  readonly strategy: "random" | "locked" | "reuse_source";
  readonly baseSeed: string | null | undefined;
  readonly sourceSeed: string | null | undefined;
  readonly batchId: string;
  readonly variantIndex: number;
}) {
  const variant = `variant:${input.variantIndex + 1}`;
  if (input.strategy === "locked") {
    return [input.baseSeed?.trim() || "locked", variant].join(":");
  }
  if (input.strategy === "reuse_source") {
    return [input.sourceSeed?.trim() || "source", "continued", variant].join(":");
  }
  return [
    input.baseSeed?.trim() || "random",
    `batch:${input.batchId}`,
    variant,
  ].join(":");
}

// NOTE: takes `request` + full `AdminActor` (not just `actor: {id}`) because
// the atomic Audit row needs actor.role plus request headers.
export async function createProductionBatchCore(
  request: Request,
  actor: AdminActor,
  body: ProductionBatchCreateInput,
): Promise<Response> {
  const idempotencyKey = request.headers.get("idempotency-key")?.trim() || null;
  const commandScope = `${env.APP_ENV}:${actor.id}:creative.run.create`;
  const requestHash = canonicalSha256({ commandType: "creative.run.create", payload: body });
  if (idempotencyKey) {
    const existing = await prisma.controlPlaneCommand.findUnique({
      where: { scope_idempotencyKey: { scope: commandScope, idempotencyKey } },
    });
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw Errors.conflict("Idempotency key was reused with a different Creative Run brief", {
          commandId: existing.id,
        });
      }
      const result = existing.result && typeof existing.result === "object" && !Array.isArray(existing.result)
        ? existing.result as Record<string, unknown>
        : {};
      if (existing.status !== "succeeded" || typeof result.batchId !== "string") {
        throw Errors.conflict("The original Creative Run create command has not completed", {
          commandId: existing.id,
          status: existing.status,
        });
      }
      const batch = await prisma.contentProductionBatch.findUniqueOrThrow({
        where: { id: result.batchId },
        include: productionBatchInclude,
      });
      const mediaAuthorityById = await productionBatchMediaAuthority([batch]);
      return ok(
        {
          batch: productionBatchDTO(batch, [], mediaAuthorityById),
          replayed: true,
        },
        { status: 200 },
      );
    }
  }
  const profile = await resolveProductionProfile(body.profileId);
  const workflowKey = profile.workflowKey ?? profile.pipelineModel;
  const workflow = await generationWorkflowDescriptor(workflowKey);
  const configuredWorkflowVersion = jsonRecord(profile.runnerConfig).workflowVersion;
  const workflowVersion = workflow?.version ?? (
    typeof configuredWorkflowVersion === "number" && Number.isSafeInteger(configuredWorkflowVersion) && configuredWorkflowVersion > 0
      ? configuredWorkflowVersion
      : null
  );
  if (workflowVersion === null) {
    throw Errors.conflict("The exact production workflow version is unavailable", { workflowKey });
  }
  const recipe = await resolveProductionRecipe(body.recipeId, body.targetType);
  const target = await resolveProductionTarget(body.targetType, body.targetId);
  const visualProfile = await resolveProductionVisualProfile(prisma, body.targetType, body.targetId);
  const bootstrapAuthority = body.bootstrapIdentity && body.targetId
    ? await resolveProductionBootstrapAuthority(prisma, body.targetId, body.brief ?? null)
    : null;
  const identityBootstrapAuthority = body.bootstrapIdentity && body.targetId
    ? await loadCharacterIdentityBootstrapAuthority(prisma, body.targetId)
    : null;
  const characterTargetRun = body.targetType === "character";
  const routeEvaluationRun =
    characterTargetRun && body.purpose === "model_eval";
  const identityExperimentRun =
    characterTargetRun && body.purpose === "identity_calibration";
  if (characterTargetRun && !routeEvaluationRun && body.count !== 1) {
    throw Errors.badRequest(
      "Character image production creates exactly one image per Run",
      {
        requestedCount: body.count,
        requiredCount: 1,
      },
    );
  }
  let generationRouteAuthority: {
    readonly qualificationId: string;
    readonly routeFingerprint: string;
  } | null = null;
  const profileCapabilities = generationProfileCapabilities(profile.runnerConfig);
  if (body.bootstrapIdentity) {
    if (!bootstrapAuthority) {
      throw Errors.conflict("Character identity bootstrap requires a current Project and Content draft");
    }
    if (!identityBootstrapAuthority?.allowed) {
      throw Errors.conflict("This Character already has identity authority that cannot be bootstrapped", {
        visualProfileId: visualProfile?.id ?? null,
        visualProfileVersion: visualProfile?.version ?? null,
        blockers: identityBootstrapAuthority?.blockers ?? ["identity_bootstrap_authority_unavailable"],
      });
    }
    if (
      !workflow ||
      workflow.identity.mode !== "none" ||
      workflow.identity.maxReferences !== 0 ||
      !workflow.capabilities.includes("textToImage") ||
      profileCapabilities.textToImage !== true
    ) {
      throw Errors.conflict("The selected profile is not an explicit text-to-image identity bootstrap route", {
        profileKey: profile.profileKey,
        workflowKey,
      });
    }
  } else if (identityExperimentRun) {
    const experiment = body.identityExperiment;
    if (!experiment) {
      throw Errors.badRequest("Identity calibration requires an experiment snapshot");
    }
    const supportedModes = identityCalibrationGenerationModes({
      workflow,
      profileCapabilities,
    });
    if (!supportedModes.includes(experiment.mode)) {
      throw Errors.conflict(
        `The selected profile cannot run ${experiment.mode.replaceAll("_", "-")} identity calibration`,
        {
          profileKey: profile.profileKey,
          workflowKey,
          mode: experiment.mode,
        },
      );
    }
  } else if (characterTargetRun) {
    if (!visualProfile) {
      throw Errors.conflict("Character asset production requires an active sealed Visual Identity", {
        deepLink: `/admin/characters/${body.targetId}?tab=assets`,
      });
    }
    if (
      visualProfile.immutableHash === null ||
      visualProfile.immutableHash !== characterVisualProfileSnapshotHash(visualProfile)
    ) {
      throw Errors.conflict("Character asset production requires a sealed, non-drifted Visual Identity", {
        visualProfileId: visualProfile.id,
        visualProfileVersion: visualProfile.version,
        deepLink: `/admin/characters/${body.targetId}?tab=visual`,
      });
    }
    if (
      !workflow ||
      workflow.identity.mode === "none" ||
      workflow.identity.maxReferences < 1 ||
      !workflow.capabilities.includes("referenceImages") ||
      profileCapabilities.referenceImages !== true
    ) {
      throw Errors.conflict("The selected generation route cannot apply Character identity references", {
        profileKey: profile.profileKey,
        workflowKey,
      });
    }
    if (
      routeEvaluationRun &&
      body.routeEvaluationMatrixKey !==
        characterRouteEvaluationMatrixKey(visualProfile.style)
    ) {
      throw Errors.badRequest(
        "Route evaluation matrix key does not match the active Character identity style",
        {
          expectedMatrixKey:
            characterRouteEvaluationMatrixKey(visualProfile.style),
          receivedMatrixKey: body.routeEvaluationMatrixKey ?? null,
        },
      );
    }
  } else if (
    !workflow ||
    workflow.identity.mode !== "none" ||
    workflow.identity.maxReferences !== 0 ||
    !workflow.capabilities.includes("textToImage") ||
    profileCapabilities.textToImage !== true
  ) {
    throw Errors.conflict("Generic image production requires an explicit text-to-image route", {
      profileKey: profile.profileKey,
      workflowKey,
    });
  }
  const additionalReferenceAssetIds = body.identityExperiment?.sourceAssetId
    ? [body.identityExperiment.sourceAssetId]
    : body.referenceAssetIds;
  const additionalReferenceAssets = additionalReferenceAssetIds.length > 0
    ? await prisma.mediaAsset.findMany({
        where: operationalMediaAssetWhere({
          id: { in: additionalReferenceAssetIds },
          type: "image",
          safetyStatus: "passed",
          deletedAt: null,
        }),
        select: {
          id: true,
          characterId: true,
          metadata: true,
          sourceJob: {
            select: {
              id: true,
              seed: true,
              sourceType: true,
              sourceId: true,
              visualProfileId: true,
              visualProfileVersion: true,
              referenceSetRevisionId: true,
            },
          },
        },
      })
    : [];
  if (
    additionalReferenceAssets.length !== additionalReferenceAssetIds.length ||
    additionalReferenceAssets.some((asset) =>
      !isMediaAssetOperationalForAuthority(asset.metadata)
    )
  ) {
    throw Errors.badRequest("Additional Creative Run references must be available image assets");
  }
  if (
    body.targetType === "character" &&
    additionalReferenceAssets.some((asset) => asset.characterId !== body.targetId)
  ) {
    throw Errors.badRequest("Additional Creative Run references must belong to the target Character");
  }
  if (identityExperimentRun && additionalReferenceAssets.length > 0) {
    if (
      body.identityExperiment?.seedStrategy === "reuse_source" &&
      !additionalReferenceAssets[0]?.sourceJob?.seed
    ) {
      throw Errors.conflict("The selected calibration source has no generation seed to reuse");
    }
  }
  const activeReferenceSet = visualProfile &&
      characterTargetRun &&
      !body.bootstrapIdentity &&
      !identityExperimentRun
    ? await resolveProductionReferenceSet(prisma, visualProfile.id)
    : null;
  if (characterTargetRun && !body.bootstrapIdentity && !identityExperimentRun) {
    if (
      !visualProfile ||
      !activeReferenceSet ||
      activeReferenceSet.snapshotHash === null ||
      activeReferenceSet.snapshotHash !== referenceSetSnapshotHash(activeReferenceSet) ||
      activeReferenceSet.references.length < 1 ||
      activeReferenceSet.references.some((reference) =>
        reference.mediaAsset.deletedAt !== null ||
        reference.mediaAsset.safetyStatus !== "passed" ||
        !isMediaAssetOperationalForAuthority(reference.mediaAsset.metadata) ||
        reference.mediaAsset.characterId !== body.targetId
      )
    ) {
      throw Errors.conflict("Character asset production requires an active sealed and available Reference Set", {
        deepLink: `/admin/characters/${body.targetId}?tab=visual`,
      });
    }
    const requiredRouteReferenceRoles = [
      ...activeReferenceSet.references.map((reference) => reference.role),
      ...additionalReferenceAssets.map(() => "source_image" as const),
    ];
    if (!routeEvaluationRun) {
      const qualifiedRoute = await findOperationalGenerationRoute(prisma, {
        style: visualProfile.style,
        policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
        evaluatorVersion: env.GENERATION_ROUTE_EVALUATOR_VERSION,
        at: new Date(),
        requiredReferenceCount: requiredRouteReferenceRoles.length,
        requiredReferenceRoles: requiredRouteReferenceRoles,
      });
      if (
        !qualifiedRoute ||
        qualifiedRoute.generationProfileKey !== profile.profileKey ||
        qualifiedRoute.generationProfileVersion !== profile.version ||
        qualifiedRoute.workflowKey !== workflowKey ||
        qualifiedRoute.workflowVersion !== workflowVersion
      ) {
        throw Errors.conflict("The selected profile is not the current qualified Character identity route", {
          profileKey: profile.profileKey,
          workflowKey,
          qualifiedProfileKey: qualifiedRoute?.generationProfileKey ?? null,
        });
      }
      generationRouteAuthority = {
        qualificationId: qualifiedRoute.id,
        routeFingerprint: qualifiedRoute.routeFingerprint,
      };
    }
    if (additionalReferenceAssets.some((asset) =>
      asset.sourceJob?.visualProfileId !== visualProfile.id ||
      asset.sourceJob.visualProfileVersion !== visualProfile.version ||
      asset.sourceJob.referenceSetRevisionId !== activeReferenceSet.id
    )) {
      throw Errors.conflict("A variation source must be derived from the active Character identity authority");
    }
    const variationSourceItems = additionalReferenceAssets.map((asset) => ({
      assetId: asset.id,
      itemId: asset.sourceJob?.sourceType === "content_production_item"
        ? asset.sourceJob.sourceId
        : null,
    }));
    if (variationSourceItems.some((source) => !source.itemId)) {
      throw Errors.conflict("A variation source must come from a reviewed Creative Run candidate");
    }
    const latestVariationDecisions = await prisma.creativeReviewDecision.findMany({
      where: {
        runItemId: {
          in: variationSourceItems.flatMap((source) =>
            source.itemId ? [source.itemId] : []
          ),
        },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    const latestDecisionByItemId = new Map<string, (typeof latestVariationDecisions)[number]>();
    for (const decision of latestVariationDecisions) {
      if (!latestDecisionByItemId.has(decision.runItemId)) {
        latestDecisionByItemId.set(decision.runItemId, decision);
      }
    }
    if (variationSourceItems.some((source) => {
      if (!source.itemId) return true;
      const decision = latestDecisionByItemId.get(source.itemId);
      return decision?.artifactId !== source.assetId || decision.decision !== "approved";
    })) {
      throw Errors.conflict(
        "A variation source requires the latest immutable Creative Run decision to be approved",
      );
    }
  }
  const presets = await prisma.generationPreset.findMany({
    where: { id: { in: body.presetIds }, scope: "built_in", status: "active" },
  });
  if (presets.length !== body.presetIds.length) {
    throw Errors.badRequest("Production batch presets must be active built-in presets");
  }
  const allowedOrientations = jsonStringArray(profile.allowedOrientations);
  const orientation = body.orientation ?? allowedOrientations[0] ?? "4:5";
  if (allowedOrientations.length > 0 && !allowedOrientations.includes(orientation)) {
    throw Errors.badRequest("Orientation is not allowed for this profile", {
      orientation,
      allowedOrientations,
    });
  }
  const dimensions = dimensionsForImageOrientation({
    orientation,
    defaultWidth: profile.defaultWidth,
    defaultHeight: profile.defaultHeight,
  });
  const title =
    body.title ??
    `${purposeLabel(body.purpose)} ${new Date().toISOString().slice(0, 10)}`;
  const presetFragment = presetPromptFragment(body.presetIds, presets);
  // A recoverable empty candidate is history, not generation authority. The
  // bootstrap image must remain a true no-reference/no-profile definition.
  const generationVisualProfile =
    body.bootstrapIdentity || identityExperimentRun ? null : visualProfile;
  const canonicalReferenceManifest = activeReferenceSet
    ? activeReferenceSet.references.map((reference) => ({
        mediaAssetId: reference.mediaAssetId,
        position: reference.position,
        role: reference.role,
        weight: reference.weight,
        selectorVersion: reference.selectorVersion,
        selectionReason: reference.selectionReason,
        qualityScore: reference.qualityScore,
        identityScore: reference.identityScore,
        referenceSetRevisionId: activeReferenceSet.id,
        referenceSetRevision: activeReferenceSet.revision,
        snapshotHash: activeReferenceSet.snapshotHash,
      }))
    : [];
  // Source intent is a role, not an asset-identity distinction. The same
  // approved asset may intentionally occupy both a canonical identity slot
  // and the source_image slot for a More-like request.
  const variationSourceCount = additionalReferenceAssets.length;
  const sourceVariationAuthority = generationSourceVariationAuthority({
    routeFingerprint: generationRouteAuthority?.routeFingerprint ?? null,
    routeQualified: generationRouteAuthority !== null,
    workflow,
    qualificationWorkflowVersion: workflowVersion,
    profileCapabilities,
    canonicalReferenceRoles: canonicalReferenceManifest.map(
      (reference) => reference.role,
    ),
    sourceReferenceCount: variationSourceCount,
  });
  if (
    variationSourceCount > 0 &&
    !identityExperimentRun &&
    !sourceVariationAuthority.ready
  ) {
    throw Errors.conflict(
      "The current qualified route cannot create a More-like variation from this Character asset",
      {
        sourceVariationAuthority,
        workflowKey,
        deepLink: `/admin/characters/${body.targetId}?tab=visual`,
      },
    );
  }
  const nextReferencePosition = Math.max(
    -1,
    ...canonicalReferenceManifest.map((reference) => reference.position),
  ) + 1;
  const sourceReferenceManifest = additionalReferenceAssets
    .map((asset, index) => ({
      mediaAssetId: asset.id,
      position: nextReferencePosition + index,
      role: "source_image",
      weight: identityExperimentRun
        ? body.identityExperiment?.strength ?? 0.65
        : body.consistencyMode === "strict"
          ? 0.9
          : body.consistencyMode === "creative"
            ? 0.7
            : 0.8,
      selectorVersion: activeReferenceSet?.selectorVersion ?? "operator-source-v1",
      selectionReason: identityExperimentRun
        ? "Operator-selected visual identity calibration source"
        : "Operator-selected identity-consistent variation source",
      sourceJobId: asset.sourceJob?.id ?? null,
      referenceSetRevisionId: activeReferenceSet?.id ?? null,
      referenceSetRevision: activeReferenceSet?.revision ?? null,
      snapshotHash: activeReferenceSet?.snapshotHash ?? null,
    }));
  const referenceManifest = [
    ...canonicalReferenceManifest,
    ...sourceReferenceManifest,
  ];
  const referenceAssetIds = referenceManifest.map((reference) => reference.mediaAssetId);
  if (
    workflow &&
    referenceAssetIds.length > workflow.identity.maxReferences
  ) {
    throw Errors.conflict("The selected identity route cannot accept the required reference set", {
      referenceCount: referenceAssetIds.length,
      maxReferences: workflow.identity.maxReferences,
      workflowKey,
    });
  }
  const controls = {
    ...productionControls({
      orientation,
      dimensions,
      profile,
      presets,
      visualProfile: generationVisualProfile,
      consistencyMode: body.consistencyMode,
      referenceAssetIds,
      workflowIdentity: workflow?.identity,
      generationRouteFingerprint: generationRouteAuthority?.routeFingerprint,
    }),
    ...(identityExperimentRun && body.identityExperiment?.sourceAssetId
      ? {
          sourceImageAssetId: body.identityExperiment.sourceAssetId,
          strength: body.identityExperiment.strength,
        }
      : {}),
  };
  const perItemCostDreamcoins = await generationCostDreamcoins(
    "image",
    1,
    profile.costMultiplier ?? 1,
  );
  const workItems = body.directions
    ? body.directions.flatMap((direction) => Array.from(
        { length: body.outputsPerDirection ?? 1 },
        (_, variantIndex) => ({ direction, variantIndex }),
      ))
    : Array.from(
        { length: body.count },
        (_, variantIndex) => ({ direction: null, variantIndex }),
      );
  const totalOutputCount = workItems.length;

  let replayed = false;
  const batch = await auditedTransaction("content.production.batch.create", async (tx) => {
    if (idempotencyKey) {
      await tx.$queryRaw`SELECT 1::int AS locked FROM pg_advisory_xact_lock(hashtext(${`${commandScope}:${idempotencyKey}`}))`;
      const existing = await tx.controlPlaneCommand.findUnique({
        where: { scope_idempotencyKey: { scope: commandScope, idempotencyKey } },
      });
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw Errors.conflict("Idempotency key was reused with a different Creative Run brief", {
            commandId: existing.id,
          });
        }
        const result = existing.result && typeof existing.result === "object" && !Array.isArray(existing.result)
          ? existing.result as Record<string, unknown>
          : {};
        if (existing.status !== "succeeded" || typeof result.batchId !== "string") {
          throw Errors.conflict("The original Creative Run create command has not completed", {
            commandId: existing.id,
            status: existing.status,
          });
        }
        replayed = true;
        return tx.contentProductionBatch.findUniqueOrThrow({
          where: { id: result.batchId },
          include: productionBatchInclude,
        });
      }
    }
    if (body.targetType === "character" && body.targetId) {
      await lockCharacterGenerationAndMediaAssetAuthorities(
        tx,
        body.targetId,
        referenceAssetIds,
      );
      const lockedCharacter = await tx.character.findFirst({
        where: {
          id: body.targetId,
          deletedAt: null,
          status: { notIn: ["archived", "removed"] },
        },
        select: { id: true },
      });
      if (!lockedCharacter) {
        throw Errors.conflict(
          "Character was archived before the Creative Run could pin production authority",
          {
            characterId: body.targetId,
            deepLink: `/admin/characters/${body.targetId}?tab=assets`,
          },
        );
      }
    }
    let verifiedBootstrapAuthority = bootstrapAuthority;
    let verifiedIdentityBootstrapAuthority = identityBootstrapAuthority;
    if (body.bootstrapIdentity && body.targetId) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`character-identity-bootstrap:${body.targetId}`}))`;
      if (bootstrapAuthority) {
        await tx.$queryRaw`
          SELECT "id"
          FROM "character_projects"
          WHERE "id" = ${bootstrapAuthority.projectId}
          FOR UPDATE
        `;
      }
      const [currentBootstrapAuthority, currentIdentityBootstrapAuthority] = await Promise.all([
        resolveProductionBootstrapAuthority(tx, body.targetId, body.brief ?? null),
        loadCharacterIdentityBootstrapAuthority(tx, body.targetId),
      ]);
      const existingBootstrapJob = await tx.generationJob.findFirst({
        where: {
          characterId: body.targetId,
          sourceMeta: { path: ["bootstrapIdentity"], equals: true },
          status: { in: ["queued", "moderating_input", "running", "moderating_output"] },
        },
        select: { id: true, sourceId: true, status: true },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });
      if (
        existingBootstrapJob ||
        !currentBootstrapAuthority ||
        !currentIdentityBootstrapAuthority.allowed ||
        currentBootstrapAuthority.projectId !== bootstrapAuthority?.projectId ||
        currentBootstrapAuthority.projectVersion !== bootstrapAuthority?.projectVersion ||
        currentBootstrapAuthority.characterContentVersionId !== bootstrapAuthority?.characterContentVersionId ||
        currentBootstrapAuthority.visualBriefHash !== bootstrapAuthority?.visualBriefHash ||
        currentIdentityBootstrapAuthority.state !== identityBootstrapAuthority?.state ||
        currentIdentityBootstrapAuthority.nextVersion !== identityBootstrapAuthority?.nextVersion ||
        currentIdentityBootstrapAuthority.historyFingerprint !== identityBootstrapAuthority?.historyFingerprint
      ) {
        throw Errors.conflict(
          "Character identity authority changed before the first-portrait Run was committed",
          {
            deepLink: `/admin/characters/${body.targetId}?tab=assets`,
            blockers: currentIdentityBootstrapAuthority.blockers,
            existingBootstrapJob,
          },
        );
      }
      verifiedBootstrapAuthority = currentBootstrapAuthority;
      verifiedIdentityBootstrapAuthority = currentIdentityBootstrapAuthority;
    } else if (identityExperimentRun && body.targetId) {
      const currentProfile = await tx.generationModelProfile.findUnique({
        where: { id: profile.id },
        select: {
          profileKey: true,
          version: true,
          status: true,
          enabled: true,
          runnerConfig: true,
        },
      });
      if (
        !currentProfile ||
        currentProfile.profileKey !== profile.profileKey ||
        currentProfile.version !== profile.version ||
        currentProfile.status !== "active" ||
        !currentProfile.enabled
      ) {
        throw Errors.conflict(
          "The identity calibration route changed before the Run was committed",
        );
      }
      const currentSource = body.identityExperiment?.sourceAssetId
        ? await tx.mediaAsset.findFirst({
            where: operationalMediaAssetWhere({
              id: body.identityExperiment.sourceAssetId,
              type: "image",
              safetyStatus: "passed",
              deletedAt: null,
              characterId: body.targetId,
            }),
            select: {
              id: true,
              metadata: true,
              sourceJob: { select: { seed: true } },
            },
          })
        : null;
      if (
        body.identityExperiment?.sourceAssetId &&
        (
          !currentSource ||
          !isMediaAssetOperationalForAuthority(currentSource.metadata) ||
          (
            body.identityExperiment.seedStrategy === "reuse_source" &&
            !currentSource.sourceJob?.seed
          )
        )
      ) {
        throw Errors.conflict(
          "The identity calibration source changed before the Run was committed",
        );
      }
    } else if (body.targetType === "character" && body.targetId) {
      if (!visualProfile || !activeReferenceSet) {
        throw Errors.conflict("Character generation authority disappeared before the Run was committed", {
          deepLink: `/admin/characters/${body.targetId}?tab=visual`,
        });
      }
      const currentVisualProfile = await resolveProductionVisualProfile(
        tx,
        "character",
        body.targetId,
      );
      const currentReferenceSet = await resolveProductionReferenceSet(tx, visualProfile.id);
      const currentProfile = await tx.generationModelProfile.findUnique({
        where: { id: profile.id },
        select: {
          id: true,
          profileKey: true,
          version: true,
          status: true,
          enabled: true,
          runnerConfig: true,
        },
      });
      const currentContent = await tx.characterContentVersion.findFirst({
        where: { characterId: body.targetId },
        orderBy: { version: "desc" },
        select: { id: true, version: true },
      });
      const currentAdditionalReferenceAssets = body.referenceAssetIds.length > 0
        ? await tx.mediaAsset.findMany({
            where: operationalMediaAssetWhere({
              id: { in: body.referenceAssetIds },
              type: "image",
              safetyStatus: "passed",
              deletedAt: null,
              characterId: body.targetId,
            }),
            select: {
              id: true,
              characterId: true,
              sourceJob: {
                select: {
                  id: true,
                  sourceType: true,
                  sourceId: true,
                  visualProfileId: true,
                  visualProfileVersion: true,
                  referenceSetRevisionId: true,
                },
              },
            },
          })
        : [];
      const currentRequiredRouteReferenceRoles = [
        ...(currentReferenceSet?.references.map(
          (reference) => reference.role,
        ) ?? []),
        ...currentAdditionalReferenceAssets.map(
          () => "source_image" as const,
        ),
      ];
      const currentQualifiedRoute = routeEvaluationRun
        ? null
        : await ensureOperationalGenerationRoute(tx, {
            style: visualProfile.style,
            policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
            evaluatorVersion: env.GENERATION_ROUTE_EVALUATOR_VERSION,
            at: new Date(),
            requiredReferenceCount: currentRequiredRouteReferenceRoles.length,
            requiredReferenceRoles: currentRequiredRouteReferenceRoles,
          });
      const currentCanonicalReferenceIds = currentReferenceSet?.references
        .map((reference) => reference.mediaAssetId) ?? [];
      const preflightCanonicalReferenceIds = activeReferenceSet.references
        .map((reference) => reference.mediaAssetId);
      const identityAuthorityChanged =
        !currentVisualProfile ||
        currentVisualProfile.id !== visualProfile.id ||
        currentVisualProfile.version !== visualProfile.version ||
        currentVisualProfile.immutableHash !== visualProfile.immutableHash ||
        currentVisualProfile.immutableHash !== characterVisualProfileSnapshotHash(currentVisualProfile) ||
        !currentReferenceSet ||
        currentReferenceSet.id !== activeReferenceSet.id ||
        currentReferenceSet.revision !== activeReferenceSet.revision ||
        currentReferenceSet.snapshotHash !== activeReferenceSet.snapshotHash ||
        currentReferenceSet.snapshotHash !== referenceSetSnapshotHash(currentReferenceSet) ||
        currentCanonicalReferenceIds.length === 0 ||
        currentCanonicalReferenceIds.length !== preflightCanonicalReferenceIds.length ||
        currentCanonicalReferenceIds.some((id, index) => id !== preflightCanonicalReferenceIds[index]) ||
        currentReferenceSet.references.some((reference) =>
          reference.mediaAsset.deletedAt !== null ||
          reference.mediaAsset.type !== "image" ||
          reference.mediaAsset.safetyStatus !== "passed" ||
          !isMediaAssetOperationalForAuthority(reference.mediaAsset.metadata) ||
          reference.mediaAsset.characterId !== body.targetId
        );
      const profileChanged =
        !currentProfile ||
        currentProfile.profileKey !== profile.profileKey ||
        currentProfile.version !== profile.version ||
        currentProfile.status !== "active" ||
        !currentProfile.enabled;
      const routeChanged = profileChanged || (
        !routeEvaluationRun && (
          !currentQualifiedRoute ||
          currentQualifiedRoute.routeFingerprint !== generationRouteAuthority?.routeFingerprint ||
          currentQualifiedRoute.generationProfileKey !== profile.profileKey ||
          currentQualifiedRoute.generationProfileVersion !== profile.version ||
          currentQualifiedRoute.workflowKey !== workflowKey ||
          currentQualifiedRoute.workflowVersion !== workflowVersion
        )
      );
      const pinnedContentId =
        target?.type === "character" ? target.contentVersionId : null;
      const pinnedContentVersion =
        target?.type === "character" ? target.contentVersion : null;
      const contentChanged =
        (currentContent?.id ?? null) !== pinnedContentId ||
        (currentContent?.version ?? null) !== pinnedContentVersion;
      const currentSourceVariationAuthority =
        generationSourceVariationAuthority({
          routeFingerprint: currentQualifiedRoute?.routeFingerprint ?? null,
          routeQualified: !routeChanged,
          workflow,
          qualificationWorkflowVersion: workflowVersion,
          profileCapabilities: generationProfileCapabilities(
            currentProfile?.runnerConfig ?? null,
          ),
          canonicalReferenceRoles:
            currentReferenceSet?.references.map((reference) => reference.role) ??
            [],
          sourceReferenceCount: currentAdditionalReferenceAssets.length,
        });
      const sourceRuntimeChanged =
        variationSourceCount > 0 &&
        !currentSourceVariationAuthority.ready;
      if (
        identityAuthorityChanged ||
        routeChanged ||
        contentChanged ||
        sourceRuntimeChanged
      ) {
        throw Errors.conflict("Character generation authority changed before the Run was committed", {
          identityAuthorityChanged,
          routeChanged,
          contentChanged,
          sourceRuntimeChanged,
          sourceVariationAuthority: currentSourceVariationAuthority,
          deepLink: `/admin/characters/${body.targetId}?tab=assets`,
        });
      }
      if (currentQualifiedRoute) {
        generationRouteAuthority = {
          qualificationId: currentQualifiedRoute.id,
          routeFingerprint: currentQualifiedRoute.routeFingerprint,
        };
      }
      const currentSourceItems = currentAdditionalReferenceAssets.map((asset) => ({
        assetId: asset.id,
        itemId: asset.sourceJob?.sourceType === "content_production_item"
          ? asset.sourceJob.sourceId
          : null,
        sourceJob: asset.sourceJob,
      }));
      const currentSourceDecisions = currentSourceItems.length > 0
        ? await tx.creativeReviewDecision.findMany({
            where: {
              runItemId: {
                in: currentSourceItems.flatMap((source) => source.itemId ? [source.itemId] : []),
              },
            },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          })
        : [];
      const currentLatestDecisionByItemId = new Map<string, (typeof currentSourceDecisions)[number]>();
      for (const decision of currentSourceDecisions) {
        if (!currentLatestDecisionByItemId.has(decision.runItemId)) {
          currentLatestDecisionByItemId.set(decision.runItemId, decision);
        }
      }
      const sourceAuthorityChanged =
        currentAdditionalReferenceAssets.length !== additionalReferenceAssets.length ||
        currentSourceItems.some((source) => {
          if (
            !source.itemId ||
            source.sourceJob?.visualProfileId !== visualProfile.id ||
            source.sourceJob.visualProfileVersion !== visualProfile.version ||
            source.sourceJob.referenceSetRevisionId !== activeReferenceSet.id
          ) return true;
          const decision = currentLatestDecisionByItemId.get(source.itemId);
          return decision?.artifactId !== source.assetId || decision.decision !== "approved";
        });
      if (sourceAuthorityChanged) {
        throw Errors.conflict("Variation source authority changed before the Run was committed", {
          deepLink: `/admin/characters/${body.targetId}?tab=assets`,
        });
      }
    }
    const createdBatch = await tx.contentProductionBatch.create({
      data: {
        title,
        purpose: body.purpose,
        targetType: body.targetType,
        targetId: body.targetId ?? null,
        profileId: profile.profileKey,
        profileVersion: profile.version,
        recipeId: recipe.recipeKey,
        recipeVersion: recipe.version,
        presetIds: toInputJson(body.presetIds),
        orientation,
        brief: body.brief ?? null,
        count: totalOutputCount,
        totalItems: totalOutputCount,
        estimatedCostDreamcoins: perItemCostDreamcoins * totalOutputCount,
        status: "queued",
        ownerId: actor.id,
        dueAt: parseOptionalDate(body.dueAt),
        priority: body.priority,
        lifecycleState: "active",
        workflowStage: "generation",
        verificationState: "pending",
        createdById: actor.id,
      },
    });

    for (let itemIndex = 0; itemIndex < workItems.length; itemIndex += 1) {
      const { direction, variantIndex } = workItems[itemIndex];
      const directionSnapshot = direction ? toInputJson(direction) : undefined;
      const directionHash = direction ? canonicalSha256(direction) : null;
      const directionBrief = direction
        ? [
            body.brief,
            `Direction: ${direction.title}`,
            `Scene: ${direction.scenePrompt}`,
            `Mood: ${direction.mood}`,
            `Setting: ${direction.setting}`,
            `Outfit: ${direction.outfit}`,
            `Camera: ${direction.camera}`,
            `Lighting: ${direction.lighting}`,
          ].filter(Boolean).join("\n")
        : body.brief;
      const prompt = productionPrompt({
        purpose: body.purpose,
        target,
        recipeBody: recipe.body,
        presetFragment,
        brief: directionBrief,
        visualProfile: generationVisualProfile,
        consistencyMode: body.consistencyMode,
      });
      const item = await tx.contentProductionItem.create({
        data: {
          batchId: createdBatch.id,
          itemIndex,
          directionId: direction?.id,
          directionSnapshot,
          directionHash,
          status: "queued",
          tags: [],
        },
      });
      const job = await tx.generationJob.create({
        data: {
          userId: actor.id,
          characterId: body.targetType === "character" ? body.targetId ?? null : null,
          visualProfileId: generationVisualProfile?.id,
          visualProfileVersion: generationVisualProfile?.version,
          consistencyMode: generationVisualProfile ? body.consistencyMode : null,
          seed: identityExperimentRun && body.identityExperiment
            ? identityExperimentCandidateSeed({
                strategy: body.identityExperiment.seedStrategy,
                baseSeed: body.identityExperiment.baseSeed,
                sourceSeed: additionalReferenceAssets[0]?.sourceJob?.seed,
                batchId: createdBatch.id,
                variantIndex,
              })
            : productionCandidateSeed({
                baseSeed: generationVisualProfile?.defaultSeed,
                batchId: createdBatch.id,
                directionId: direction?.id ?? null,
                variantIndex,
              }),
          referenceAssetIds: referenceAssetIds.length > 0 ? toInputJson(referenceAssetIds) : undefined,
          referenceSetRevisionId: activeReferenceSet?.id,
          referenceManifest: referenceManifest.length > 0 ? toInputJson(referenceManifest) : undefined,
          mode: "image",
          prompt,
          negativePrompt: productionNegativePrompt(
            recipe.negativeBase,
            identityExperimentRun
              ? body.identityExperiment?.negativePrompt
              : generationVisualProfile?.negativeIdentityPrompt,
            body.purpose,
          ),
          controls: toInputJson(controls),
          presetIds: toInputJson(body.presetIds),
          model: workflowKey,
          profileId: profile.profileKey,
          profileVersion: profile.version,
          recipeId: recipe.recipeKey,
          recipeVersion: recipe.version,
          orientation,
          outputCount: 1,
          status: "queued",
          costDreamcoins: perItemCostDreamcoins,
          provider: profile.runner,
          sourceType: "content_production_item",
          sourceId: item.id,
          sourceMeta: toInputJson({
            batchId: createdBatch.id,
            purpose: body.purpose,
            targetType: body.targetType,
            targetId: body.targetId ?? null,
            itemIndex,
            directionId: direction?.id ?? null,
            directionHash,
            variantIndex,
            consistencyMode: visualProfile ? body.consistencyMode : null,
            bootstrapIdentity: body.bootstrapIdentity,
            bootstrapProjectVersion: verifiedBootstrapAuthority?.projectVersion ?? null,
            characterContentVersionId:
              verifiedBootstrapAuthority?.characterContentVersionId ??
              (target?.type === "character" ? target.contentVersionId : null),
            visualBriefHash: verifiedBootstrapAuthority?.visualBriefHash ?? null,
            bootstrapAuthorityState: verifiedIdentityBootstrapAuthority?.state ?? null,
            expectedIdentityHistoryFingerprint:
              verifiedIdentityBootstrapAuthority?.historyFingerprint ?? null,
            expectedIdentityVersion: verifiedIdentityBootstrapAuthority?.nextVersion ?? null,
            referenceSetRevisionId: activeReferenceSet?.id ?? null,
            generationRouteQualificationId: generationRouteAuthority?.qualificationId ?? null,
            generationRouteFingerprint: generationRouteAuthority?.routeFingerprint ?? null,
            routeQualificationEvaluationCandidate: routeEvaluationRun,
            routeQualificationMatrixKey:
              routeEvaluationRun ? body.routeEvaluationMatrixKey ?? null : null,
            routeQualificationMatrixSchemaVersion:
              routeEvaluationRun
                ? characterRouteEvaluationMatrixSchemaVersion
                : null,
            routeQualificationPolicyVersion:
              routeEvaluationRun ? CHARACTER_RELEASE_POLICY_VERSION : null,
            routeQualificationEvaluatorVersion:
              routeEvaluationRun ? env.GENERATION_ROUTE_EVALUATOR_VERSION : null,
            identityExperiment: identityExperimentRun && body.identityExperiment
              ? {
                  mode: body.identityExperiment.mode,
                  positivePrompt: body.brief ?? "",
                  negativePrompt: body.identityExperiment.negativePrompt,
                  seedStrategy: body.identityExperiment.seedStrategy,
                  baseSeed: body.identityExperiment.baseSeed ?? null,
                  sourceAssetId: body.identityExperiment.sourceAssetId ?? null,
                  strength: body.identityExperiment.strength,
                }
              : null,
          }),
        },
      });
      await tx.contentProductionItem.update({
        where: { id: item.id },
        data: { jobId: job.id },
      });
      await appendProductionJobEvent(tx, job.id, "created", "Content production job accepted", {
        batchId: createdBatch.id,
        itemId: item.id,
        purpose: body.purpose,
      });
      await appendProductionJobEvent(tx, job.id, "queued", "Content production job queued", {});
      const attempt = await tx.generationAttempt.create({
        data: {
          requestId: job.id,
          attemptNo: 1,
          provider: job.provider,
          profileKey: job.profileId,
          profileVersion: job.profileVersion,
          workflowKey,
          workflowVersion,
          status: "queued",
          creativeRunItemId: item.id,
        },
      });
      await recordGenerationAttemptQueuedEvent(tx, attempt);
      await tx.mainOutboxEvent.create({
        data: {
          id: `creative_initial_${createdBatch.id}_${item.id}`,
          eventType: "creative.generation.dispatch.v2",
          aggregateType: "creative_run",
          aggregateId: createdBatch.id,
          payload: toInputJson({
            runId: createdBatch.id,
            itemId: item.id,
            generationJobId: job.id,
            attemptId: attempt.id,
            attemptNo: attempt.attemptNo,
          }),
        },
      });
    }

    await refreshContentProductionBatchStats(tx, createdBatch.id);
    if (idempotencyKey) {
      await tx.controlPlaneCommand.create({
        data: {
          scope: commandScope,
          idempotencyKey,
          commandType: "creative.run.create",
          targetType: "creative_run",
          targetId: createdBatch.id,
          actorId: actor.id,
          requestId: request.headers.get("x-request-id") ?? crypto.randomUUID(),
          requestHash,
          requestPayload: toInputJson(body),
          retryMode: "idempotent",
          status: "succeeded",
          result: toInputJson({ batchId: createdBatch.id }),
          finishedAt: new Date(),
        },
      });
    }
    await tx.adminAuditLog.create({
      data: {
        actorId: actor.id,
        actorRole: actor.role,
        action: "content.production.batch.create",
        targetType: "content_production_batch",
        targetId: createdBatch.id,
        reason: body.reason,
        after: toInputJson({
          purpose: createdBatch.purpose,
          count: createdBatch.totalItems,
          profileId: createdBatch.profileId,
          recipeId: createdBatch.recipeId,
        }),
        requestId: request.headers.get("x-request-id"),
      },
    });
    return tx.contentProductionBatch.findUniqueOrThrow({
      where: { id: createdBatch.id },
      include: productionBatchInclude,
    });
  });
  if (!replayed) {
    await dispatchCreativeRetryOutbox(prisma, {
      limit: totalOutputCount,
      outboxIds: batch.items.map((item) => `creative_initial_${batch.id}_${item.id}`),
    });
  }
  const mediaAuthorityById = await productionBatchMediaAuthority([batch]);
  return ok(
    { batch: productionBatchDTO(batch, [], mediaAuthorityById), replayed },
    { status: replayed ? 200 : 202 },
  );
}

export async function createProductionBatch(request: Request) {
  const actor = await actorWithPermission(request, "content.production.write");
  const body = productionBatchCreateSchema.parse(await jsonBody(request));
  return createProductionBatchCore(request, actor, body);
}

export async function getProductionBatch(request: Request, id: string) {
  await actorWithPermission(request, "content.asset.read");
  const batch = await prisma.contentProductionBatch.findUnique({
    where: { id },
    include: productionBatchInclude,
  });
  if (!batch) throw Errors.notFound("Production batch not found");
  const [ledgerEntries, mediaAuthorityById] = await Promise.all([
    productionBatchLedgerEntries([batch]),
    productionBatchMediaAuthority([batch]),
  ]);
  return ok({
    batch: productionBatchDTO(batch, ledgerEntries, mediaAuthorityById),
  });
}

export async function approveProductionItem(request: Request, id: string): Promise<Response> {
  await actorWithPermission(request, "content.asset.review");
  const body = itemReviewSchema.parse(await jsonBody(request));
  if (body.confirmation !== id) {
    throw Errors.badRequest("Confirmation did not match production item");
  }
  const item = await prisma.contentProductionItem.findUnique({
    where: { id },
    select: { batchId: true },
  });
  if (!item) throw Errors.notFound("Production item not found");
  throw Errors.conflict("Legacy item approval is disabled; record an immutable Creative Run decision", {
    code: "creative_run_review_required",
    repairPath: `/admin/creative/runs/${item.batchId}`,
  });
}

export async function rejectProductionItem(request: Request, id: string): Promise<Response> {
  await actorWithPermission(request, "content.asset.review");
  const body = itemReviewSchema.parse(await jsonBody(request));
  if (body.confirmation !== id) {
    throw Errors.badRequest("Confirmation did not match production item");
  }
  const item = await prisma.contentProductionItem.findUnique({
    where: { id },
    select: { batchId: true },
  });
  if (!item) throw Errors.notFound("Production item not found");
  throw Errors.conflict("Legacy item rejection is disabled; record an immutable Creative Run decision", {
    code: "creative_run_review_required",
    repairPath: `/admin/creative/runs/${item.batchId}`,
  });
}

export async function regenerateProductionItem(request: Request, id: string): Promise<Response> {
  await actorWithPermission(request, "content.production.write");
  const body = itemRegenerateSchema.parse(await jsonBody(request));
  if (body.confirmation !== id) {
    throw Errors.badRequest("Confirmation did not match production item");
  }
  const sourceItem = await prisma.contentProductionItem.findUnique({
    where: { id },
    select: { batchId: true },
  });
  if (!sourceItem) throw Errors.notFound("Production item not found");
  throw Errors.conflict(
    "Legacy item regeneration is disabled; retry the frozen failed set through the Creative Run command",
    {
      code: "creative_run_command_required",
      repairPath: `/admin/creative/runs/${sourceItem.batchId}`,
    },
  );
}

export async function listContentAssets(request: Request) {
  await actorWithPermission(request, "creative.asset.read");
  const url = new URL(request.url);
  const status = url.searchParams.get("status")?.trim() || undefined;
  const productionItemStatus = status === "archived" ? undefined : status;
  const purpose = productionPurposeSchema.safeParse(url.searchParams.get("purpose")).data;
  const profileId = url.searchParams.get("profileId")?.trim() || undefined;
  const targetId = url.searchParams.get("targetId")?.trim() || undefined;
  const tag = url.searchParams.get("tag")?.trim();
  const search = url.searchParams.get("search")?.trim().toLowerCase() || undefined;
  const limit = clampInt(url.searchParams.get("limit"), 1, 100, 25);
  const queryIdentity = { status, purpose, profileId, targetId, tag, search, sort: "created_desc" };
  const cursorKeys = url.searchParams.get("cursor")
    ? decodeAdminListCursor(url.searchParams.get("cursor")!, "content_assets", queryIdentity)
    : null;
  const [cursorAt, cursorId] = cursorKeys
    ? [parseIsoCursorKey(cursorKeys[0], "content_assets"), z.string().min(1).parse(cursorKeys[1])]
    : [null, null];
  const productionAssetScope: Prisma.MediaAssetWhereInput = {
    productionItems: { some: { status: productionItemStatus, batch: { purpose, targetId } } },
  };
  const standalonePlatformAssetScope: Prisma.MediaAssetWhereInput | null = targetId
    ? null
    : {
        productionItems: { none: {} },
        AND: [
          {
            OR: (status ? [status] : assetReviewStatusSchema.options).map((platformStatus) => ({
              metadata: {
                path: ["platformAsset", "status"],
                equals: platformStatus,
              },
            })),
          },
          ...(purpose
            ? [{
                metadata: {
                  path: ["platformAsset", "purpose"],
                  equals: purpose,
                },
              }]
            : []),
        ],
      };
  const assetAuthorityScopes = [
    productionAssetScope,
    ...(standalonePlatformAssetScope ? [standalonePlatformAssetScope] : []),
  ];
  const matches: ContentAssetWithRelations[] = [];
  const batchSize = 100;
  let scanAt = cursorAt;
  let scanId = cursorId;
  let exhausted = false;
  while (matches.length <= limit && !exhausted) {
    const baseAssets = await prisma.mediaAsset.findMany({
      where: operationalMediaAssetWhere({
        type: "image",
        deletedAt: null,
        sourceJob: profileId ? { profileId } : undefined,
        AND: [
          { OR: assetAuthorityScopes },
          ...(scanAt && scanId
            ? [{ OR: [{ createdAt: { lt: scanAt } }, { createdAt: scanAt, id: { lt: scanId } }] }]
            : []),
        ],
      }),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: batchSize,
    });
    if (baseAssets.length === 0) {
      exhausted = true;
      break;
    }
    const assets = await hydrateContentAssets(prisma, baseAssets);
    for (const asset of assets) {
      const metadata = platformAssetMetadata(asset);
      const tags = assetTags(asset);
      if (status === "archived" && metadata.status !== "archived") continue;
      if (status && status !== "archived" && metadata.status === "archived") continue;
      if (tag && !tags.includes(tag)) continue;
      if (search) {
        const dto = contentAssetDTO(asset);
        const haystack = [dto.id, dto.description ?? "", dto.purpose ?? "", dto.targetId ?? "", ...dto.tags].join(" ").toLowerCase();
        if (!haystack.includes(search)) continue;
      }
      matches.push(asset);
    }
    const last = baseAssets.at(-1)!;
    scanAt = last.createdAt;
    scanId = last.id;
    exhausted = assets.length < batchSize;
  }
  const page = matches.slice(0, limit);
  const hasNextPage = matches.length > limit || !exhausted;
  const last = page.at(-1);
  const mediaAuthorityById = await resolveMediaAssetAuthorityMap(prisma, page);
  return ok({
    items: page.map((asset) =>
      contentAssetDTO(asset, mediaAuthorityById.get(asset.id)),
    ),
    pageInfo: {
      endCursor: hasNextPage && last
        ? encodeAdminListCursor("content_assets", queryIdentity, [last.createdAt.toISOString(), last.id])
        : null,
      hasNextPage,
    },
    asOf: new Date().toISOString(),
    freshness: "fresh",
  });
}

async function assertAssetLibraryMutationAllowed(
  db: Prisma.TransactionClient,
  assetId: string,
  status: z.infer<typeof assetReviewStatusSchema> | undefined,
) {
  if (status && status !== "archived") {
    const item = await db.contentProductionItem.findUnique({
      where: { mediaAssetId: assetId },
      select: { batchId: true },
    });
    throw Errors.conflict(
      "Image Library cannot create or replace Creative review authority",
      {
        code: "creative_run_review_required",
        repairPath: item ? `/admin/creative/runs/${item.batchId}` : "/admin/creative/runs",
      },
    );
  }
  if (status !== "archived") return;
  const dependencies = await mediaAssetAuthorityDependencies(db, assetId);
  if (dependencies.length > 0) {
    throw Errors.conflict(
      "A live or staged authority must be rolled back or replaced before this asset can be archived",
      {
        code: "asset_authority_dependency_active",
        assetId,
        dependencies,
        repairPath: dependencies[0]?.repairPath ?? "/admin/creative/runs",
      },
    );
  }
}

async function assertAssetLibraryMutationsAllowed(
  db: Prisma.TransactionClient,
  assetIds: readonly string[],
  status: z.infer<typeof assetReviewStatusSchema> | undefined,
) {
  if (status && status !== "archived") {
    const item = await db.contentProductionItem.findFirst({
      where: { mediaAssetId: { in: [...assetIds] } },
      select: { mediaAssetId: true, batchId: true },
    });
    throw Errors.conflict(
      "Image Library cannot create or replace Creative review authority",
      {
        code: "creative_run_review_required",
        assetId: item?.mediaAssetId ?? assetIds[0],
        repairPath: item ? `/admin/creative/runs/${item.batchId}` : "/admin/creative/runs",
      },
    );
  }
  if (status !== "archived") return;
  const dependenciesByAssetId = await mediaAssetAuthorityDependenciesBatch(
    db,
    assetIds,
  );
  for (const assetId of assetIds) {
    const dependencies = dependenciesByAssetId.get(assetId) ?? [];
    if (dependencies.length === 0) continue;
    throw Errors.conflict(
      "A live or staged authority must be rolled back or replaced before this asset can be archived",
      {
        code: "asset_authority_dependency_active",
        assetId,
        dependencies,
        repairPath: dependencies[0]?.repairPath ?? "/admin/creative/runs",
      },
    );
  }
}

function missingOrDeletedAssetIds(
  requestedAssetIds: readonly string[],
  assets: readonly { id: string; deletedAt: Date | null }[],
) {
  const availableAssetIds = new Set(
    assets
      .filter((asset) => asset.deletedAt === null)
      .map((asset) => asset.id),
  );
  return requestedAssetIds.filter((assetId) => !availableAssetIds.has(assetId));
}

export async function getContentAsset(request: Request, id: string) {
  await actorWithPermission(request, "creative.asset.read");
  const baseAsset = await prisma.mediaAsset.findFirst({
    where: operationalMediaAssetWhere({ id, deletedAt: null }),
  });
  if (!baseAsset) throw Errors.notFound("Content asset not found");
  const [asset] = await hydrateContentAssets(prisma, [baseAsset]);
  if (!asset) throw Errors.notFound("Content asset not found");
  const authority = (
    await resolveMediaAssetAuthorityMap(prisma, [asset])
  ).get(asset.id);
  return ok({
    asset: {
      ...contentAssetDTO(asset, authority),
      authorityDependencies: await mediaAssetAuthorityDependencies(prisma, id),
    },
  });
}

export async function patchContentAsset(request: Request, id: string) {
  const actor = await actorWithPermission(request, "content.asset.review");
  const body = assetPatchSchema.parse(await jsonBody(request));
  if (body.confirmation !== id) {
    throw Errors.badRequest("Confirmation did not match asset");
  }
  const updated = await auditedTransaction("content.asset.update", async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`media-asset-authority:${id}`}))`;
    const asset = await tx.mediaAsset.findFirst({
      where: operationalMediaAssetWhere({ id, deletedAt: null }),
    });
    if (!asset) throw Errors.notFound("Content asset not found");
    await assertAssetLibraryMutationAllowed(tx, id, body.status);
    await patchAssetMetadata(tx, id, {
      status: body.status,
      // Archival is a lifecycle-only action. Never replay metadata from an
      // operator's stale detail-page draft over a newer curator write.
      tags: body.status === "archived" ? undefined : body.tags,
      description: body.status === "archived" ? undefined : body.description,
    });
    const nextBase = await tx.mediaAsset.findUniqueOrThrow({
      where: { id },
    });
    const [next] = await hydrateContentAssets(tx, [nextBase]);
    if (!next) throw Errors.notFound("Content asset not found");
    await tx.adminAuditLog.create({
      data: adminAuditData(request, actor, {
        action: "content.asset.update",
        targetType: "media_asset",
        targetId: id,
        reason: body.reason,
        before: { metadata: asset.metadata },
        after: {
          status: body.status ?? null,
          tags: body.status === "archived" ? null : body.tags ?? null,
        },
      }),
    });
    return next;
  });
  const authority = (
    await resolveMediaAssetAuthorityMap(prisma, [updated])
  ).get(updated.id);
  return ok({ asset: contentAssetDTO(updated, authority) });
}

export async function preflightContentAssetArchive(request: Request) {
  await actorWithPermission(request, "content.asset.review");
  const body = assetBulkPreflightSchema.parse(await jsonBody(request));
  const requestedAssetIds = [...new Set(body.assetIds)].sort();
  const assets = await prisma.mediaAsset.findMany({
    where: operationalMediaAssetWhere({
      id: { in: requestedAssetIds },
    }),
    select: { id: true, deletedAt: true },
  });
  const missingAssetIds = missingOrDeletedAssetIds(requestedAssetIds, assets);
  if (missingAssetIds.length > 0) {
    throw Errors.notFound("One or more content assets were not found", {
      missingAssetIds,
    });
  }
  const dependenciesByAssetId = await mediaAssetAuthorityDependenciesBatch(
    prisma,
    requestedAssetIds,
  );
  return ok({
    assetIds: requestedAssetIds,
    blockers: requestedAssetIds.flatMap((assetId) => {
      const dependencies = dependenciesByAssetId.get(assetId) ?? [];
      return dependencies.length > 0 ? [{ assetId, dependencies }] : [];
    }),
  });
}

export async function bulkPatchContentAssets(request: Request) {
  const actor = await actorWithPermission(request, "content.asset.review");
  const body = assetBulkSchema.parse(await jsonBody(request));
  const requestedAssetIds = [...new Set(body.assetIds)].sort();
  const canonicalTargets = requestedAssetIds.length === body.assetIds.length
    && requestedAssetIds.every((assetId, index) => assetId === body.assetIds[index]);
  if (!canonicalTargets) {
    throw Errors.badRequest("Bulk asset targets must be sorted and unique", {
      expectedAssetIds: requestedAssetIds,
    });
  }
  if (body.confirmation !== requestedAssetIds.join(",")) {
    throw Errors.badRequest("Confirmation did not match bulk asset targets");
  }
  const updatedIds = await auditedTransaction("content.asset.bulk_update", async (tx) => {
    for (const assetId of requestedAssetIds) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`media-asset-authority:${assetId}`}))`;
    }
    // The row snapshot is intentionally loaded only after every authority
    // lock is held. A concurrent customer delete/private mutation can finish
    // before the locks are acquired, but can no longer turn this into a
    // partial or misleading success.
    const assets = await tx.mediaAsset.findMany({
      where: operationalMediaAssetWhere({
        id: { in: requestedAssetIds },
      }),
      select: { id: true, deletedAt: true, metadata: true },
    });
    const missingAssetIds = missingOrDeletedAssetIds(requestedAssetIds, assets);
    if (
      assets.length !== requestedAssetIds.length
      || missingAssetIds.length > 0
    ) {
      throw Errors.notFound("One or more content assets were not found", {
        missingAssetIds,
      });
    }
    await assertAssetLibraryMutationsAllowed(tx, requestedAssetIds, body.status);
    for (const asset of assets) {
      await patchAssetMetadata(tx, asset.id, {
        status: body.status,
        tags: body.status === "archived" ? undefined : body.tags,
        description: body.status === "archived" ? undefined : body.description,
      });
    }
    const committedIds = [...requestedAssetIds];
    await tx.adminAuditLog.create({
      data: adminAuditData(request, actor, {
        action: "content.asset.bulk_update",
        targetType: "media_asset_batch",
        targetId: `${committedIds.length} assets`,
        reason: body.reason,
        after: {
          assetIds: committedIds,
          status: body.status ?? null,
          tags: body.tags ?? null,
        },
      }),
    });
    return committedIds;
  });
  return ok({ updatedIds });
}

export async function listPlacements(request: Request) {
  await actorWithPermission(request, "creative.placement.read");
  const url = new URL(request.url);
  const status = url.searchParams.get("status")?.trim() || undefined;
  const slot = placementSlotSchema.safeParse(url.searchParams.get("slot")).data;
  const targetId = url.searchParams.get("targetId")?.trim() || undefined;
  const search = url.searchParams.get("search")?.trim() || undefined;
  const limit = clampInt(url.searchParams.get("limit"), 1, 100, 25);
  const queryIdentity = { status, slot, targetId, search, sort: "created_desc" };
  const cursorKeys = url.searchParams.get("cursor")
    ? decodeAdminListCursor(url.searchParams.get("cursor")!, "placements", queryIdentity)
    : null;
  const [cursorAt, cursorId] = cursorKeys
    ? [parseIsoCursorKey(cursorKeys[0], "placements"), z.string().min(1).parse(cursorKeys[1])]
    : [null, null];
  const placements = await prisma.mediaAssetPlacement.findMany({
    where: operationalMediaAssetPlacementWhere({
      status,
      slot,
      targetId,
      ...(search ? { OR: [
        { id: { contains: search, mode: "insensitive" } },
        { mediaAssetId: { contains: search, mode: "insensitive" } },
        { targetId: { contains: search, mode: "insensitive" } },
        { targetType: { contains: search, mode: "insensitive" } },
        { slot: { contains: search, mode: "insensitive" } },
      ] } : {}),
      ...(cursorAt && cursorId ? { AND: [{ OR: [
        { createdAt: { lt: cursorAt } },
        { createdAt: cursorAt, id: { lt: cursorId } },
      ] }] } : {}),
    }),
    include: placementInclude,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const hasNextPage = placements.length > limit;
  const page = placements.slice(0, limit);
  const last = page.at(-1);
  const mediaAuthorityById = await resolveMediaAssetAuthorityMap(
    prisma,
    page.map((placement) => placement.mediaAsset),
  );
  return ok({
    items: page.map((placement) =>
      placementDTO(
        placement,
        mediaAuthorityById.get(placement.mediaAssetId),
      ),
    ),
    pageInfo: {
      endCursor: hasNextPage && last
        ? encodeAdminListCursor("placements", queryIdentity, [last.createdAt.toISOString(), last.id])
        : null,
      hasNextPage,
    },
    asOf: new Date().toISOString(),
    freshness: "fresh",
  });
}

export async function getPlacement(request: Request, id: string) {
  await actorWithPermission(request, "creative.placement.read");
  const placement = await prisma.mediaAssetPlacement.findFirst({
    where: operationalMediaAssetPlacementWhere({ id }),
    include: placementInclude,
  });
  if (!placement) throw Errors.notFound("Placement not found");
  const authority = (
    await resolveMediaAssetAuthorityMap(prisma, [placement.mediaAsset])
  ).get(placement.mediaAssetId);
  return ok({ placement: placementDTO(placement, authority) });
}

export async function createPlacement(request: Request) {
  const actor = await actorWithPermission(request, "creative.placement.publish");
  const body = placementCreateSchema.parse(await jsonBody(request));
  assertLegacyPlacementAuthority(body.slot, body.status);
  validatePlacementTarget(body.slot, body.targetType);
  const idempotencyKey = requireIdempotencyKey(request);
  const commandScope = `${env.APP_ENV}:${actor.id}:content.placement.create`;
  const requestHash = canonicalSha256({
    commandType: "content.placement.create",
    payload: body,
  });
  const placementIdFromCommand = (command: {
    id: string;
    status: string;
    requestHash: string;
    result: Prisma.JsonValue | null;
  }) => {
    if (command.requestHash !== requestHash) {
      throw Errors.conflict(
        "Idempotency key was reused with a different Placement request",
        { commandId: command.id },
      );
    }
    const result = jsonRecord(command.result);
    if (
      command.status !== "succeeded" ||
      typeof result.placementId !== "string"
    ) {
      throw Errors.conflict(
        "The original Placement create command has not completed",
        { commandId: command.id, status: command.status },
      );
    }
    return result.placementId;
  };
  const existing = await prisma.controlPlaneCommand.findUnique({
    where: {
      scope_idempotencyKey: {
        scope: commandScope,
        idempotencyKey,
      },
    },
  });
  if (existing) {
    const placementId = placementIdFromCommand(existing);
    const replayedPlacement = await prisma.mediaAssetPlacement.findFirst({
      where: operationalMediaAssetPlacementWhere({ id: placementId }),
      include: placementInclude,
    });
    if (!replayedPlacement) {
      throw Errors.conflict(
        "The idempotent Placement result is no longer operational",
        { commandId: existing.id, placementId },
      );
    }
    const authority = (
      await resolveMediaAssetAuthorityMap(prisma, [
        replayedPlacement.mediaAsset,
      ])
    ).get(replayedPlacement.mediaAssetId);
    return ok({
      placement: placementDTO(replayedPlacement, authority),
      replayed: true,
    });
  }
  let replayed = false;
  const placement = await auditedTransaction("content.placement.create", async (tx) => {
    await tx.$queryRaw`SELECT 1::int AS locked FROM pg_advisory_xact_lock(hashtext(${`${commandScope}:${idempotencyKey}`}))`;
    const concurrentExisting = await tx.controlPlaneCommand.findUnique({
      where: {
        scope_idempotencyKey: {
          scope: commandScope,
          idempotencyKey,
        },
      },
    });
    if (concurrentExisting) {
      replayed = true;
      const placementId = placementIdFromCommand(concurrentExisting);
      return tx.mediaAssetPlacement.findFirstOrThrow({
        where: operationalMediaAssetPlacementWhere({ id: placementId }),
        include: placementInclude,
      });
    }
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`media-asset-authority:${body.mediaAssetId}`}))`;
    await assertApprovedAsset(tx, body.mediaAssetId);
    const created = await tx.mediaAssetPlacement.create({
      data: {
        mediaAssetId: body.mediaAssetId,
        slot: body.slot,
        targetType: body.targetType,
        targetId: body.targetId,
        status: body.status,
        createdById: actor.id,
        metadata: toInputJson(body.metadata),
      },
    });
    await tx.adminAuditLog.create({
      data: transactionAuditData(request, actor, {
        action: "content.placement.create",
        targetType: "media_asset_placement",
        targetId: created.id,
        reason: body.reason,
        after: {
          mediaAssetId: created.mediaAssetId,
          slot: created.slot,
          targetType: created.targetType,
          targetId: created.targetId,
          status: created.status,
        },
      }),
    });
    await tx.controlPlaneCommand.create({
      data: {
        scope: commandScope,
        idempotencyKey,
        commandType: "content.placement.create",
        targetType: "media_asset_placement",
        targetId: created.id,
        actorId: actor.id,
        requestId:
          request.headers.get("x-request-id") ?? crypto.randomUUID(),
        requestHash,
        requestPayload: toInputJson(body),
        retryMode: "idempotent",
        status: "succeeded",
        result: toInputJson({ placementId: created.id }),
        finishedAt: new Date(),
      },
    });
    return tx.mediaAssetPlacement.findUniqueOrThrow({
      where: { id: created.id },
      include: placementInclude,
    });
  });
  const authority = (
    await resolveMediaAssetAuthorityMap(prisma, [placement.mediaAsset])
  ).get(placement.mediaAssetId);
  return ok({ placement: placementDTO(placement, authority), replayed });
}

export async function patchPlacement(request: Request, id: string) {
  const actor = await actorWithPermission(request, "creative.placement.publish");
  const body = placementPatchSchema.parse(await jsonBody(request));
  if (body.confirmation !== id) {
    throw Errors.badRequest("Confirmation did not match placement");
  }
  const idempotencyKey = requireIdempotencyKey(request);
  const expectedVersion = requirePlacementVersion(request);
  const commandScope = `${env.APP_ENV}:${actor.id}:content.placement.patch:${id}`;
  const requestHash = canonicalSha256({
    commandType: "content.placement.patch",
    targetId: id,
    expectedVersion,
    payload: body,
  });
  const placementIdFromCommand = (command: {
    id: string;
    status: string;
    requestHash: string;
    result: Prisma.JsonValue | null;
  }) => {
    if (command.requestHash !== requestHash) {
      throw Errors.conflict(
        "Idempotency key was reused with a different Placement transition",
        { commandId: command.id },
      );
    }
    const result = jsonRecord(command.result);
    if (
      command.status !== "succeeded" ||
      result.placementId !== id
    ) {
      throw Errors.conflict(
        "The original Placement transition has not completed",
        { commandId: command.id, status: command.status },
      );
    }
    return id;
  };
  const existing = await prisma.controlPlaneCommand.findUnique({
    where: {
      scope_idempotencyKey: {
        scope: commandScope,
        idempotencyKey,
      },
    },
  });
  if (existing) {
    const placementId = placementIdFromCommand(existing);
    const replayedPlacement = await prisma.mediaAssetPlacement.findFirst({
      where: operationalMediaAssetPlacementWhere({ id: placementId }),
      include: placementInclude,
    });
    if (!replayedPlacement) {
      throw Errors.conflict(
        "The idempotent Placement transition result is no longer operational",
        { commandId: existing.id, placementId },
      );
    }
    const authority = (
      await resolveMediaAssetAuthorityMap(prisma, [replayedPlacement.mediaAsset])
    ).get(replayedPlacement.mediaAssetId);
    return ok({
      placement: placementDTO(replayedPlacement, authority),
      replayed: true,
    });
  }
  let replayed = false;
  const placement = await auditedTransaction("content.placement.update", async (tx) => {
    await tx.$queryRaw`
      SELECT 1::int AS locked
      FROM pg_advisory_xact_lock(hashtext(${`${commandScope}:${idempotencyKey}`}))
    `;
    const concurrentExisting = await tx.controlPlaneCommand.findUnique({
      where: {
        scope_idempotencyKey: {
          scope: commandScope,
          idempotencyKey,
        },
      },
    });
    if (concurrentExisting) {
      replayed = true;
      const placementId = placementIdFromCommand(concurrentExisting);
      return tx.mediaAssetPlacement.findFirstOrThrow({
        where: operationalMediaAssetPlacementWhere({ id: placementId }),
        include: placementInclude,
      });
    }
    await tx.$queryRaw`
      SELECT 1::int AS locked
      FROM pg_advisory_xact_lock(hashtext(${`legacy-placement:${id}`}))
    `;
    const before = await tx.mediaAssetPlacement.findFirst({
      where: operationalMediaAssetPlacementWhere({ id }),
    });
    if (!before) throw Errors.notFound("Placement not found");
    const beforeMetadata = jsonRecord(before.metadata);
    const managedRunId = typeof beforeMetadata.creativeRunId === "string"
      ? beforeMetadata.creativeRunId
      : null;
    if (
      managedRunId ||
      typeof beforeMetadata.creativeRunItemId === "string" ||
      Object.hasOwn(beforeMetadata, "customerMediaAuthority")
    ) {
      throw Errors.conflict("Creative Run placements are immutable through the legacy Placement editor", {
        code: "creative_run_placement_required",
        repairPath: managedRunId ? `/admin/creative/runs/${managedRunId}` : "/admin/creative/runs",
      });
    }
    if (before.version !== expectedVersion) {
      throw Errors.conflict("Placement changed after this operator view was loaded", {
        code: "legacy_placement_version_mismatch",
        expectedVersion,
        currentVersion: before.version,
        currentStatus: before.status,
      });
    }
    assertLegacyPlacementAuthority(before.slot, body.status);
    assertLegacyPlacementTransition(before.status, body.status);
    const changed = await tx.mediaAssetPlacement.updateMany({
      where: {
        id,
        status: before.status,
        version: expectedVersion,
      },
      data: {
        status: body.status,
        pausedAt: body.status === "paused" ? new Date() : undefined,
        archivedAt: body.status === "archived" ? new Date() : undefined,
        metadata: body.metadata ? toInputJson(body.metadata) : undefined,
        version: { increment: 1 },
      },
    });
    if (changed.count !== 1) {
      throw Errors.conflict("Legacy Placement changed during transition", {
        code: "legacy_placement_transition_changed",
        currentStatus: before.status,
        nextStatus: body.status,
        expectedVersion,
      });
    }
    const updated = await tx.mediaAssetPlacement.findUniqueOrThrow({
      where: { id },
    });
    await tx.adminAuditLog.create({
      data: transactionAuditData(request, actor, {
        action: body.status ? `content.placement.${body.status}` : "content.placement.update",
        targetType: "media_asset_placement",
        targetId: id,
        reason: body.reason,
        before: {
          status: before.status,
          mediaAssetId: before.mediaAssetId,
          slot: before.slot,
          targetId: before.targetId,
        },
        after: {
          status: updated.status,
          mediaAssetId: updated.mediaAssetId,
          slot: updated.slot,
          targetId: updated.targetId,
        },
      }),
    });
    await tx.controlPlaneCommand.create({
      data: {
        scope: commandScope,
        idempotencyKey,
        coordinationKey: `legacy-placement:${id}`,
        commandType: "content.placement.patch",
        targetType: "media_asset_placement",
        targetId: id,
        actorId: actor.id,
        requestId:
          request.headers.get("x-request-id") ?? crypto.randomUUID(),
        requestHash,
        requestPayload: toInputJson({ body, expectedVersion }),
        expectedVersion,
        retryMode: "idempotent",
        status: "succeeded",
        result: toInputJson({
          placementId: id,
          status: updated.status,
          version: updated.version,
        }),
        finishedAt: new Date(),
      },
    });
    return tx.mediaAssetPlacement.findUniqueOrThrow({
      where: { id },
      include: placementInclude,
    });
  });
  const authority = (
    await resolveMediaAssetAuthorityMap(prisma, [placement.mediaAsset])
  ).get(placement.mediaAssetId);
  return ok({ placement: placementDTO(placement, authority), replayed });
}

function transactionAuditData(
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
  return {
    actorId: actor.id,
    actorRole: actor.role,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    reason: input.reason,
    before: input.before === undefined ? undefined : toInputJson(input.before),
    after: input.after === undefined ? undefined : toInputJson(input.after),
    requestId: request.headers.get("x-request-id"),
  };
}

async function auditedTransaction<T>(
  operation: string,
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  try {
    return await prisma.$transaction(callback);
  } catch (error) {
    incrementCounter(
      "admin_audit_transaction_failure_total",
      "Admin domain transactions containing an atomic Audit row that rolled back",
      { operation },
    );
    throw error;
  }
}

function assertLegacyPlacementAuthority(slot: string, nextStatus?: string) {
  if (!releaseOwnedPlacementSlots.has(slot) && nextStatus !== "published") return;
  throw Errors.conflict(
    releaseOwnedPlacementSlots.has(slot)
      ? "Character image placements are owned by immutable Character Release commands"
      : "Customer-visible placements require a verified runtime authority",
    {
      code: releaseOwnedPlacementSlots.has(slot)
        ? "character_release_authority_required"
        : "creative_placement_verification_required",
      repairPath: releaseOwnedPlacementSlots.has(slot) ? "/admin/characters" : "/admin/creative/runs",
    },
  );
}

function assertLegacyPlacementTransition(
  currentStatus: string,
  nextStatus: "paused" | "archived",
) {
  const allowed = nextStatus === "archived"
    ? currentStatus !== "archived"
    : !["paused", "archived"].includes(currentStatus);
  if (allowed) return;
  throw Errors.conflict("Legacy Placement transition is not allowed", {
    code: "legacy_placement_transition_invalid",
    currentStatus,
    nextStatus,
  });
}

async function resolveProductionProfile(profileId: string, version?: number) {
  const profile = await prisma.generationModelProfile.findFirst({
    where: {
      mode: "image",
      status: "active",
      enabled: true,
      rolloutPercent: { gt: 0 },
      version,
      OR: [{ id: profileId }, { profileKey: profileId }],
    },
    orderBy: { version: "desc" },
  });
  if (!profile) throw Errors.badRequest("Production Studio requires an active image profile");
  return profile;
}

async function resolveProductionRecipe(
  recipeId: string | undefined,
  targetType: string,
  version?: number,
) {
  const useCase = targetType === "character" ? "character" : "freeplay";
  const recipe = await prisma.generationRecipe.findFirst({
    where: recipeId
      ? {
          mode: "image",
          status: "active",
          version,
          OR: [{ id: recipeId }, { recipeKey: recipeId }],
        }
      : {
          mode: "image",
          status: "active",
          useCase,
        },
    orderBy: { version: "desc" },
  });
  if (!recipe) throw Errors.badRequest("Production Studio requires an active prompt recipe");
  return recipe;
}

async function resolveProductionTarget(targetType: string, targetId?: string) {
  if (targetType === "none" || !targetId) return null;
  if (targetType === "character") {
    const [character, content] = await Promise.all([
      prisma.character.findUnique({
        where: { id: targetId },
        select: {
          id: true,
          name: true,
          age: true,
          gender: true,
          style: true,
          description: true,
        },
      }),
      prisma.characterContentVersion.findFirst({
        where: { characterId: targetId },
        orderBy: { version: "desc" },
        select: {
          id: true,
          version: true,
          personaSnapshot: true,
          appearanceSnapshot: true,
        },
      }),
    ]);
    if (!character) throw Errors.badRequest("Target character not found");
    const persona = jsonRecord(content?.personaSnapshot);
    const appearance = jsonRecord(content?.appearanceSnapshot);
    const name = stringFromRecord(persona, "name") ?? character.name;
    const age = numberFromRecord(persona, "age") ?? character.age;
    const gender = stringFromRecord(persona, "gender") ?? character.gender;
    const style = stringFromRecord(appearance, "style") ?? character.style;
    const description =
      stringFromRecord(persona, "characterPromise") ??
      stringFromRecord(persona, "description") ??
      character.description;
    return {
      type: "character",
      id: character.id,
      label: name,
      detail: `${age}, ${gender}, ${style}. ${description}`,
      contentVersionId: content?.id ?? null,
      contentVersion: content?.version ?? null,
    };
  }
  if (targetType === "template") {
    const template = await prisma.characterTemplate.findUnique({
      where: { id: targetId },
      select: { id: true, name: true, summary: true, gender: true, style: true },
    });
    if (!template) throw Errors.badRequest("Target template not found");
    return {
      type: "template",
      id: template.id,
      label: template.name,
      detail: [template.summary, template.gender, template.style].filter(Boolean).join(", "),
    };
  }
  return { type: targetType, id: targetId, label: targetId, detail: "" };
}

async function resolveProductionVisualProfile(
  db: Pick<Prisma.TransactionClient, "characterVisualProfile">,
  targetType: string,
  targetId?: string,
) {
  if (targetType !== "character" || !targetId) return null;
  return db.characterVisualProfile.findFirst({
    where: { characterId: targetId, status: "active" },
    orderBy: { version: "desc" },
    select: {
      id: true,
      version: true,
      style: true,
      identityPrompt: true,
      negativeIdentityPrompt: true,
      faceTraits: true,
      hairTraits: true,
      bodyTraits: true,
      signatureTraits: true,
      styleTraits: true,
      defaultSeed: true,
      anchorAssetIds: true,
      referenceAssetIds: true,
      immutableHash: true,
      evidenceState: true,
    },
  });
}

async function resolveProductionReferenceSet(
  db: Pick<Prisma.TransactionClient, "referenceSetRevision">,
  visualProfileId: string,
) {
  return db.referenceSetRevision.findFirst({
    where: { visualProfileId, status: "active" },
    include: {
      references: {
        include: { mediaAsset: true },
        orderBy: { position: "asc" },
      },
    },
    orderBy: { revision: "desc" },
  });
}

async function resolveProductionBootstrapAuthority(
  db: Pick<Prisma.TransactionClient, "characterProject" | "characterContentVersion">,
  characterId: string,
  brief: string | null,
) {
  const [project, content] = await Promise.all([
    db.characterProject.findFirst({
      where: { characterId },
      orderBy: { updatedAt: "desc" },
      select: { id: true, version: true, phase: true },
    }),
    db.characterContentVersion.findFirst({
      where: { characterId },
      orderBy: { version: "desc" },
      select: { id: true, appearanceSnapshot: true },
    }),
  ]);
  if (!project || !content || !["idea", "planned", "producing"].includes(project.phase)) return null;
  return {
    projectId: project.id,
    projectVersion: project.version,
    characterContentVersionId: content.id,
    visualBriefHash: canonicalSha256({
      characterContentVersionId: content.id,
      appearanceSnapshot: content.appearanceSnapshot,
      brief,
    }),
  };
}

function generationProfileCapabilities(value: Prisma.JsonValue | null) {
  const capabilities = jsonRecord(jsonRecord(value).capabilities);
  return {
    textToImage: capabilities.textToImage === true,
    referenceImages: capabilities.referenceImages === true,
    initImage: capabilities.initImage === true,
  };
}

function productionConsistencyPrompt(mode: z.infer<typeof consistencyModeSchema>) {
  if (mode === "strict") {
    return "Identity consistency: strict; preserve the locked face, hairstyle, body type, and signature traits.";
  }
  if (mode === "creative") {
    return "Identity consistency: creative; explore composition and styling while preserving the core locked identity.";
  }
  return "Identity consistency: balanced; preserve the locked identity while allowing the requested scene, pose, outfit, and lighting.";
}

function productionPrompt(input: {
  purpose: z.infer<typeof productionPurposeSchema>;
  target: Awaited<ReturnType<typeof resolveProductionTarget>>;
  recipeBody: string;
  presetFragment: string;
  brief?: string;
  visualProfile: Awaited<ReturnType<typeof resolveProductionVisualProfile>>;
  consistencyMode: z.infer<typeof consistencyModeSchema>;
}) {
  const targetPrompt = !input.target
    ? ""
    : input.target.type === "character" && input.visualProfile
      ? `Target character: ${input.target.label}. The Operator brief is the authority for the current scene; do not import people, setting, or events from the character synopsis.`
      : `Target ${input.target.type}: ${input.target.label}. ${input.target.detail}`;
  return [
    `Production purpose: ${purposeLabel(input.purpose)}.`,
    targetPrompt,
    input.visualProfile ? `Locked identity: ${input.visualProfile.identityPrompt}` : "",
    input.visualProfile ? productionConsistencyPrompt(input.consistencyMode) : "",
    `Recipe: ${input.recipeBody}`,
    input.presetFragment ? `Presets: ${input.presetFragment}` : "",
    input.brief ? `Operator brief: ${input.brief}` : "",
    input.target?.type === "character"
      ? "Composition guard: render exactly one person total—the target character—with no background people, duplicated person, collage, contact sheet, split panel, or comparison grid."
      : "",
    "Generate a polished, reusable platform image with clear subject framing and no text overlay.",
  ]
    .filter(Boolean)
    .join("\n");
}

function productionControls(input: {
  orientation: string;
  dimensions: { width: number; height: number };
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
  };
  presets: Array<{ id: string; type: string }>;
  visualProfile: Awaited<ReturnType<typeof resolveProductionVisualProfile>>;
  consistencyMode: z.infer<typeof consistencyModeSchema>;
  referenceAssetIds: readonly string[];
  workflowIdentity: {
    mode: string;
    maxReferences: number;
    acceptedRoles: readonly string[];
    supportsLookReference: boolean;
    supportsSourceImageWithIdentity: boolean;
  } | undefined;
  generationRouteFingerprint?: string;
}) {
  const anchorAssetIds = input.visualProfile
    ? jsonStringArray(input.visualProfile.anchorAssetIds)
    : [];
  const referenceAssetIds = [...new Set(input.referenceAssetIds)];
  return pruneUndefined({
    orientation: input.orientation,
    model: input.profile.profileKey,
    profileId: input.profile.profileKey,
    width: input.dimensions.width,
    height: input.dimensions.height,
    backgroundPresetId: presetIdForType(input.presets, "background"),
    posePresetId: presetIdForType(input.presets, "pose"),
    outfitPresetId: presetIdForType(input.presets, "outfit"),
    modePresetId: presetIdForType(input.presets, "mode"),
    consistencyMode: input.visualProfile ? input.consistencyMode : undefined,
    workflowIdentity: input.workflowIdentity,
    generationRouteFingerprint: input.generationRouteFingerprint,
    visualIdentity: input.visualProfile
      ? {
          visualProfileId: input.visualProfile.id,
          visualProfileVersion: input.visualProfile.version,
          consistencyMode: input.consistencyMode,
          anchorAssetIds,
          referenceAssetIds,
          seed: input.visualProfile.defaultSeed,
        }
      : undefined,
    contentProduction: true,
    sdcpp: input.profile.runner === "sd_cpp" ? sdcppProfileRuntimeConfig(input.profile) : undefined,
  });
}

function productionNegativePrompt(
  base: string | null,
  identity: string | null | undefined,
  purpose: z.infer<typeof productionPurposeSchema>,
) {
  const characterCompositionGuard =
    purpose.startsWith("character_") || purpose === "identity_calibration"
    ? "collage, contact sheet, split screen, multiple panels, comparison grid, duplicate person, extra people"
    : null;
  return [base?.trim(), identity?.trim(), characterCompositionGuard].filter(Boolean).join(", ") || null;
}

function presetIdForType(presets: Array<{ id: string; type: string }>, type: string) {
  return presets.find((preset) => preset.type === type)?.id;
}

function presetPromptFragment(
  orderedIds: string[],
  presets: Array<{ id: string; label: string; controls: Prisma.JsonValue }>,
) {
  const fragments: string[] = [];
  for (const id of orderedIds) {
    const preset = presets.find((item) => item.id === id);
    if (!preset) continue;
    const controls = jsonRecord(preset.controls);
    const values = Object.values(controls)
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.trim());
    fragments.push(values.length ? values.join(", ") : preset.label);
  }
  return fragments.join(", ");
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

async function patchAssetMetadata(
  db: Prisma.TransactionClient,
  assetId: string,
  patch: {
    status?: string;
    purpose?: string;
    tags?: string[];
    description?: string;
    reviewNote?: string;
    sourceBatchId?: string;
  },
) {
  const asset = await db.mediaAsset.findUnique({ where: { id: assetId } });
  if (!asset) throw Errors.notFound("Media asset not found");
  const metadata = jsonRecord(asset.metadata);
  const platformAsset = jsonRecord(metadata.platformAsset);
  await db.mediaAsset.update({
    where: { id: assetId },
    data: {
      metadata: toInputJson({
        ...metadata,
        platformAsset: pruneUndefined({
          ...platformAsset,
          status: patch.status ?? platformAsset.status ?? "generated",
          purpose: patch.purpose ?? platformAsset.purpose,
          tags: patch.tags ?? platformAsset.tags,
          description: patch.description ?? platformAsset.description,
          reviewNote: patch.reviewNote ?? platformAsset.reviewNote,
          sourceBatchId: patch.sourceBatchId ?? platformAsset.sourceBatchId,
          updatedAt: new Date().toISOString(),
        }),
      }),
    },
  });
}

async function assertApprovedAsset(
  db: typeof prisma | Prisma.TransactionClient,
  mediaAssetId: string,
) {
  const item = await db.contentProductionItem.findFirst({
    where: {
      mediaAssetId,
      status: { in: ["approved", "published"] },
      mediaAsset: {
        is: operationalMediaAssetWhere({ deletedAt: null }),
      },
    },
    include: { mediaAsset: true },
  });
  const latestDecision = item
    ? await db.creativeReviewDecision.findFirst({
        where: { runItemId: item.id },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      })
    : null;
  const platformStatus = item?.mediaAsset
    ? platformAssetMetadata(item.mediaAsset).status
    : null;
  if (
    !item?.mediaAsset ||
    (typeof platformStatus === "string" && ["archived", "rejected"].includes(platformStatus)) ||
    !latestDecision ||
    latestDecision.artifactId !== mediaAssetId ||
    latestDecision.decision !== "approved"
  ) {
    throw Errors.badRequest("Only approved content assets can be placed");
  }
  await assertMediaAssetCustomerPublishable(db, item.mediaAsset);
}

function validatePlacementTarget(slot: string, targetType: string) {
  if ((slot === "character_avatar" || slot === "character_hero") && targetType !== "character") {
    throw Errors.badRequest("Character image placements require character target type");
  }
  if (slot === "template_cover" && targetType !== "template") {
    throw Errors.badRequest("Template cover placements require template target type");
  }
}

async function appendProductionJobEvent(
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

export function productionBatchDTO(
  batch: ProductionBatchWithItems,
  ledgerEntries: ReadonlyArray<CreativeRunLedgerFact> = [],
  mediaAuthorityById: ReadonlyMap<string, ResolvedMediaAssetAuthority> = new Map(),
) {
  const state = deriveCreativeRunState({
    legacyStatus: batch.status,
    expectedItemCount: batch.totalItems,
    items: batch.items.map((item) => {
      const asset = item.mediaAsset ?? item.job?.assets[0] ?? null;
      return {
        id: item.id,
        status: item.status,
        job: item.job
          ? {
              id: item.job.id,
              status: item.job.status,
              errorCode: item.job.errorCode,
              costDreamcoins: item.job.costDreamcoins,
            }
          : null,
        asset: asset
          ? {
              id: asset.id,
              safetyStatus: asset.safetyStatus,
              deletedAt: asset.deletedAt,
            }
          : null,
        placements: item.status === "published"
          ? [{ status: "published", verificationState: "pending" as const }]
          : [],
      };
    }),
    ledgerEntries,
  });
  return {
    id: batch.id,
    title: batch.title,
    purpose: batch.purpose,
    targetType: batch.targetType,
    targetId: batch.targetId,
    profileId: batch.profileId,
    profileVersion: batch.profileVersion,
    recipeId: batch.recipeId,
    recipeVersion: batch.recipeVersion,
    presetIds: jsonStringArray(batch.presetIds),
    orientation: batch.orientation,
    brief: batch.brief,
    count: batch.count,
    totalItems: batch.totalItems,
    completedItems: batch.completedItems,
    failedItems: batch.failedItems,
    approvedItems: batch.approvedItems,
    estimatedCostDreamcoins: batch.estimatedCostDreamcoins,
    consistencyMode: batch.items[0]?.job?.consistencyMode ?? null,
    status: batch.status,
    state,
    createdById: batch.createdById,
    createdByEmail: batch.createdBy.email,
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
    items: batch.items.map((item) =>
      productionItemDTO(item, mediaAuthorityById),
    ),
  };
}

async function productionBatchMediaAuthority(
  batches: ReadonlyArray<ProductionBatchWithItems>,
) {
  const assets = [
    ...new Map(
      batches.flatMap((batch) =>
        batch.items.flatMap((item) => {
          const asset = item.mediaAsset ?? item.job?.assets[0] ?? null;
          return asset ? [[asset.id, asset] as const] : [];
        }),
      ),
    ).values(),
  ];
  return resolveMediaAssetAuthorityMap(prisma, assets);
}

async function productionBatchLedgerEntries(
  batches: ReadonlyArray<ProductionBatchWithItems>,
): Promise<CreativeRunLedgerFact[]> {
  const jobIds = batches.flatMap((batch) =>
    batch.items.flatMap((item) => (item.jobId ? [item.jobId] : [])),
  );
  if (jobIds.length === 0) return [];
  return prisma.dreamcoinLedger.findMany({
    where: { sourceId: { in: jobIds }, reason: { in: ["generation_spend", "refund"] } },
    select: { sourceId: true, reason: true, delta: true },
  });
}

function ledgerEntriesForBatch(
  batch: ProductionBatchWithItems,
  ledgerEntries: ReadonlyArray<CreativeRunLedgerFact>,
) {
  const jobIds = new Set(
    batch.items.flatMap((item) => (item.jobId ? [item.jobId] : [])),
  );
  return ledgerEntries.filter((entry) => entry.sourceId && jobIds.has(entry.sourceId));
}

function productionItemDTO(
  item: Prisma.ContentProductionItemGetPayload<{
    include: { batch: true; job: { include: { assets: true } }; mediaAsset: true };
  }> | ProductionBatchWithItems["items"][number],
  mediaAuthorityById: ReadonlyMap<string, ResolvedMediaAssetAuthority> = new Map(),
) {
  const asset = item.mediaAsset ?? item.job?.assets[0] ?? null;
  return {
    id: item.id,
    batchId: item.batchId,
    itemIndex: item.itemIndex,
    jobId: item.jobId,
    mediaAssetId: asset?.id ?? item.mediaAssetId,
    status: item.status,
    reviewNote: item.reviewNote,
    rating: item.rating,
    tags: jsonStringArray(item.tags),
    reviewedById: item.reviewedById,
    reviewedAt: item.reviewedAt,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    job: item.job
      ? {
          id: item.job.id,
          status: item.job.status,
          errorCode: item.job.errorCode,
          profileId: item.job.profileId,
          profileVersion: item.job.profileVersion,
          recipeId: item.job.recipeId,
          recipeVersion: item.job.recipeVersion,
          consistencyMode: item.job.consistencyMode,
          createdAt: item.job.createdAt,
          completedAt: item.job.completedAt,
        }
      : null,
    asset: asset
      ? mediaAssetDTO(asset, mediaAuthorityById.get(asset.id))
      : null,
  };
}

function contentAssetDTO(
  asset: ContentAssetWithRelations,
  authority?: ResolvedMediaAssetAuthority,
) {
  const item = asset.productionItems[0] ?? null;
  const platform = platformAssetMetadata(asset);
  const platformHasTags = Object.hasOwn(platform, "tags");
  const platformStatus = platform.status === "archived" ? "archived" : (item?.status ?? platform.status);
  return {
    ...mediaAssetDTO(asset, authority),
    platformStatus: platformStatus ?? "generated",
    purpose: item?.batch.purpose ?? platform.purpose ?? null,
    targetType: item?.batch.targetType ?? null,
    targetId: item?.batch.targetId ?? null,
    tags: platformHasTags ? assetTags(asset) : item ? jsonStringArray(item.tags) : [],
    description: assetDescription(asset),
    sourceJob: asset.sourceJob
      ? {
          id: asset.sourceJob.id,
          status: asset.sourceJob.status,
          profileId: asset.sourceJob.profileId,
          profileVersion: asset.sourceJob.profileVersion,
          recipeId: asset.sourceJob.recipeId,
          recipeVersion: asset.sourceJob.recipeVersion,
          sourceType: asset.sourceJob.sourceType,
          sourceId: asset.sourceJob.sourceId,
          sourceMeta: asset.sourceJob.sourceMeta,
        }
      : null,
    sourceBatch: item
      ? {
          id: item.batch.id,
          title: item.batch.title,
          purpose: item.batch.purpose,
          status: item.batch.status,
        }
      : null,
    placements: asset.placements.map((placement) => ({
      id: placement.id,
      slot: placement.slot,
      targetType: placement.targetType,
      targetId: placement.targetId,
      status: placement.status,
      publishedAt: placement.publishedAt,
    })),
  };
}

function placementDTO(
  placement: PlacementWithRelations,
  authority?: ResolvedMediaAssetAuthority,
) {
  const metadata = jsonRecord(placement.metadata);
  return {
    id: placement.id,
    mediaAssetId: placement.mediaAssetId,
    slot: placement.slot,
    targetType: placement.targetType,
    targetId: placement.targetId,
    status: placement.status,
    version: placement.version,
    verificationState: placement.verificationState,
    managedRunId: typeof metadata.creativeRunId === "string" ? metadata.creativeRunId : null,
    scheduledAt: placement.scheduledAt,
    publishedAt: placement.publishedAt,
    pausedAt: placement.pausedAt,
    archivedAt: placement.archivedAt,
    createdById: placement.createdById,
    createdByEmail: placement.createdBy.email,
    metadata: placement.metadata,
    createdAt: placement.createdAt,
    updatedAt: placement.updatedAt,
    asset: mediaAssetDTO(placement.mediaAsset, authority),
  };
}

function mediaAssetDTO(asset: {
  id: string;
  type: string;
  url: string;
  thumbnailUrl: string | null;
  contentType: string | null;
  width: number | null;
  height: number | null;
  safetyStatus: string;
  sourceJobId: string | null;
  prompt: string | null;
  metadata: Prisma.JsonValue;
  createdAt: Date;
}, authority?: ResolvedMediaAssetAuthority) {
  const isSynthetic = isSyntheticMediaAsset(asset.metadata);
  const publishabilityReasons = authority?.reasons ?? (
    isSynthetic ? ["metadata_synthetic"] : []
  );
  return {
    id: asset.id,
    type: asset.type,
    url: asset.url,
    thumbnailUrl: asset.thumbnailUrl ?? asset.url,
    contentType: asset.contentType,
    width: asset.width,
    height: asset.height,
    safetyStatus: asset.safetyStatus,
    sourceJobId: asset.sourceJobId,
    isSynthetic,
    customerPublishable: authority?.publishable ?? !isSynthetic,
    publishabilityReasons,
    promptSummary: asset.prompt ? asset.prompt.slice(0, 180) : null,
    metadata: asset.metadata,
    createdAt: asset.createdAt,
  };
}

function platformAssetMetadata(asset: { metadata: Prisma.JsonValue }) {
  return jsonRecord(jsonRecord(asset.metadata).platformAsset);
}

function assetTags(asset: { metadata: Prisma.JsonValue }) {
  return jsonStringArray(platformAssetMetadata(asset).tags);
}

function assetDescription(asset: { metadata: Prisma.JsonValue }) {
  const description = platformAssetMetadata(asset).description;
  return typeof description === "string" && description.trim() ? description.trim() : null;
}

function purposeLabel(value: string) {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function parseOptionalDate(value: string | undefined) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw Errors.badRequest("Invalid scheduledAt value");
  return date;
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

function stringFromRecord(value: Record<string, unknown>, key: string) {
  const child = value[key];
  return typeof child === "string" && child.trim() ? child.trim() : undefined;
}

function numberFromRecord(value: Record<string, unknown>, key: string) {
  const child = value[key];
  return typeof child === "number" && Number.isFinite(child) ? child : undefined;
}

function pruneUndefined(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined));
}
