// SPEC: Generation operations contracts — model profiles, model imports, prompt recipes,
//       built-in presets, the dead-letter queue, backend/workflow diagnostics, generation
//       metrics, and the provider operations rollup.
// INTENT: these operations came over from the v1 `generation` / `ops` dispatcher resources,
//         where the "contract" was whatever the handler happened to return. Declaring them
//         here is the point of the migration: the manifest binds each route to one of these
//         schemas and `adminV2Route` refuses to ship anything outside it.
// INVARIANT: every response schema is `.strict()`. Prisma rows are projected field by field
//            in the authority modules rather than spread wholesale, so a new column cannot
//            silently widen a public response.
import { z } from "zod";
import {
  adminIdSchema,
  adminIsoDateTimeSchema,
  adminJsonValueSchema,
  adminListResponseSchema,
} from "./common";
import { generationJobDataScopeSchema } from "./jobs";

/**
 * SPEC: the metric-side operational scope — wider than the user-side one because operational
 * analytics events carry their own `operational` data class.
 * INVARIANT: mirrors `OPERATIONAL_METRIC_DATA_SCOPE` in main; the tuples make a drift a 500.
 */
export const generationMetricDataScopeSchema = z
  .object({
    kind: z.literal("operational"),
    includedDataClasses: z.tuple([
      z.literal("customer"),
      z.literal("internal"),
      z.literal("operational"),
    ]),
    excludedDataClasses: z.tuple([z.literal("fixture"), z.literal("audit")]),
  })
  .strict();

const generationModeSchema = z.enum(["image", "video"]);
const generationConfigStatusSchema = z.enum(["draft", "active", "archived"]);
const imageOrientationSchema = z.string().trim().min(1).max(20);

// ---------------------------------------------------------------------------
// Model profiles
// ---------------------------------------------------------------------------

export const generationModelProfileQuerySchema = z
  .object({
    search: z.string().trim().min(1).max(200).optional(),
    mode: generationModeSchema.optional(),
    status: generationConfigStatusSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().min(1).optional(),
  })
  .strict();

export const generationModelProfileSchema = z
  .object({
    id: adminIdSchema,
    profileKey: z.string().min(1),
    label: z.string().min(1),
    mode: z.string().min(1),
    runner: z.string().min(1),
    pipelineModel: z.string().min(1),
    workflowKey: z.string().min(1).nullable(),
    sourceModelPath: z.string().nullable(),
    convertedModelPath: z.string().nullable(),
    modelFormat: z.string().min(1),
    runnerConfig: adminJsonValueSchema,
    defaultWidth: z.number().int().positive(),
    defaultHeight: z.number().int().positive(),
    allowedOrientations: z.array(z.string().min(1)).readonly(),
    steps: z.number().int().positive(),
    sampler: z.string().min(1),
    scheduler: z.string().min(1),
    cfgScale: z.number(),
    costMultiplier: z.number(),
    requiredEntitlement: z.string().nullable(),
    maxCount: z.number().int().positive(),
    concurrencyLimit: z.number().int().positive(),
    enabled: z.boolean(),
    rolloutPercent: z.number().int().min(0).max(100),
    version: z.number().int().positive(),
    status: z.string().min(1),
    dryRunSummary: adminJsonValueSchema,
    publishedAt: adminIsoDateTimeSchema.nullable(),
    archivedAt: adminIsoDateTimeSchema.nullable(),
    createdAt: adminIsoDateTimeSchema,
    updatedAt: adminIsoDateTimeSchema,
  })
  .strict();

export const generationModelProfileListResponseSchema = adminListResponseSchema(
  generationModelProfileSchema,
);

export const generationModelProfileCreateRequestSchema = z
  .object({
    profileKey: z.string().trim().min(1).max(120),
    label: z.string().trim().min(1).max(120),
    mode: generationModeSchema.default("image"),
    runner: z.string().trim().min(1).max(40).default("comfyui"),
    pipelineModel: z.string().trim().min(1).max(160),
    workflowKey: z.string().trim().min(1).max(160).nullable().optional(),
    sourceModelPath: z.string().trim().max(500).nullable().optional(),
    convertedModelPath: z.string().trim().max(500).nullable().optional(),
    modelFormat: z.enum(["safetensors", "gguf", "diffusers", "external"]).default("safetensors"),
    runnerConfig: z.record(z.string(), z.unknown()).optional(),
    defaultWidth: z.number().int().min(128).max(4096).default(768),
    defaultHeight: z.number().int().min(128).max(4096).default(1024),
    allowedOrientations: z.array(imageOrientationSchema).min(1).max(12),
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
  })
  .strict();

export const generationModelProfilePatchRequestSchema = z
  .object({
    profileKey: z.string().trim().min(1).max(120).optional(),
    label: z.string().trim().min(1).max(120).optional(),
    mode: generationModeSchema.optional(),
    runner: z.string().trim().min(1).max(40).optional(),
    pipelineModel: z.string().trim().min(1).max(160).optional(),
    workflowKey: z.string().trim().min(1).max(160).nullable().optional(),
    sourceModelPath: z.string().trim().max(500).nullable().optional(),
    convertedModelPath: z.string().trim().max(500).nullable().optional(),
    modelFormat: z.enum(["safetensors", "gguf", "diffusers", "external"]).optional(),
    runnerConfig: z.record(z.string(), z.unknown()).optional(),
    defaultWidth: z.number().int().min(128).max(4096).optional(),
    defaultHeight: z.number().int().min(128).max(4096).optional(),
    allowedOrientations: z.array(imageOrientationSchema).min(1).max(12).optional(),
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
  })
  .strict();

export const generationModelProfileResponseSchema = z
  .object({ profile: generationModelProfileSchema })
  .strict();

/** SPEC: publishing a profile or a recipe carries the same evidence — reason, target, summary. */
export const generationPublishCommandRequestSchema = z
  .object({
    reason: z.string().trim().min(3).max(2_000),
    confirmation: z.string().trim().min(1).max(160),
    dryRunSummary: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const generationModelProfilePublishResponseSchema = z
  .object({
    profile: generationModelProfileSchema,
    previousActiveId: adminIdSchema.nullable(),
  })
  .strict();

/** SPEC: rollback, dry-run, and single-job requeue all take exactly a reason and a target confirmation. */
export const generationConfigCommandRequestSchema = z
  .object({
    reason: z.string().trim().min(3).max(2_000),
    confirmation: z.string().trim().min(1).max(160),
  })
  .strict();

export const generationModelProfileRollbackResponseSchema = z
  .object({
    profile: generationModelProfileSchema,
    fromVersion: z.number().int().positive(),
    toVersion: z.number().int().positive(),
  })
  .strict();

export const generationProfileHealthQuerySchema = z
  .object({ days: z.coerce.number().int().min(1).max(365).optional() })
  .strict();

export const generationProfileHealthResponseSchema = z
  .object({
    dataScope: generationMetricDataScopeSchema,
    profileId: adminIdSchema,
    profileKey: z.string().min(1),
    window: z.object({ from: adminIsoDateTimeSchema, days: z.number().int().positive() }).strict(),
    metrics: z
      .object({
        total: z.number().int().nonnegative(),
        completed: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        blocked: z.number().int().nonnegative(),
        refunded: z.number().int().nonnegative(),
        successRate: z.number().nullable(),
        blockedRate: z.number().nullable(),
        refundRate: z.number().nullable(),
        latencyP50Ms: z.number().nullable(),
        latencyP95Ms: z.number().nullable(),
        latencySamples: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

/**
 * SPEC: the dry-run answer an operator reads, not the summary the profile stores.
 * INTENT: the persisted `dryRunSummary` merges whatever an earlier run left behind, so it has
 * no closed shape. Publishing admissibility reads the stored summary; the console only ever
 * reads the verdict, so that is all this contract admits.
 */
export const generationProfileDryRunResponseSchema = z
  .object({
    dryRun: z
      .object({
        status: z.enum(["pass", "fail"]),
        passed: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
        sampleCount: z.number().int().nonnegative(),
        configurationPassRate: z.number(),
        failureMode: z.string().min(1).optional(),
        samples: z
          .array(
            z
              .object({
                useCase: z.string().min(1),
                orientation: z.string().min(1),
                ok: z.boolean(),
                issues: z.array(z.string().min(1)).readonly(),
              })
              .strict(),
          )
          .readonly(),
      })
      .strict(),
  })
  .strict();

export const generationProfileTestJobRequestSchema = z
  .object({
    prompt: z.string().trim().max(2_000).optional(),
    negativePrompt: z.string().trim().max(1_000).nullable().optional(),
    orientation: imageOrientationSchema.optional(),
    outputCount: z.number().int().min(1).max(4).default(1),
    reason: z.string().trim().min(3).max(2_000),
    confirmation: z.string().trim().min(1).max(160),
  })
  .strict();

export const generationProfileTestJobResponseSchema = z
  .object({
    job: z
      .object({
        id: adminIdSchema,
        status: z.string().min(1),
        mode: z.string().min(1),
        profileId: z.string().min(1).nullable(),
        profileVersion: z.number().int().positive().nullable(),
        orientation: z.string().min(1).nullable(),
        outputCount: z.number().int().positive(),
        createdAt: adminIsoDateTimeSchema,
      })
      .strict(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Model imports (env-gated diagnostics surface)
// ---------------------------------------------------------------------------

const generationModelImportKindSchema = z.enum(["model", "lora", "llm", "vae"]);

const generationModelImportAssetSchema = z
  .object({
    kind: generationModelImportKindSchema,
    name: z.string().min(1),
    path: z.string().min(1),
    format: z.enum(["safetensors", "gguf"]),
    sizeBytes: z.number().int().nonnegative(),
    modifiedAt: adminIsoDateTimeSchema,
    draftPatch: adminJsonValueSchema,
  })
  .strict();

const generationModelImportRootsSchema = z
  .object({
    root: z.string().min(1),
    model: z.string().min(1),
    lora: z.string().min(1),
    llm: z.string().min(1),
    vae: z.string().min(1),
    converted: z.string().min(1),
  })
  .strict();

export const generationModelImportListResponseSchema = z
  .object({
    roots: generationModelImportRootsSchema,
    maxUploadBytes: z.number().int().positive(),
    items: z.array(generationModelImportAssetSchema).readonly(),
  })
  .strict();

export const generationModelImportRegisterRequestSchema = z
  .object({
    kind: generationModelImportKindSchema.default("model"),
    path: z.string().trim().min(1).max(1_000),
    copyToLibrary: z.boolean().default(false),
    reason: z.string().trim().min(3).max(2_000).optional(),
  })
  .strict();

export const generationModelImportRegisterResponseSchema = z
  .object({
    asset: generationModelImportAssetSchema,
    assets: z.array(generationModelImportAssetSchema).readonly(),
    roots: generationModelImportRootsSchema,
  })
  .strict();

export const generationModelImportUploadResponseSchema = z
  .object({
    asset: generationModelImportAssetSchema,
    roots: generationModelImportRootsSchema,
  })
  .strict();

// ---------------------------------------------------------------------------
// Prompt recipes
// ---------------------------------------------------------------------------

export const generationRecipeQuerySchema = z
  .object({
    search: z.string().trim().min(1).max(200).optional(),
    mode: z.enum(["image", "video", "negative"]).optional(),
    status: generationConfigStatusSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().min(1).optional(),
  })
  .strict();

export const generationRecipeSchema = z
  .object({
    id: adminIdSchema,
    recipeKey: z.string().min(1),
    label: z.string().min(1),
    mode: z.string().min(1),
    useCase: z.string().min(1),
    body: z.string().min(1),
    negativeBase: z.string().nullable(),
    presetOrder: adminJsonValueSchema,
    safetyHints: adminJsonValueSchema,
    sampleMatrix: adminJsonValueSchema,
    dryRunSummary: adminJsonValueSchema,
    version: z.number().int().positive(),
    status: z.string().min(1),
    publishedAt: adminIsoDateTimeSchema.nullable(),
    archivedAt: adminIsoDateTimeSchema.nullable(),
    createdAt: adminIsoDateTimeSchema,
    updatedAt: adminIsoDateTimeSchema,
  })
  .strict();

export const generationRecipeListResponseSchema = adminListResponseSchema(generationRecipeSchema);

export const generationRecipeCreateRequestSchema = z
  .object({
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
  })
  .strict();

export const generationRecipePatchRequestSchema =
  generationRecipeCreateRequestSchema.partial();

export const generationRecipeResponseSchema = z
  .object({ recipe: generationRecipeSchema })
  .strict();

export const generationRecipePublishResponseSchema = z
  .object({
    recipe: generationRecipeSchema,
    previousActiveId: adminIdSchema.nullable(),
  })
  .strict();

export const generationRecipeRollbackResponseSchema = z
  .object({
    recipe: generationRecipeSchema,
    fromVersion: z.number().int().positive(),
    toVersion: z.number().int().positive(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Built-in presets
// ---------------------------------------------------------------------------

const generationPresetTypeSchema = z.enum(["background", "pose", "outfit", "mode"]);

export const generationPresetQuerySchema = z
  .object({
    search: z.string().trim().min(1).max(200).optional(),
    type: generationPresetTypeSchema.optional(),
    status: z.enum(["active", "archived"]).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().min(1).optional(),
  })
  .strict();

export const generationPresetSchema = z
  .object({
    id: adminIdSchema,
    scope: z.string().min(1),
    type: z.string().min(1),
    category: z.string().nullable(),
    label: z.string().min(1),
    controls: adminJsonValueSchema,
    visibility: z.string().min(1),
    status: z.string().min(1),
    createdAt: adminIsoDateTimeSchema,
    updatedAt: adminIsoDateTimeSchema,
  })
  .strict();

export const generationPresetListResponseSchema = adminListResponseSchema(generationPresetSchema);

export const generationPresetCreateRequestSchema = z
  .object({
    type: generationPresetTypeSchema,
    category: z.string().max(80).optional(),
    label: z.string().trim().min(1).max(80),
    controls: z.record(z.string(), z.unknown()).default({}),
    visibility: z.enum(["private", "public", "unlisted"]).default("public"),
    status: z.enum(["active", "archived"]).default("active"),
  })
  .strict();

export const generationPresetPatchRequestSchema =
  generationPresetCreateRequestSchema.partial();

export const generationPresetResponseSchema = z
  .object({ preset: generationPresetSchema })
  .strict();

// ---------------------------------------------------------------------------
// Dead-letter queue
// ---------------------------------------------------------------------------

export const generationDeadLetterQuerySchema = z
  .object({
    search: z.string().trim().min(1).max(200).optional(),
    mode: z.string().trim().min(1).max(40).optional(),
    status: z.string().trim().min(1).max(200).optional(),
    errorCode: z.string().trim().min(1).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().min(1).optional(),
    before: z.string().trim().min(1).optional(),
  })
  .strict();

const generationRetryEligibilitySchema = z
  .object({
    eligible: z.boolean(),
    reason: z.enum([
      "successful_artifact_exists",
      "not_failed",
      "refunded",
      "retryable_failure",
    ]),
  })
  .strict();

export const generationDeadLetterItemSchema = z
  .object({
    id: adminIdSchema,
    userId: adminIdSchema,
    mode: z.string().min(1),
    status: z.string().min(1),
    provider: z.string().min(1).nullable(),
    errorCode: z.string().min(1).nullable(),
    costDreamcoins: z.number().int().nonnegative(),
    ledgerState: z.enum(["refunded", "reserved"]),
    retryEligibility: generationRetryEligibilitySchema,
    createdAt: adminIsoDateTimeSchema,
    updatedAt: adminIsoDateTimeSchema,
  })
  .strict();

export const generationDeadLetterListResponseSchema = adminListResponseSchema(
  generationDeadLetterItemSchema,
).extend({ dataScope: generationJobDataScopeSchema });

export const generationDeadLetterBatchRequestSchema = z
  .object({
    jobIds: z.array(z.string().trim().min(1).max(160)).min(1).max(100),
    reason: z.string().trim().min(3).max(2_000),
    confirmation: z.string().trim().min(1).max(20_000),
  })
  .strict();

const generationDeadLetterSkipSchema = z
  .object({ id: adminIdSchema, reason: z.string().min(1) })
  .strict();

export const generationDeadLetterRequeueBatchResultSchema = z
  .object({
    requeued: z.array(adminIdSchema).readonly(),
    skipped: z.array(generationDeadLetterSkipSchema).readonly(),
  })
  .strict();

export const generationDeadLetterDiscardBatchResultSchema = z
  .object({
    discarded: z.array(adminIdSchema).readonly(),
    refunded: z.array(adminIdSchema).readonly(),
    skipped: z.array(generationDeadLetterSkipSchema).readonly(),
  })
  .strict();

/** SPEC: a single-request requeue keeps v1's optional reason — the confirmation is the job id. */
export const generationDeadLetterRequeueRequestSchema = z
  .object({
    reason: z.string().trim().max(2_000).optional(),
    confirmation: z.string().trim().min(1).max(160),
  })
  .strict();

export const generationDeadLetterRequeueResultSchema = z
  .object({
    queued: z.literal(true),
    attemptId: adminIdSchema,
    attemptNo: z.number().int().positive(),
  })
  .strict();

export const generationDeadLetterDiscardResultSchema = z
  .object({ discarded: z.literal(true), refunded: z.boolean() })
  .strict();

// ---------------------------------------------------------------------------
// Backend and workflow diagnostics
// ---------------------------------------------------------------------------

export const generationBackendListResponseSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            id: z.string().min(1),
            kind: z.string().min(1),
            endpoint: z.string().min(1).optional(),
            cliPath: z.string().min(1).optional(),
            modelsDir: z.string().min(1).optional(),
            health: z
              .object({
                ok: z.boolean(),
                detail: z.string().min(1).optional(),
                latencyMs: z.number().int().nonnegative().optional(),
              })
              .strict(),
          })
          .strict(),
      )
      .readonly(),
  })
  .strict();

const generationWorkflowSlotSchema = z
  .object({
    key: z.string().min(1),
    type: z.enum(["text", "int", "float", "image"]),
    target: z.union([
      z.object({ nodeId: z.string().min(1), field: z.string().min(1) }).strict(),
      z.object({ argFlag: z.string().min(1) }).strict(),
    ]),
    default: z.union([z.string(), z.number()]).optional(),
    additionalTargets: z
      .array(z.object({ nodeId: z.string().min(1), field: z.string().min(1) }).strict())
      .readonly()
      .optional(),
    referenceRoles: z.array(z.string().min(1)).readonly().optional(),
    required: z.boolean().optional(),
  })
  .strict();

const generationWorkflowSummarySchema = z
  .object({
    workflowKey: z.string().min(1),
    modelId: z.string().min(1),
    backendKind: z.enum(["comfyui", "drawthings"]),
    version: z.number().int().positive(),
    capabilities: z.array(z.string().min(1)).readonly(),
    inputs: z.array(generationWorkflowSlotSchema).readonly(),
  })
  .strict();

export const generationWorkflowListResponseSchema = z
  .object({ items: z.array(generationWorkflowSummarySchema).readonly() })
  .strict();

/**
 * SPEC: the full descriptor, including the raw ComfyUI graph.
 * INTENT: `apiPrompt` stays an opaque JSON value — it is a node graph keyed by node id, and
 * pinning its shape here would make the admin contract co-own the ComfyUI wire format.
 */
export const generationWorkflowDetailResponseSchema = z
  .object({
    workflow: z
      .object({
        workflowKey: z.string().min(1),
        modelId: z.string().min(1),
        backendKind: z.enum(["comfyui", "drawthings"]),
        version: z.number().int().positive(),
        capabilities: z.array(z.string().min(1)).readonly(),
        identity: z
          .object({
            mode: z.string().min(1),
            maxReferences: z.number().int().nonnegative(),
            acceptedRoles: z.array(z.string().min(1)).readonly(),
            supportsLookReference: z.boolean(),
            supportsSourceImageWithIdentity: z.boolean(),
          })
          .strict(),
        quality: z
          .object({
            maxCandidates: z.number().int().positive(),
            evaluatorDimensions: z.array(z.string().min(1)).readonly(),
          })
          .strict(),
        inputs: z.array(generationWorkflowSlotSchema).readonly(),
        comfyWorkflow: z.object({ id: z.string().min(1), name: z.string().min(1) }).strict().optional(),
        apiPrompt: adminJsonValueSchema.optional(),
        drawThings: z.object({ model: z.string().min(1) }).strict().optional(),
      })
      .strict(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Generation metrics
// ---------------------------------------------------------------------------

export const generationMetricsQuerySchema = z
  .object({ days: z.coerce.number().int().min(1).max(90).optional() })
  .strict();

const generationStatusBucketsSchema = {
  total: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
};

export const generationMetricsResponseSchema = z
  .object({
    dataScope: generationMetricDataScopeSchema,
    windowDays: z.number().int().positive(),
    profiles: z
      .array(
        z
          .object({
            ...generationStatusBucketsSchema,
            profileId: z.string().min(1),
            profileVersion: z.number().int().nullable(),
            costDreamcoins: z.number().int(),
            label: z.string().min(1).nullable(),
            workflowKey: z.string().min(1).nullable(),
            avgDurationMs: z.number().nullable(),
          })
          .strict(),
      )
      .readonly(),
    recipes: z
      .array(
        z
          .object({
            ...generationStatusBucketsSchema,
            recipeId: z.string().min(1),
            costDreamcoins: z.number().int(),
          })
          .strict(),
      )
      .readonly(),
    sources: z
      .array(
        z
          .object({
            ...generationStatusBucketsSchema,
            sourceType: z.string().min(1),
            costDreamcoins: z.number().int(),
          })
          .strict(),
      )
      .readonly(),
    placements: z
      .array(
        z
          .object({
            slot: z.string().min(1),
            status: z.string().min(1),
            count: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .readonly(),
    placementEngagement: z
      .array(
        z
          .object({
            slot: z.string().min(1).nullable(),
            placementId: z.string().min(1).nullable(),
            impressions: z.number().int().nonnegative(),
            clicks: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .readonly(),
    remix: z.object({ total: z.number().int().nonnegative() }).strict(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Provider operations rollup
// ---------------------------------------------------------------------------

export const generationProviderOpsQuerySchema = z
  .object({
    from: z.string().trim().min(1).optional(),
    to: z.string().trim().min(1).optional(),
  })
  .strict();

export const generationProviderOpsResponseSchema = z
  .object({
    dataScope: generationMetricDataScopeSchema,
    window: z
      .object({ from: adminIsoDateTimeSchema, to: adminIsoDateTimeSchema })
      .strict(),
    providers: z
      .array(
        z
          .object({
            provider: z.string().min(1),
            total: z.number().int().nonnegative(),
            completed: z.number().int().nonnegative(),
            failed: z.number().int().nonnegative(),
            blocked: z.number().int().nonnegative(),
            coinsCost: z.number().int(),
            successRate: z.number().nullable(),
            avgCostPerJob: z.number(),
            latencyP50Ms: z.number().nullable(),
            latencyP95Ms: z.number().nullable(),
            latencySamples: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .readonly(),
  })
  .strict();

export type GenerationModelProfile = z.infer<typeof generationModelProfileSchema>;
export type GenerationRecipe = z.infer<typeof generationRecipeSchema>;
export type GenerationPreset = z.infer<typeof generationPresetSchema>;
export type GenerationDeadLetterItem = z.infer<typeof generationDeadLetterItemSchema>;
