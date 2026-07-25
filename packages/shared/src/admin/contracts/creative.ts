import { z } from "zod";
import {
  adminCursorQuerySchema,
  adminCommandRequestSchema,
  adminEntityRefSchema,
  adminIdSchema,
  adminIsoDateTimeSchema,
  adminListResponseSchema,
  adminPrioritySchema,
  adminVerificationStateSchema,
} from "./common";

export const creativeRunRetryFailedCommandRequestSchema = adminCommandRequestSchema;
export const creativeRunAttachIncidentRequestSchema = z.object({
  entityVersion: z.number().int().nonnegative(),
  incidentId: adminIdSchema,
  reason: z.string().trim().min(3).max(2_000),
}).strict();

export const characterRouteEvaluationMatrixSchemaVersion =
  "character-identity-v1";
export const characterRouteEvaluationOutputsPerDirection = 4;
export const characterRouteEvaluationMatrixDirections = [
  {
    id: "eval-front-soft",
    title: "Front portrait, soft light",
    scenePrompt: "Front-facing portrait with a calm expression and clean soft lighting.",
    mood: "calm",
    setting: "neutral studio",
    outfit: "signature everyday outfit",
    camera: "portrait close-up",
    lighting: "soft frontal light",
  },
  {
    id: "eval-three-quarter",
    title: "Three-quarter portrait",
    scenePrompt: "Three-quarter portrait preserving the exact face, hair, and body identity.",
    mood: "warm",
    setting: "quiet interior",
    outfit: "signature everyday outfit",
    camera: "three-quarter medium portrait",
    lighting: "soft window light",
  },
  {
    id: "eval-profile",
    title: "Side profile",
    scenePrompt: "Natural side-profile portrait with the character identity clearly visible.",
    mood: "reflective",
    setting: "minimal interior",
    outfit: "simple fitted outfit",
    camera: "side-profile close-up",
    lighting: "gentle rim light",
  },
  {
    id: "eval-smile",
    title: "Expressive smile",
    scenePrompt: "Warm smiling portrait without changing the character's stable identity.",
    mood: "playful",
    setting: "bright living room",
    outfit: "casual companion look",
    camera: "eye-level medium close-up",
    lighting: "bright natural light",
  },
  {
    id: "eval-low-light",
    title: "Low-light portrait",
    scenePrompt: "Intimate low-light portrait that keeps facial identity and hairstyle stable.",
    mood: "intimate",
    setting: "evening bedroom",
    outfit: "elegant evening look",
    camera: "cinematic close-up",
    lighting: "warm practical low light",
  },
  {
    id: "eval-outdoor",
    title: "Outdoor daylight",
    scenePrompt: "Outdoor daylight portrait preserving the exact canonical identity.",
    mood: "confident",
    setting: "city garden",
    outfit: "daytime street style",
    camera: "waist-up portrait",
    lighting: "open shade daylight",
  },
  {
    id: "eval-seated",
    title: "Seated medium shot",
    scenePrompt: "Relaxed seated medium shot with natural hands and stable body proportions.",
    mood: "comfortable",
    setting: "cozy lounge",
    outfit: "soft casual outfit",
    camera: "seated medium shot",
    lighting: "balanced interior light",
  },
  {
    id: "eval-standing",
    title: "Standing full body",
    scenePrompt: "Standing full-body portrait preserving face, hair, body type, and signature traits.",
    mood: "self-assured",
    setting: "clean apartment",
    outfit: "signature full-body look",
    camera: "full-body portrait",
    lighting: "soft directional light",
  },
  {
    id: "eval-dynamic",
    title: "Natural movement",
    scenePrompt: "A natural walking moment with stable identity and realistic body structure.",
    mood: "lively",
    setting: "sunlit corridor",
    outfit: "casual movement-friendly outfit",
    camera: "dynamic medium-full shot",
    lighting: "directional daylight",
  },
  {
    id: "eval-chat",
    title: "Companion chat moment",
    scenePrompt: "Close companion chat moment with direct eye contact and exact identity preservation.",
    mood: "affectionate",
    setting: "private conversational space",
    outfit: "relaxed companion outfit",
    camera: "chat-ready close-up",
    lighting: "warm flattering light",
  },
] as const;
export const characterRouteEvaluationSampleCount =
  characterRouteEvaluationMatrixDirections.length *
  characterRouteEvaluationOutputsPerDirection;

export function characterRouteEvaluationMatrixKey(style: string) {
  return `${style}-identity-v1`;
}

function isCanonicalCharacterRouteEvaluationMatrix(input: {
  readonly directions?: readonly unknown[];
  readonly outputsPerDirection?: number;
  readonly count: number;
}) {
  return input.count === characterRouteEvaluationSampleCount &&
    input.outputsPerDirection === characterRouteEvaluationOutputsPerDirection &&
    JSON.stringify(input.directions) ===
      JSON.stringify(characterRouteEvaluationMatrixDirections);
}

export const creativeRunCreateRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(160).optional(),
    purpose: z.enum([
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
    ]),
    targetType: z.enum(["character", "route_page", "campaign", "template", "none"]),
    targetId: adminIdSchema.optional(),
    profileId: adminIdSchema,
    recipeId: adminIdSchema.optional(),
    presetIds: z.array(adminIdSchema).max(12).default([]),
    referenceAssetIds: z.array(adminIdSchema).max(4).default([]),
    bootstrapIdentity: z.boolean().default(false),
    orientation: z.string().trim().min(1).max(20).optional(),
    count: z.number().int().min(1).max(40).default(4),
    brief: z.string().trim().min(1).max(2_000),
    directions: z.array(z.object({
      id: adminIdSchema,
      title: z.string().trim().min(2).max(80),
      scenePrompt: z.string().trim().min(12).max(1_200),
      mood: z.string().trim().min(1).max(120),
      setting: z.string().trim().min(1).max(120),
      outfit: z.string().trim().min(1).max(120),
      camera: z.string().trim().min(1).max(120),
      lighting: z.string().trim().min(1).max(120),
    }).strict()).min(1).max(12).optional(),
    outputsPerDirection: z.number().int().min(1).max(24).optional(),
    routeEvaluationMatrixKey: z.string().trim().min(1).max(160).optional(),
    identityExperiment: z.object({
      mode: z.enum(["text_to_image", "image_to_image"]),
      negativePrompt: z.string().trim().max(2_000).default(""),
      seedStrategy: z.enum(["random", "locked", "reuse_source"]),
      baseSeed: z.string().trim().min(1).max(200).optional(),
      sourceAssetId: adminIdSchema.optional(),
      strength: z.number().min(0.1).max(1).default(0.65),
    }).strict().optional(),
    consistencyMode: z.enum(["strict", "balanced", "creative"]).default("balanced"),
    dueAt: adminIsoDateTimeSchema.optional(),
    priority: adminPrioritySchema.default("normal"),
    reason: z.string().trim().min(3).max(2_000),
  })
  .strict()
  .superRefine((request, ctx) => {
    const characterPurpose = [
      "character_cover",
      "character_hero",
      "character_chat",
      "identity_calibration",
    ]
      .includes(request.purpose);
    const genericPurpose = ["feed", "homepage", "seo", "template_cover", "campaign"]
      .includes(request.purpose);
    if (request.targetType !== "none" && !request.targetId) {
      ctx.addIssue({ code: "custom", path: ["targetId"], message: "Target ID is required for this target type" });
    }
    if (request.targetType === "none" && request.targetId) {
      ctx.addIssue({ code: "custom", path: ["targetId"], message: "Target ID must be omitted for a targetless Run" });
    }
    if (characterPurpose && request.targetType !== "character") {
      ctx.addIssue({
        code: "custom",
        path: ["targetType"],
        message: "Character image purposes must use the dedicated Character target workflow",
      });
    }
    if (genericPurpose && request.targetType !== "none") {
      ctx.addIssue({
        code: "custom",
        path: ["targetType"],
        message: "Generic image Runs must remain targetless until an artifact is reviewed",
      });
    }
    if (!request.directions && request.outputsPerDirection !== undefined) {
      ctx.addIssue({ code: "custom", path: ["outputsPerDirection"], message: "Outputs per direction requires persisted directions" });
    }
    const outputLimit = request.purpose === "model_eval" ? 40 : 24;
    if (request.count > outputLimit) {
      ctx.addIssue({
        code: "custom",
        path: ["count"],
        message: `A ${request.purpose === "model_eval" ? "model evaluation" : "Creative"} Run cannot exceed ${outputLimit} outputs`,
      });
    }
    if (request.directions && request.directions.length * (request.outputsPerDirection ?? 1) > outputLimit) {
      ctx.addIssue({ code: "custom", path: ["outputsPerDirection"], message: `This Run cannot exceed ${outputLimit} outputs` });
    }
    if (
      request.bootstrapIdentity &&
      (request.targetType !== "character" || request.purpose !== "character_cover")
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["bootstrapIdentity"],
        message: "Identity bootstrap is only valid for a Character primary portrait Run",
      });
    }
    if (request.bootstrapIdentity && request.referenceAssetIds.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["referenceAssetIds"],
        message: "Identity bootstrap cannot depend on an existing Character reference",
      });
    }
    if (request.targetType !== "character" && request.referenceAssetIds.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["referenceAssetIds"],
        message: "Generic image production is text-to-image only and cannot accept reference assets",
      });
    }
    if (request.purpose === "model_eval" && request.targetType !== "character") {
      ctx.addIssue({
        code: "custom",
        path: ["targetType"],
        message: "Identity route evaluation must pin a Character and its current reference authority",
      });
    }
    if (request.purpose === "model_eval" && request.referenceAssetIds.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["referenceAssetIds"],
        message: "Route evaluation uses only the Character's sealed canonical Reference Set",
      });
    }
    if (
      request.purpose === "model_eval" &&
      !isCanonicalCharacterRouteEvaluationMatrix(request)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["directions"],
        message: "Route evaluation must use the canonical 10-direction, 40-sample matrix",
      });
    }
    if (
      request.purpose === "model_eval" &&
      !request.routeEvaluationMatrixKey
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["routeEvaluationMatrixKey"],
        message: "Route evaluation must pin the canonical matrix key",
      });
    }
    if (
      request.purpose !== "model_eval" &&
      request.routeEvaluationMatrixKey !== undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["routeEvaluationMatrixKey"],
        message: "Only route evaluation Runs may pin a route evaluation matrix key",
      });
    }
    if (request.purpose === "identity_calibration" && !request.identityExperiment) {
      ctx.addIssue({
        code: "custom",
        path: ["identityExperiment"],
        message: "Identity calibration must preserve an immutable experiment snapshot",
      });
    }
    if (request.purpose !== "identity_calibration" && request.identityExperiment) {
      ctx.addIssue({
        code: "custom",
        path: ["identityExperiment"],
        message: "Only identity calibration Runs may include an identity experiment snapshot",
      });
    }
    if (request.purpose === "identity_calibration" && request.referenceAssetIds.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["referenceAssetIds"],
        message: "Identity calibration sources must be pinned through the experiment snapshot",
      });
    }
    if (
      request.identityExperiment?.mode === "text_to_image" &&
      request.identityExperiment.sourceAssetId
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["identityExperiment", "sourceAssetId"],
        message: "Text-to-image calibration cannot include a source image",
      });
    }
    if (
      request.identityExperiment?.mode === "image_to_image" &&
      !request.identityExperiment.sourceAssetId
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["identityExperiment", "sourceAssetId"],
        message: "Image-to-image calibration requires a source image",
      });
    }
    if (
      request.identityExperiment?.seedStrategy === "locked" &&
      !request.identityExperiment.baseSeed
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["identityExperiment", "baseSeed"],
        message: "Locked seed calibration requires a base seed",
      });
    }
    if (
      request.identityExperiment?.seedStrategy === "reuse_source" &&
      request.identityExperiment.mode !== "image_to_image"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["identityExperiment", "seedStrategy"],
        message: "Source seed reuse is only valid for image-to-image calibration",
      });
    }
  });

export const creativeRunCreateResultSchema = z.object({
  batch: z.object({ id: adminIdSchema }).strict(),
  replayed: z.boolean(),
}).strict();

export const creativeRunGenericPurposeSchema = z.enum([
  "campaign",
  "homepage",
  "feed",
  "seo",
  "template_cover",
]);

export const creativeRunCreateOptionsSchema = z.object({
  purposes: z.array(z.object({
    value: creativeRunGenericPurposeSchema,
    label: z.string().trim().min(1),
    description: z.string().trim().min(1),
    defaultOrientation: z.string().trim().min(1),
    runtimePlacementSupported: z.boolean(),
  }).strict()).min(1).readonly(),
  profiles: z.array(z.object({
    profileKey: adminIdSchema,
    profileVersion: z.number().int().positive(),
    label: z.string().trim().min(1),
    workflowKey: z.string().trim().min(1),
    workflowVersion: z.number().int().positive(),
    allowedOrientations: z.array(z.string().trim().min(1)).min(1).readonly(),
    recommended: z.boolean(),
  }).strict()).readonly(),
  readiness: z.object({
    ready: z.boolean(),
    blocker: z.string().trim().min(1).nullable(),
  }).strict(),
  characterAssetStudioHref: z.string().trim().min(1),
}).strict();

export const creativeReviewQualityEvidenceSchema = z.object({
  artifactFree: z.boolean(),
  singleSubject: z.boolean(),
  intentMatch: z.boolean(),
  noVisibleText: z.boolean(),
}).strict();

export const creativeReviewEvidenceSchema = z.object({
  quality: creativeReviewQualityEvidenceSchema,
}).strict();

export const creativeReviewDecisionRequestSchema = z.object({
  entityVersion: z.number().int().nonnegative(),
  supersedesDecisionId: adminIdSchema.optional(),
  decision: z.enum(["approved", "rejected"]),
  identityConsistency: z.enum(["passed", "failed", "unscored"]),
  score: z.number().int().min(0).max(100).optional(),
  quality: creativeReviewQualityEvidenceSchema.optional(),
  reason: z.string().trim().min(3).max(2_000),
});

function isSafeCampaignHref(value: string) {
  if (
    value.startsWith("//") ||
    value.includes("\\") ||
    /[\u0000-\u001F\u007F]/.test(value)
  ) {
    return false;
  }
  if (value.startsWith("/")) {
    try {
      return new URL(value, "https://community.invalid").origin ===
        "https://community.invalid";
    } catch {
      return false;
    }
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.username === "" &&
      url.password === "";
  } catch {
    return false;
  }
}

export const creativePlacementPublishRequestSchema = z.object({
  entityVersion: z.number().int().nonnegative(),
  itemId: adminIdSchema,
  assetId: adminIdSchema,
  slot: z.literal("campaign"),
  targetType: z.literal("campaign"),
  targetId: adminIdSchema,
  eyebrow: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(120),
  ctaLabel: z.string().trim().min(1).max(60).optional(),
  href: z.string().trim().min(1).max(512).refine(
    isSafeCampaignHref,
    "Expected a safe internal path or HTTPS URL",
  ).optional(),
  reason: z.string().trim().min(3).max(2_000),
}).strict().superRefine((value, context) => {
  if (Boolean(value.ctaLabel) === Boolean(value.href)) return;
  context.addIssue({
    code: "custom",
    message: "CTA label and href must be provided together",
    path: value.ctaLabel ? ["href"] : ["ctaLabel"],
  });
});

export const creativePlacementVerificationRequestSchema = z.object({
  entityVersion: z.number().int().nonnegative(),
  reason: z.string().trim().min(3).max(2_000),
});

export const creativePlacementWithdrawalRequestSchema = z.object({
  entityVersion: z.number().int().nonnegative(),
  reason: z.string().trim().min(3).max(2_000),
});

export const creativeRunAttachIncidentResultSchema = z.object({
  runId: adminIdSchema,
  incidentId: adminIdSchema,
  relatedAttemptIds: z.array(adminIdSchema).readonly(),
  runVersion: z.number().int().positive(),
  incidentVersion: z.number().int().positive(),
}).strict();

export const creativeReviewDecisionResultSchema = z.object({
  runId: adminIdSchema,
  itemId: adminIdSchema,
  decisionId: adminIdSchema,
  decision: z.enum(["approved", "rejected"]),
  workflowStage: z.enum(["brief", "directions", "generation", "review", "placement", "verification"]),
  version: z.number().int().positive(),
}).strict();

export const creativePlacementPublishResultSchema = z.object({
  runId: adminIdSchema,
  placementId: adminIdSchema,
  verificationState: adminVerificationStateSchema,
  rollbackPlacementId: adminIdSchema.nullable(),
  runVersion: z.number().int().positive(),
}).strict();

export const creativePlacementVerificationResultSchema = z.object({
  runId: adminIdSchema,
  placementId: adminIdSchema,
  verificationState: adminVerificationStateSchema,
  checks: z.object({
    runtimeSurfaceSupported: z.boolean(),
    placementVisibleInRuntime: z.boolean(),
    renderedAssetMatches: z.boolean(),
    assetValid: z.boolean(),
  }).strict(),
  runVersion: z.number().int().positive(),
}).strict();

export const creativePlacementWithdrawalResultSchema = z.object({
  runId: adminIdSchema,
  placementId: adminIdSchema,
  verificationState: z.literal("overridden"),
  runVersion: z.number().int().positive(),
}).strict();

export const creativeLifecycleStateSchema = z.enum(["draft", "active", "closed", "archived"]);
export const creativeRunItemStatusSchema = z.enum([
  "queued",
  "generated",
  "approved",
  "rejected",
  "regenerate_requested",
  "published",
  "failed",
]);
export const creativeRunItemExecutionStateSchema = z.enum([
  "dispatching",
  "provider_queued",
  "generating",
  "finalizing",
  "ready",
  "failed",
]);
export const creativeIdentityReviewModeSchema = z.enum([
  "defines_identity",
  "preserves_identity",
  "not_applicable",
]);
export const creativeWorkflowStageSchema = z.enum([
  "brief",
  "directions",
  "generation",
  "review",
  "placement",
  "verification",
]);
export const creativeExecutionOutcomeSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "partially_succeeded",
  "failed",
  "cancelled",
]);
export const creativeReviewStateSchema = z.enum(["not_ready", "pending", "in_review", "complete"]);
export const creativeDeploymentStateSchema = z.enum(["unplaced", "partially_placed", "placed"]);
export const creativeSettlementViewSchema = z.enum([
  "not_required",
  "captured",
  "partially_refunded",
  "refunded",
]);

export const creativeRetryEligibilitySchema = z
  .object({
    eligibleItemIds: z.array(adminIdSchema).readonly(),
    eligibleCount: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.eligibleItemIds.length !== value.eligibleCount) {
      ctx.addIssue({
        code: "custom",
        path: ["eligibleCount"],
        message: "Eligible count must match the frozen item set",
      });
    }
  });

export const creativeRunCountsSchema = z
  .object({
    generated: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    reviewed: z.number().int().nonnegative(),
    approved: z.number().int().nonnegative(),
    placed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((counts, ctx) => {
    const issues: Array<[keyof typeof counts, boolean, string]> = [
      ["generated", counts.generated + counts.failed <= counts.total, "Generated plus failed exceeds total"],
      ["reviewed", counts.reviewed <= counts.generated, "Reviewed exceeds generated"],
      ["approved", counts.approved <= counts.reviewed, "Approved exceeds reviewed"],
      ["placed", counts.placed <= counts.approved, "Placed exceeds approved"],
    ];
    for (const [field, valid, message] of issues) {
      if (!valid) ctx.addIssue({ code: "custom", path: [field], message });
    }
  });

export type CreativeRunCounts = z.infer<typeof creativeRunCountsSchema>;
export type CreativeExecutionOutcome = z.infer<typeof creativeExecutionOutcomeSchema>;

export function deriveCreativeExecutionOutcome(
  counts: CreativeRunCounts,
): Extract<CreativeExecutionOutcome, "succeeded" | "partially_succeeded" | "failed"> {
  creativeRunCountsSchema.parse(counts);
  if (counts.total > 0 && counts.generated === counts.total) return "succeeded";
  if (counts.generated > 0) return "partially_succeeded";
  return "failed";
}

export const creativeErrorClusterSchema = z
  .object({
    signature: z.string().trim().min(1),
    errorClass: z.string().trim().min(1),
    errorCode: z.string().trim().min(1),
    retryability: z.enum(["retryable", "not_retryable", "unknown"]),
    affectedItemCount: z.number().int().positive(),
    operatorGuidance: z.string().trim().min(1),
  })
  .strict();

const creativeRunBaseSchema = z
  .object({
    id: adminIdSchema,
    purpose: z.string().trim().min(1),
    target: adminEntityRefSchema,
    ownerId: adminIdSchema.nullable(),
    dueAt: adminIsoDateTimeSchema.nullable(),
    priority: adminPrioritySchema,
    lifecycleState: creativeLifecycleStateSchema,
    workflowStage: creativeWorkflowStageSchema,
    executionOutcome: creativeExecutionOutcomeSchema,
    reviewState: creativeReviewStateSchema,
    deploymentState: creativeDeploymentStateSchema,
    verificationState: adminVerificationStateSchema,
    counts: creativeRunCountsSchema,
    errorClusters: z.array(creativeErrorClusterSchema).readonly().optional(),
    relatedIncidentIds: z.array(adminIdSchema).readonly().optional(),
    version: z.number().int().nonnegative(),
    createdAt: adminIsoDateTimeSchema,
    updatedAt: adminIsoDateTimeSchema,
  })
  .strict();

function validateCreativeRunOutcome(
  run: z.infer<typeof creativeRunBaseSchema>,
  ctx: { addIssue(issue: { code: "custom"; path: string[]; message: string }): void },
) {
    if (!creativeRunCountsSchema.safeParse(run.counts).success) return;
    if (
      ["succeeded", "partially_succeeded", "failed"].includes(run.executionOutcome) &&
      deriveCreativeExecutionOutcome(run.counts) !== run.executionOutcome
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["executionOutcome"],
        message: "Execution outcome does not match item facts",
      });
    }
}

export const creativeRunSchema = creativeRunBaseSchema.superRefine(validateCreativeRunOutcome);

export const creativeAssetLineageSchema = z
  .object({
    briefId: adminIdSchema,
    directionId: adminIdSchema,
    generationProfileKey: z.string().trim().min(1),
    generationProfileVersion: z.string().trim().min(1),
    workflowKey: z.string().trim().min(1),
    workflowVersion: z.string().trim().min(1),
    requestId: adminIdSchema,
    attemptId: adminIdSchema,
    assetId: adminIdSchema,
    reviewDecisionId: adminIdSchema.nullable(),
    placementVersionId: adminIdSchema.nullable(),
  })
  .strict();

export const creativeRunQuerySchema = adminCursorQuerySchema.extend({
  lifecycleState: creativeLifecycleStateSchema.optional(),
  workflowStage: creativeWorkflowStageSchema.optional(),
  executionOutcome: creativeExecutionOutcomeSchema.optional(),
  ownerId: adminIdSchema.optional(),
  priority: adminPrioritySchema.optional(),
  targetType: z.enum(["character", "route_page", "campaign", "template", "none"]).optional(),
  targetId: adminIdSchema.optional(),
  sort: z.enum(["id_asc", "updated_desc"]).default("id_asc"),
});

export const creativeRunListResponseSchema = adminListResponseSchema(creativeRunSchema);

export const creativeRunItemDetailSchema = z
  .object({
    id: adminIdSchema,
    ordinal: z.number().int().nonnegative(),
    status: creativeRunItemStatusSchema,
    executionState: creativeRunItemExecutionStateSchema,
    identityReviewMode: creativeIdentityReviewModeSchema,
    version: z.number().int().nonnegative(),
    retryability: z.string(),
    direction: z.object({
      title: z.string().trim().min(1),
      scenePrompt: z.string().trim().min(1),
      mood: z.string().trim().min(1),
      setting: z.string().trim().min(1),
      outfit: z.string().trim().min(1),
      camera: z.string().trim().min(1),
      lighting: z.string().trim().min(1),
    }).strict().nullable(),
    lineage: z
      .object({
        briefId: adminIdSchema,
        directionId: adminIdSchema.nullable(),
        directionHash: z.string().trim().min(1).nullable(),
        generationProfileKey: z.string().trim().min(1).nullable(),
        generationProfileVersion: z.string().trim().min(1).nullable(),
        workflowKey: z.string().trim().min(1).nullable(),
        workflowVersion: z.string().trim().min(1).nullable(),
        requestId: adminIdSchema.nullable(),
        attemptId: adminIdSchema.nullable(),
        providerRequestId: z.string().trim().min(1).nullable(),
        seed: z.string().trim().min(1).nullable().optional(),
        assetId: adminIdSchema.nullable(),
        reviewDecisionId: adminIdSchema.nullable(),
        placementVersionId: adminIdSchema.nullable(),
      })
      .strict(),
    asset: z
      .object({
        id: adminIdSchema,
        url: z.string().trim().min(1),
        thumbnailUrl: z.string().trim().min(1).nullable(),
        width: z.number().int().positive().nullable(),
        height: z.number().int().positive().nullable(),
      })
      .strict()
      .nullable(),
    review: z
      .object({
        id: adminIdSchema,
        supersedesDecisionId: adminIdSchema.nullable(),
        decision: z.enum(["approved", "rejected"]),
        identityConsistency: z.enum(["passed", "failed", "unscored"]),
        score: z.number().int().min(0).max(100).nullable(),
        quality: creativeReviewQualityEvidenceSchema.nullable(),
        reason: z.string(),
        reviewerId: adminIdSchema,
        createdAt: adminIsoDateTimeSchema,
      })
      .strict()
      .nullable(),
    placement: z
      .object({
        id: adminIdSchema,
        slot: z.string(),
        targetType: z.string(),
        targetId: adminIdSchema,
        status: z.string(),
        verificationState: adminVerificationStateSchema,
        verifiedAt: adminIsoDateTimeSchema.nullable(),
        rollbackPlacementId: adminIdSchema.nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const creativeRunDetailSchema = creativeRunBaseSchema
  .omit({ errorClusters: true })
  .extend({
    title: z.string().trim().min(1),
    reviewContext: z.object({
      brief: z.string().trim().min(1),
      orientation: z.string().trim().min(1).nullable(),
      profile: z.object({
        key: z.string().trim().min(1).nullable(),
        version: z.number().int().positive().nullable(),
        label: z.string().trim().min(1).nullable(),
      }).strict(),
      recipe: z.object({
        key: z.string().trim().min(1).nullable(),
        version: z.number().int().positive().nullable(),
        label: z.string().trim().min(1).nullable(),
      }).strict(),
      referenceAssetCount: z.number().int().nonnegative(),
      experiment: z.object({
        mode: z.enum(["text_to_image", "image_to_image"]),
        positivePrompt: z.string().trim().min(1),
        negativePrompt: z.string(),
        seedStrategy: z.enum(["random", "locked", "reuse_source"]),
        baseSeed: z.string().nullable(),
        sourceAssetId: adminIdSchema.nullable(),
        strength: z.number().min(0.1).max(1),
      }).strict().nullable().optional(),
    }).strict(),
    settlementView: creativeSettlementViewSchema,
    retryEligibility: creativeRetryEligibilitySchema,
    legacyState: z.string().trim().min(1),
    items: z.array(creativeRunItemDetailSchema).readonly(),
  })
  .strict()
  .superRefine(validateCreativeRunOutcome);

export type CreativeRun = z.infer<typeof creativeRunSchema>;
export type CreativeRunCreateOptions = z.infer<typeof creativeRunCreateOptionsSchema>;
export type CreativeAssetLineage = z.infer<typeof creativeAssetLineageSchema>;
export type CreativeRunQuery = z.infer<typeof creativeRunQuerySchema>;
export type CreativeRunDetail = z.infer<typeof creativeRunDetailSchema>;
export type CreativeRunRetryFailedCommandRequest = z.infer<
  typeof creativeRunRetryFailedCommandRequestSchema
>;
export type CreativeReviewDecisionRequest = z.infer<typeof creativeReviewDecisionRequestSchema>;
export type CreativePlacementPublishRequest = z.infer<typeof creativePlacementPublishRequestSchema>;
export type CreativePlacementVerificationRequest = z.infer<typeof creativePlacementVerificationRequestSchema>;
export type CreativePlacementWithdrawalRequest = z.infer<typeof creativePlacementWithdrawalRequestSchema>;
export type CreativeRunAttachIncidentResult = z.infer<typeof creativeRunAttachIncidentResultSchema>;
export type CreativeReviewDecisionResult = z.infer<typeof creativeReviewDecisionResultSchema>;
export type CreativePlacementPublishResult = z.infer<typeof creativePlacementPublishResultSchema>;
export type CreativePlacementVerificationResult = z.infer<typeof creativePlacementVerificationResultSchema>;
export type CreativePlacementWithdrawalResult = z.infer<typeof creativePlacementWithdrawalResultSchema>;
