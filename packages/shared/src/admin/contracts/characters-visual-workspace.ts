// SPEC: Character visual workspace — visual identity versions, looks, reference sets,
// calibration/route-evaluation/bootstrap profiles, image readiness, preview snapshot,
// and the Character workspace aggregates built on top of them.

import { z } from "zod";
import {
  adminCommandStatusSchema,
  adminCommandReasonSchema,
  adminIdSchema,
  adminIsoDateTimeSchema,
} from "./common";
import {
  characterProjectPhaseSchema,
} from "./characters-common";
import {
  generationRouteQualificationResultSchema,
} from "./characters-qualification";
import {
  characterQaRunSchema,
  characterServingSchema,
  characterWorkspaceReleaseSchema,
} from "./characters-release";
import {
  characterPerformanceSummarySchema,
  characterPortfolioDecisionRecordSchema,
  characterProductionJourneySchema,
  characterReleaseChangeMarkerSchema,
} from "./characters-performance";
import {
  characterMediaOperationsProjectionSchema,
  characterVoiceWorkspaceSchema,
} from "./characters-media-operations";

export const characterVisualStyleSchema = z.enum(["realistic", "anime", "hybrid", "other"]);

export const characterVisualIdentityStatusSchema = z.enum(["draft", "active", "archived", "superseded", "retired"]);

export const characterVisualReferenceSetStatusSchema = z.enum(["draft", "active", "superseded"]);

export const characterVisualReferenceRoleSchema = z.enum(["primary_face", "identity_anchor", "identity_reference"]);

export const CHARACTER_CANONICAL_PORTRAIT_IDENTITY_PROMPT =
  "Preserve the exact same adult person shown in the canonical identity portrait, including facial geometry, eyes, nose, lips, skin tone, hairline, age presentation, body proportions, and signature marks";

export const characterVisualProfileCreateRequestSchema = z
  .object({
    identityPrompt: z.string().trim().min(1).max(2_000).optional(),
    negativeIdentityPrompt: z.string().trim().max(2_000).optional(),
    style: characterVisualStyleSchema.optional(),
    defaultSeed: z.string().trim().max(200).optional(),
    faceTraits: z.record(z.string(), z.unknown()).optional(),
    hairTraits: z.record(z.string(), z.unknown()).optional(),
    bodyTraits: z.record(z.string(), z.unknown()).optional(),
    signatureTraits: z.record(z.string(), z.unknown()).optional(),
    styleTraits: z.record(z.string(), z.unknown()).optional(),
    candidateAuthority: z
      .object({
        runId: adminIdSchema,
        itemId: adminIdSchema,
        assetId: adminIdSchema,
        reviewDecisionId: adminIdSchema,
      })
      .strict()
      .optional(),
    reason: z.string().trim().min(3).max(2_000),
    confirmation: z.string().trim().min(1).max(200),
  })
  .superRefine((value, context) => {
    if (value.candidateAuthority && !value.identityPrompt) {
      context.addIssue({
        code: "custom",
        path: ["identityPrompt"],
        message:
          "Activating an identity candidate requires an explicit visual identity prompt",
      });
    }
    if (!value.candidateAuthority) return;
    const requiredStructuredTraits = [
      ["faceTraits", value.faceTraits],
      ["hairTraits", value.hairTraits],
      ["bodyTraits", value.bodyTraits],
    ] as const;
    for (const [path, traits] of requiredStructuredTraits) {
      if (
        !Array.isArray(traits?.stableTraits) ||
        !traits.stableTraits.some(
          (trait) => typeof trait === "string" && trait.trim().length > 0,
        )
      ) {
        context.addIssue({
          code: "custom",
          path: [path, "stableTraits"],
          message:
            "Activating an identity candidate requires structured face, hair, and body traits",
        });
      }
    }
    if (value.faceTraits?.canonicalPortraitAuthority !== true) {
      context.addIssue({
        code: "custom",
        path: ["faceTraits", "canonicalPortraitAuthority"],
        message:
          "Activating an identity candidate must designate the reviewed portrait as canonical",
      });
    }
  });

export const characterVisualIdentityVersionSchema = z
  .object({
    id: adminIdSchema,
    version: z.number().int().positive(),
    status: characterVisualIdentityStatusSchema,
    style: characterVisualStyleSchema,
    identityPrompt: z.string(),
    negativeIdentityPrompt: z.string().nullable(),
    traits: z.object({
      face: z.record(z.string(), z.unknown()),
      hair: z.record(z.string(), z.unknown()),
      body: z.record(z.string(), z.unknown()),
      signature: z.record(z.string(), z.unknown()),
      style: z.record(z.string(), z.unknown()),
    }).strict(),
    immutableHash: z.string().nullable(),
    evidenceState: z.string().trim().min(1),
    defaultSeed: z.string().nullable(),
    anchorAssetIds: z.array(adminIdSchema).readonly(),
    createdFrom: z.string().trim().min(1),
    createdAt: adminIsoDateTimeSchema,
  })
  .strict();

export const characterVisualAssetSchema = z
  .object({
    mediaAssetId: adminIdSchema,
    role: characterVisualReferenceRoleSchema,
    available: z.boolean(),
    url: z.string().nullable(),
    thumbnailUrl: z.string().nullable(),
    qualityScore: z.number().nullable(),
    identityScore: z.number().nullable(),
  })
  .strict();

export const characterVideoSourceAssetSchema = z
  .object({
    mediaAssetId: adminIdSchema,
    available: z.boolean(),
    url: z.string().nullable(),
    thumbnailUrl: z.string().nullable(),
  })
  .strict();

export const characterLookWorkspaceSchema = z
  .object({
    id: adminIdSchema,
    ownerId: adminIdSchema,
    label: z.string().trim().min(1),
    status: z.enum(["active", "needs_rebase"]),
    visualProfileId: adminIdSchema,
    referenceAssetId: adminIdSchema.nullable(),
    rebasedFromLookId: adminIdSchema.nullable(),
    updatedAt: adminIsoDateTimeSchema,
  })
  .strict();

export const characterLookArchiveRequestSchema = z
  .object({
    operation: z.literal("archive"),
    expectedUpdatedAt: adminIsoDateTimeSchema,
    reason: adminCommandReasonSchema,
    confirmation: z.string().trim().min(1).max(240),
  })
  .strict();

export const characterLookArchiveResponseSchema = z
  .object({
    id: adminIdSchema,
    characterId: adminIdSchema,
    status: z.literal("archived"),
    updatedAt: adminIsoDateTimeSchema,
  })
  .strict();

export const characterVisualReferenceSetSchema = z
  .object({
    id: adminIdSchema,
    revision: z.number().int().positive(),
    status: characterVisualReferenceSetStatusSchema,
    selectorVersion: z.string().trim().min(1),
    snapshotHash: z.string().nullable(),
    createdFrom: z.string().trim().min(1),
    createdAt: adminIsoDateTimeSchema,
    references: z.array(characterVisualAssetSchema).readonly(),
  })
  .strict();

export const characterReferenceSetPublishRequestSchema = z.object({
  visualProfileId: adminIdSchema,
  expectedActiveReferenceSetRevisionId: adminIdSchema.nullable(),
  expectedActiveReferenceSetRevision: z.number().int().nonnegative(),
  selectorVersion: z.string().trim().min(1).max(80),
  references: z.array(z.object({
    mediaAssetId: adminIdSchema,
    role: characterVisualReferenceRoleSchema,
    weight: z.number().positive().max(10).default(1),
  }).strict()).min(1).max(24),
  reason: adminCommandReasonSchema,
  confirmation: z.string().trim().min(1).max(240),
}).strict().superRefine((value, context) => {
  const expectsNoActiveRevision =
    value.expectedActiveReferenceSetRevisionId === null;
  const hasInitialRevision =
    value.expectedActiveReferenceSetRevision === 0;
  if (expectsNoActiveRevision !== hasInitialRevision) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expectedActiveReferenceSetRevision"],
      message:
        "Expected active Reference Set id and revision must describe the same authority state.",
    });
  }
});

export const characterReferenceSetPublishResponseSchema = characterVisualReferenceSetSchema.extend({
  replayed: z.boolean(),
}).strict();

export const characterRouteQualificationEvidenceSchema = z
  .object({
    id: adminIdSchema,
    routeFingerprint: z.string().trim().min(1),
    generationProfileKey: z.string().trim().min(1),
    generationProfileVersion: z.number().int().positive(),
    workflowKey: z.string().trim().min(1),
    workflowVersion: z.number().int().positive(),
    style: characterVisualStyleSchema,
    matrixKey: z.string().trim().min(1),
    sampleCount: z.number().int().nonnegative(),
    passCount: z.number().int().nonnegative(),
    identityMatch: z.number().min(0).max(1),
    result: generationRouteQualificationResultSchema,
    evidence: z.record(z.string(), z.unknown()),
    policyVersion: z.string().trim().min(1),
    evaluatedAt: adminIsoDateTimeSchema,
    expiresAt: adminIsoDateTimeSchema.nullable(),
    stale: z.boolean(),
    identityContract: z.object({
      maxReferences: z.number().int().nonnegative(),
      acceptedRoles: z.array(z.enum([
        "identity_anchor",
        "identity_reference",
        "look_reference",
        "source_image",
      ])).readonly(),
      supportsLookReference: z.boolean(),
      supportsSourceImageWithIdentity: z.boolean(),
    }).strict().optional(),
    profileCapabilities: z.object({
      referenceImages: z.boolean(),
      initImage: z.boolean(),
    }).strict().optional(),
    sourceVariationAuthority: z.object({
      routeFingerprint: z.string().trim().min(1),
      ready: z.boolean(),
      blocker: z.enum([
        "no_qualified_route",
        "profile_init_image_unsupported",
        "workflow_source_image_unsupported",
        "workflow_source_identity_combination_unsupported",
        "reference_capacity_insufficient",
        "reference_slot_assignment_unsupported",
      ]).nullable(),
    }).strict().optional(),
  })
  .strict()
  .superRefine((qualification, ctx) => {
    const authority = qualification.sourceVariationAuthority;
    if (!authority) return;
    if (authority.routeFingerprint !== qualification.routeFingerprint) {
      ctx.addIssue({
        code: "custom",
        path: ["sourceVariationAuthority", "routeFingerprint"],
        message: "Source variation authority must belong to this exact route fingerprint",
      });
    }
    if (authority.ready !== (authority.blocker === null)) {
      ctx.addIssue({
        code: "custom",
        path: ["sourceVariationAuthority", "ready"],
        message: "Source variation readiness must match its blocker",
      });
    }
  });

export const characterBootstrapGenerationProfileSchema = z
  .object({
    profileKey: adminIdSchema,
    profileVersion: z.number().int().positive(),
    label: z.string().trim().min(1),
    workflowKey: z.string().trim().min(1),
    workflowVersion: z.number().int().positive(),
    orientation: z.string().trim().min(1).max(20),
  })
  .strict();

export const characterRouteEvaluationProfileSchema = z
  .object({
    profileKey: adminIdSchema,
    profileVersion: z.number().int().positive(),
    label: z.string().trim().min(1),
    workflowKey: z.string().trim().min(1),
    workflowVersion: z.number().int().positive(),
    orientation: z.string().trim().min(1).max(20),
    recommended: z.boolean(),
  })
  .strict();

export const characterIdentityCalibrationProfileSchema = z
  .object({
    profileKey: adminIdSchema,
    profileVersion: z.number().int().positive(),
    label: z.string().trim().min(1),
    modelId: z.string().trim().min(1),
    workflowKey: z.string().trim().min(1),
    workflowVersion: z.number().int().positive(),
    orientation: z.string().trim().min(1).max(20),
    allowedOrientations: z.array(z.string().trim().min(1).max(20)).min(1).readonly(),
    modes: z.array(z.enum(["text_to_image", "image_to_image"])).min(1).readonly(),
    recommended: z.boolean(),
  })
  .strict();

export const characterIdentityCalibrationWorkspaceSchema = z
  .object({
    profiles: z.array(characterIdentityCalibrationProfileSchema).readonly(),
    blocker: z.string().trim().min(1).nullable(),
  })
  .strict()
  .superRefine((workspace, context) => {
    if ((workspace.profiles.length === 0) !== (workspace.blocker !== null)) {
      context.addIssue({
        code: "custom",
        path: ["blocker"],
        message: "Identity calibration blocker must match profile availability",
      });
    }
  });

export const characterRouteEvaluationWorkspaceSchema = z
  .object({
    ready: z.boolean(),
    blocker: z.string().trim().min(1).nullable(),
    sampleMinimum: z.number().int().positive(),
    evaluatorVersion: z.string().trim().min(1),
    profiles: z.array(characterRouteEvaluationProfileSchema).readonly(),
  })
  .strict()
  .superRefine((workspace, context) => {
    if (workspace.ready !== (workspace.blocker === null && workspace.profiles.length > 0)) {
      context.addIssue({
        code: "custom",
        path: ["ready"],
        message: "Route evaluation readiness must match its profiles and blocker",
      });
    }
  });

export const characterIdentityBootstrapWorkspaceSchema = z
  .object({
    state: z.enum(["new", "recoverable_empty_history", "blocked_existing_authority"]),
    allowed: z.boolean(),
    nextIdentityVersion: z.number().int().positive(),
    blockers: z.array(z.string().trim().min(1)).readonly(),
    profile: characterBootstrapGenerationProfileSchema.nullable(),
  })
  .strict();

export const characterImageReadinessSchema = z
  .object({
    state: z.enum([
      "ready",
      "bootstrap_required",
      "repairable",
      "route_pending",
      "manual_review_required",
    ]),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    steps: z
      .object({
        identity: z.enum(["complete", "action_required", "blocked"]),
        references: z.enum(["complete", "action_required", "blocked"]),
        route: z.enum(["complete", "platform_pending", "blocked"]),
      })
      .strict(),
    repair: z
      .object({
        kind: z.enum(["adopt_live_portrait", "publish_existing_anchor"]),
        sourceAssetId: adminIdSchema,
      })
      .strict()
      .nullable(),
    nextDeepLink: z.string().startsWith("/admin/"),
  })
  .strict();

export const characterVisualWorkspaceSchema = z
  .object({
    activeIdentity: characterVisualIdentityVersionSchema.nullable(),
    anchors: z.array(characterVisualAssetSchema).readonly(),
    references: z.array(characterVisualAssetSchema).readonly(),
    videoSources: z.array(characterVideoSourceAssetSchema).readonly(),
    // SPEC: 运营在提交前看到当前固定视频 profile 的价格与近期真实耗时。
    // INTENT: 估算是只读投影；缺少定价或样本时保留 null，不能猜一个看似精确的数字。
    videoGenerationEstimate: z
      .object({
        profileKey: adminIdSchema,
        estimatedCostDreamcoins: z.number().int().nonnegative().nullable(),
        averageDurationMs: z.number().nonnegative().nullable(),
        completedSampleCount: z.number().int().nonnegative(),
        windowDays: z.number().int().positive(),
      })
      .strict()
      .optional(),
    activeReferenceSet: characterVisualReferenceSetSchema.nullable(),
    looks: z.array(characterLookWorkspaceSchema).readonly().optional(),
    routeQualifications: z.array(characterRouteQualificationEvidenceSchema).readonly(),
    routeEvaluation: characterRouteEvaluationWorkspaceSchema,
    identityCalibration: characterIdentityCalibrationWorkspaceSchema.optional(),
    identityBootstrap: characterIdentityBootstrapWorkspaceSchema,
    imageReadiness: characterImageReadinessSchema.optional(),
    readiness: z.object({
      ready: z.boolean(),
      qualificationPolicyVersion: z.string().trim().min(1),
      blockers: z.array(z.object({
        code: z.string().trim().min(1),
        message: z.string().trim().min(1),
        deepLink: z.string().startsWith("/admin/"),
      }).strict()).readonly(),
      productionDeepLink: z.string().startsWith("/admin/"),
    }).strict(),
  })
  .strict();

export const characterWorkspaceProjectSchema = z
  .object({
    id: adminIdSchema,
    characterId: adminIdSchema,
    ownerId: adminIdSchema.nullable(),
    phase: characterProjectPhaseSchema,
    audience: z.string(),
    companionNeed: z.string(),
    hypothesis: z.string(),
    differentiation: z.string(),
    targetPlacementKeys: z.array(z.string()).readonly(),
    successCriteria: z.array(z.string()).readonly(),
    productionPackage: z.string(),
    qaPlan: z.string(),
    draftImageAssetId: adminIdSchema.nullable(),
    draftAssetPackHash: z.string().trim().min(1),
    draftAssetPack: z.object({
      character_cover: adminIdSchema.optional(),
      character_hero: adminIdSchema.optional(),
      character_chat: adminIdSchema.optional(),
    }).strict(),
    draftAssetSelections: z.object({
      character_cover: z.object({
        assetId: adminIdSchema,
        runId: adminIdSchema.nullable(),
        itemId: adminIdSchema.nullable(),
        reviewDecisionId: adminIdSchema.nullable(),
        generationJobId: adminIdSchema.nullable(),
        bootstrapIdentity: z.boolean(),
        generationRouteFingerprint: z.string().trim().min(1).nullable(),
        routeCurrent: z.boolean(),
      }).strict().optional(),
      character_hero: z.object({
        assetId: adminIdSchema,
        runId: adminIdSchema.nullable(),
        itemId: adminIdSchema.nullable(),
        reviewDecisionId: adminIdSchema.nullable(),
        generationJobId: adminIdSchema.nullable(),
        bootstrapIdentity: z.boolean(),
        generationRouteFingerprint: z.string().trim().min(1).nullable(),
        routeCurrent: z.boolean(),
      }).strict().optional(),
      character_chat: z.object({
        assetId: adminIdSchema,
        runId: adminIdSchema.nullable(),
        itemId: adminIdSchema.nullable(),
        reviewDecisionId: adminIdSchema.nullable(),
        generationJobId: adminIdSchema.nullable(),
        bootstrapIdentity: z.boolean(),
        generationRouteFingerprint: z.string().trim().min(1).nullable(),
        routeCurrent: z.boolean(),
      }).strict().optional(),
    }).strict().optional(),
    draftAssetRouteAuthority: z.object({
      status: z.enum(["empty", "current", "stale", "route_unavailable"]),
      currentRouteFingerprint: z.string().trim().min(1).nullable(),
      stalePurposes: z.array(z.enum([
        "character_cover",
        "character_hero",
        "character_chat",
      ])).readonly(),
      missingPurposes: z.array(z.enum([
        "character_cover",
        "character_hero",
        "character_chat",
      ])).readonly(),
      recoveryPurpose: z.enum([
        "character_cover",
        "character_hero",
        "character_chat",
      ]).nullable(),
      qaReady: z.boolean(),
      qaBlockers: z.array(z.enum([
        "draft_asset_pack_incomplete",
        "draft_asset_bootstrap_scope_invalid",
        "qualified_generation_route_missing",
        "draft_asset_generation_route_stale",
      ])).readonly(),
    }).strict(),
    plannedLaunchAt: adminIsoDateTimeSchema.nullable(),
    version: z.number().int().nonnegative(),
    updatedAt: adminIsoDateTimeSchema,
  })
  .strict();

export const characterIdentityBootstrapRequestSchema = z.object({
  entityVersion: z.number().int().positive(),
  runId: adminIdSchema,
  itemId: adminIdSchema,
  assetId: adminIdSchema,
  reviewDecisionId: adminIdSchema,
  reason: z.string().trim().max(2_000).default(""),
  confirmation: z.string().trim().min(1).max(240),
}).strict();

export const characterIdentityBootstrapResponseSchema = z.object({
  characterId: adminIdSchema,
  projectVersion: z.number().int().positive(),
  visualProfileId: adminIdSchema,
  visualProfileVersion: z.number().int().positive(),
  referenceSetRevisionId: adminIdSchema,
  referenceSetRevision: z.number().int().positive(),
  anchorAssetId: adminIdSchema,
  draftImageAssetId: adminIdSchema,
  deepLink: z.string().startsWith("/admin/characters/"),
  replayed: z.boolean(),
}).strict();

export const characterImageReadinessRepairRequestSchema = z
  .object({
    entityVersion: z.number().int().positive(),
    expectedReadinessFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    reason: z.string().trim().max(2_000).default(""),
    confirmation: z.string().trim().min(1).max(240),
  })
  .strict();

export const characterImageReadinessRepairResponseSchema = z
  .object({
    characterId: adminIdSchema,
    projectVersion: z.number().int().positive(),
    state: z.enum(["ready", "route_pending"]),
    action: z.enum([
      "adopted_live_portrait",
      "published_existing_anchor",
      "no_op",
    ]),
    visualProfileId: adminIdSchema,
    visualProfileVersion: z.number().int().positive(),
    referenceSetRevisionId: adminIdSchema,
    referenceSetRevision: z.number().int().positive(),
    routeQualificationId: adminIdSchema.nullable(),
    routeFingerprint: z.string().trim().min(1).nullable(),
    remainingBlockers: z.array(z.string().trim().min(1)).readonly(),
    deepLink: z.string().startsWith("/admin/characters/"),
    replayed: z.boolean(),
  })
  .strict();

const characterPreviewAssetSlotSchema = z.object({
  assetId: adminIdSchema.nullable(),
  imageUrl: z.string().nullable(),
  status: z.enum(["missing", "available", "unavailable"]),
}).strict().superRefine((value, ctx) => {
  const consistent = value.status === "available"
    ? value.assetId !== null && value.imageUrl !== null
    : value.status === "missing"
      ? value.assetId === null && value.imageUrl === null
      : value.assetId !== null && value.imageUrl === null;
  if (!consistent) {
    ctx.addIssue({
      code: "custom",
      message: `Preview asset slot fields do not match ${value.status} status`,
    });
  }
});

export const characterPreviewSnapshotSchema = z
  .object({
    releaseId: adminIdSchema.nullable(),
    contentVersionId: adminIdSchema.nullable(),
    label: z.enum(["Live", "Draft Preview"]),
    name: z.string(),
    description: z.string(),
    persona: z.record(z.string(), z.unknown()),
    opening: z.record(z.string(), z.unknown()),
    appearance: z.record(z.string(), z.unknown()),
    imageUrl: z.string().nullable(),
    assetPack: z.object({
      character_cover: characterPreviewAssetSlotSchema,
      character_hero: characterPreviewAssetSlotSchema,
      character_chat: characterPreviewAssetSlotSchema,
    }).strict(),
    assetPackReady: z.boolean(),
    renderUrl: z.string().url().nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const slots = [
      value.assetPack.character_cover,
      value.assetPack.character_hero,
      value.assetPack.character_chat,
    ];
    const availableAssetIds = slots.flatMap((slot) =>
      slot.status === "available" && slot.assetId ? [slot.assetId] : []
    );
    const exactlyReady =
      availableAssetIds.length === 3 &&
      new Set(availableAssetIds).size === 3;
    if (value.assetPackReady !== exactlyReady) {
      ctx.addIssue({
        code: "custom",
        path: ["assetPackReady"],
        message: "assetPackReady must represent three distinct available assets",
      });
    }
    if (value.imageUrl !== value.assetPack.character_cover.imageUrl) {
      ctx.addIssue({
        code: "custom",
        path: ["imageUrl"],
        message: "imageUrl compatibility field must match character_cover",
      });
    }
    if (value.renderUrl !== null && !exactlyReady) {
      ctx.addIssue({
        code: "custom",
        path: ["renderUrl"],
        message: "Renderer URL requires an exact available three-slot pack",
      });
    }
  });

export const characterWorkspaceDetailSchema = z
  .object({
    character: z
      .object({
        id: adminIdSchema,
        name: z.string().trim().min(1),
        age: z.number().int().min(18),
        description: z.string(),
        gender: z.string(),
        style: z.string(),
        visibility: z.string(),
        legacyStatus: z.string(),
        imageUrl: z.string().nullable(),
        updatedAt: adminIsoDateTimeSchema,
      })
      .strict(),
    project: characterWorkspaceProjectSchema,
    soul: z.object({
      valid: z.boolean(),
      current: z.object({
        contentVersionId: adminIdSchema,
        version: z.number().int().positive(),
        schemaVersion: z.number().int().nonnegative().nullable(),
        compilerVersion: z.string().nullable(),
        fingerprint: z.string().nullable(),
        estimatedTokens: z.number().int().nonnegative().nullable(),
        soul: z.record(z.string(), z.unknown()).nullable(),
        markdown: z.string().nullable(),
        systemPrompt: z.string().nullable(),
        diagnostics: z.array(z.object({
          code: z.string(),
          path: z.array(z.string()),
          severity: z.enum(["error", "warning"]),
          message: z.string(),
        }).strict()).readonly(),
      }).strict(),
      previous: z.object({
        contentVersionId: adminIdSchema,
        version: z.number().int().positive(),
        fingerprint: z.string().nullable(),
      }).strict().nullable(),
      changedFields: z.array(z.string()).readonly(),
    }).strict(),
    journey: characterProductionJourneySchema,
    mediaOperations: characterMediaOperationsProjectionSchema,
    visual: characterVisualWorkspaceSchema,
    voice: characterVoiceWorkspaceSchema,
    serving: characterServingSchema.nullable(),
    activeCommand: adminCommandStatusSchema.nullable(),
    releases: z.array(characterWorkspaceReleaseSchema).readonly(),
    qaRuns: z.array(characterQaRunSchema).readonly(),
    preview: z
      .object({
        live: characterPreviewSnapshotSchema.nullable(),
        draft: characterPreviewSnapshotSchema,
        changedFields: z.array(z.string()).readonly(),
      })
      .strict(),
    performance: z.array(characterPerformanceSummarySchema).readonly(),
    portfolio: z.object({
      latestDecision: characterPortfolioDecisionRecordSchema.nullable(),
      changeMarkers: z.array(characterReleaseChangeMarkerSchema).readonly(),
    }).strict(),
  })
  .strict();

export type CharacterWorkspaceDetail = z.infer<typeof characterWorkspaceDetailSchema>;

export type CharacterReferenceSetPublishRequest = z.infer<typeof characterReferenceSetPublishRequestSchema>;

export type CharacterLookArchiveRequest = z.infer<typeof characterLookArchiveRequestSchema>;

export type CharacterVisualProfileCreateRequest = z.infer<
  typeof characterVisualProfileCreateRequestSchema
>;

export type CharacterIdentityBootstrapRequest = z.infer<typeof characterIdentityBootstrapRequestSchema>;

export type CharacterIdentityBootstrapResponse = z.infer<typeof characterIdentityBootstrapResponseSchema>;

export type CharacterImageReadinessRepairRequest = z.infer<typeof characterImageReadinessRepairRequestSchema>;

export type CharacterImageReadinessRepairResponse = z.infer<typeof characterImageReadinessRepairResponseSchema>;
