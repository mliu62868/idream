import { z } from "zod";
import {
  adminCursorQuerySchema,
  adminCommandRequestSchema,
  adminCommandReasonSchema,
  adminIdSchema,
  adminIsoDateTimeSchema,
  adminListResponseSchema,
  adminPrioritySchema,
  adminReadinessSchema,
  adminVerificationStateSchema,
  operationalStateViewSchema,
} from "./common";

export const characterReleasePublishCommandRequestSchema = adminCommandRequestSchema;
export const characterReleaseScheduleCommandRequestSchema = adminCommandRequestSchema.extend({
  scheduledAt: adminIsoDateTimeSchema,
});
// The URL identifies the immutable historical Release; entityVersion is the
// CharacterServing version because rollback swaps that authority pointer.
export const characterReleaseRollbackCommandRequestSchema = adminCommandRequestSchema;
export const characterSessionReleaseMigrationCommandRequestSchema = adminCommandRequestSchema.extend({
  characterId: adminIdSchema,
  fromCharacterContentVersionId: adminIdSchema.nullable(),
  fromCharacterReleaseId: adminIdSchema.nullable(),
  toCharacterContentVersionId: adminIdSchema,
  toCharacterReleaseId: adminIdSchema,
  compatibilityQa: z
    .object({
      status: z.literal("passed"),
      policyVersion: z.string().trim().min(1),
      evidence: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
});

export const characterProjectPhaseSchema = z.enum([
  "idea",
  "planned",
  "producing",
  "qa",
  "launch_ready",
  "live_management",
  "retired",
]);
export const characterReleaseStatusSchema = z.enum([
  "draft",
  "validating",
  "in_review",
  "approved",
  "published",
  "superseded",
  "withdrawn",
]);
export const characterServingStateSchema = z.enum(["inactive", "live", "paused", "retired"]);
export const characterPortfolioDecisionSchema = z.enum([
  "Promote",
  "Maintain",
  "Improve",
  "Pause",
  "Retire",
]);
export const characterPerformanceWindowSchema = z.enum(["7d", "28d"]);
export const characterPerformanceMaturitySchema = z.enum([
  "mature",
  "immature",
  "insufficient_data",
]);
export const characterPerformanceQualitySchema = z.enum([
  "certified",
  "directional",
  "invalid",
]);

export const generationRouteQualificationEvaluateRequestSchema = z
  .object({
    batchIds: z.array(adminIdSchema).min(1).max(20),
    matrixKey: z.string().trim().min(1).max(160),
    style: z.enum(["realistic", "anime", "hybrid", "other"]),
    policyVersion: z.string().trim().min(1).max(160),
    costLatencyGuardrail: z
      .object({
        status: z.enum(["passed", "failed"]),
        evidenceRef: z.string().trim().min(1).max(500),
      })
      .strict(),
    expiresAt: adminIsoDateTimeSchema.nullable(),
    reason: adminCommandReasonSchema,
    confirmation: z.string().trim().min(1).max(240),
  })
  .strict();

export const generationRouteQualificationEvaluateResponseSchema = z
  .object({
    qualificationId: adminIdSchema,
    routeFingerprint: z.string().trim().min(1),
    result: z.enum(["candidate", "qualified"]),
    sampleCount: z.number().int().nonnegative(),
    passCount: z.number().int().nonnegative(),
    identityMatch: z.number().min(0).max(1),
    evaluatorVersion: z.string().trim().min(1),
    evidenceHash: z.string().trim().min(1),
    replayed: z.boolean(),
  })
  .strict();

export const characterDraftPersonaSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    age: z.number().int().min(18).max(120),
    gender: z.enum(["female", "male", "trans"]),
    relationshipArchetype: z.string().trim().min(1).max(500),
    characterPromise: z.string().trim().min(1).max(1_000),
    personality: z.string().trim().min(1).max(4_000),
    tone: z.string().trim().min(1).max(2_000),
    backstory: z.string().trim().min(1).max(8_000),
    firstMessage: z.string().trim().min(1).max(4_000),
    exampleDialogue: z.array(z.string().trim().min(1).max(2_000)).min(1).max(24),
  })
  .strict();

export const characterDraftVisualDirectionSchema = z
  .object({
    identityAnchor: z.string().trim().min(1).max(2_000),
    stableTraits: z.array(z.string().trim().min(1).max(500)).min(1).max(24),
    style: z.enum(["realistic", "anime", "hybrid", "other"]),
    referenceDirection: z.string().trim().min(1).max(4_000),
  })
  .strict();

export const characterProjectCreateRequestSchema = z
  .object({
    positioning: z
      .object({
        audience: z.string().trim().min(1).max(2_000),
        companionNeed: z.string().trim().min(1).max(2_000),
        hypothesis: z.string().trim().min(1).max(4_000),
        differentiation: z.string().trim().min(1).max(4_000),
      })
      .strict(),
    persona: characterDraftPersonaSchema,
    visualDirection: characterDraftVisualDirectionSchema,
    commercialIntent: z
      .object({
        ownerId: adminIdSchema.nullable(),
        plannedLaunchAt: adminIsoDateTimeSchema.nullable(),
        targetPlacementKeys: z.array(z.string().trim().min(1).max(120)).max(24),
        successCriteria: z.array(z.string().trim().min(1).max(500)).min(1).max(24),
        productionPackage: z.string().trim().min(1).max(4_000),
        qaPlan: z.string().trim().min(1).max(4_000),
      })
      .strict(),
    reason: adminCommandReasonSchema,
    confirmation: z.literal("CREATE CHARACTER"),
  })
  .strict();

export const characterProjectCreateResponseSchema = z
  .object({
    characterId: adminIdSchema,
    characterContentVersionId: adminIdSchema,
    projectId: adminIdSchema,
    revisionId: adminIdSchema,
    projectVersion: z.number().int().positive(),
    contentVersion: z.number().int().positive(),
    deepLink: z.string().startsWith("/admin/characters/"),
    replayed: z.boolean(),
  })
  .strict();

export const characterProjectDraftSchema = characterProjectCreateRequestSchema.pick({
  positioning: true,
  persona: true,
  visualDirection: true,
  commercialIntent: true,
});

export const characterProjectDraftAuthoritySchema = z
  .object({
    characterId: adminIdSchema,
    projectId: adminIdSchema,
    projectVersion: z.number().int().positive(),
    deepLink: z.string().startsWith("/admin/characters/"),
  })
  .strict();

export const characterProjectDraftResumeSchema = z
  .object({
    authority: characterProjectDraftAuthoritySchema,
    draft: characterProjectDraftSchema,
  })
  .strict();

export const characterProjectSchema = z
  .object({
    id: adminIdSchema,
    characterId: adminIdSchema,
    ownerId: adminIdSchema.nullable(),
    phase: characterProjectPhaseSchema,
    audience: z.string().trim().min(1),
    companionNeed: z.string().trim().min(1),
    hypothesis: z.string().trim().min(1),
    differentiation: z.string().trim().min(1),
    targetPlacementKeys: z.array(z.string().trim().min(1)).readonly(),
    successCriteria: z.array(z.string().trim().min(1)).min(1).readonly(),
    plannedLaunchAt: adminIsoDateTimeSchema.nullable(),
    version: z.number().int().nonnegative(),
    createdAt: adminIsoDateTimeSchema,
    updatedAt: adminIsoDateTimeSchema,
  })
  .strict();

export const characterContentVersionRefSchema = z
  .object({
    id: adminIdSchema,
    version: z.number().int().positive(),
    contentHash: z.string().trim().min(1),
  })
  .strict();

export const characterVisualIdentityRefSchema = z
  .object({
    visualProfileId: adminIdSchema,
    visualProfileVersion: z.number().int().positive(),
    anchorAssetId: adminIdSchema,
    referenceSetRevisionId: adminIdSchema,
  })
  .strict();

export const generationRouteRefSchema = z
  .object({
    generationProfileKey: z.string().trim().min(1),
    generationProfileVersion: z.string().trim().min(1),
    workflowKey: z.string().trim().min(1),
    workflowVersion: z.string().trim().min(1),
  })
  .strict();

export const releaseOwnedPlacementSchema = z
  .object({
    slotKey: z.string().trim().min(1),
    slotVersion: z.number().int().positive(),
    assetId: adminIdSchema,
  })
  .strict();

export const characterReleaseSchema = z
  .object({
    id: adminIdSchema,
    projectId: adminIdSchema,
    revisionId: adminIdSchema,
    characterContentVersionId: adminIdSchema,
    visualIdentity: characterVisualIdentityRefSchema,
    generationRoute: generationRouteRefSchema,
    releaseOwnedPlacements: z.array(releaseOwnedPlacementSchema).readonly(),
    snapshotHash: z.string().trim().min(1),
    policyVersion: z.string().trim().min(1),
    legacy: z.boolean(),
    status: characterReleaseStatusSchema,
    publishedAt: adminIsoDateTimeSchema.nullable(),
    supersedesId: adminIdSchema.nullable(),
    rollbackOfReleaseId: adminIdSchema.nullable(),
    version: z.number().int().nonnegative(),
    createdAt: adminIsoDateTimeSchema,
    updatedAt: adminIsoDateTimeSchema,
  })
  .strict()
  .superRefine((release, ctx) => {
    if (release.status === "published" && !release.legacy && release.publishedAt === null) {
      ctx.addIssue({ code: "custom", path: ["publishedAt"], message: "Published releases need publishedAt" });
    }
  });

export const characterServingSchema = z
  .object({
    characterId: adminIdSchema,
    state: characterServingStateSchema,
    currentReleaseId: adminIdSchema.nullable(),
    scheduledReleaseId: adminIdSchema.nullable(),
    scheduledAt: adminIsoDateTimeSchema.nullable(),
    version: z.number().int().nonnegative(),
    updatedAt: adminIsoDateTimeSchema,
  })
  .strict()
  .superRefine((serving, ctx) => {
    if (serving.currentReleaseId !== null && serving.currentReleaseId === serving.scheduledReleaseId) {
      ctx.addIssue({
        code: "custom",
        path: ["scheduledReleaseId"],
        message: "Current and scheduled releases must differ",
      });
    }
    if ((serving.scheduledReleaseId === null) !== (serving.scheduledAt === null)) {
      ctx.addIssue({
        code: "custom",
        path: ["scheduledAt"],
        message: "Scheduled release and time must be set together",
      });
    }
  });

export const characterContributionMarginSchema = z
  .object({
    valueMicros: z.number().int().nullable(),
    currency: z.string().trim().length(3).nullable(),
    attributedRevenueMicros: z.number().int().nonnegative().nullable(),
    refundMicros: z.number().int().nonnegative().nullable(),
    creditMicros: z.number().int().nonnegative().nullable(),
    variableCostMicros: z.number().int().nonnegative().nullable(),
    qualityState: characterPerformanceQualitySchema,
    evidence: z.array(z.string().trim().min(1)).min(1).readonly(),
  })
  .strict()
  .superRefine((margin, ctx) => {
    if (margin.qualityState === "invalid" && margin.valueMicros !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["valueMicros"],
        message: "Invalid contribution margin must fail closed with valueMicros=null",
      });
    }
    if (margin.valueMicros !== null && margin.currency === null) {
      ctx.addIssue({
        code: "custom",
        path: ["currency"],
        message: "A contribution margin value requires an audited currency",
      });
    }
  });

const nullableRateSchema = z.number().min(0).max(1).nullable();

export const characterPerformanceSummarySchema = z
  .object({
    characterContentVersionId: adminIdSchema,
    characterReleaseId: adminIdSchema,
    placementId: adminIdSchema.nullable(),
    window: characterPerformanceWindowSchema,
    windowStart: adminIsoDateTimeSchema,
    windowEnd: adminIsoDateTimeSchema,
    eligibleImpressions: z.number().int().nonnegative(),
    detailViews: z.number().int().nonnegative(),
    firstSuccessfulExchanges: z.number().int().nonnegative(),
    qceCount: z.number().int().nonnegative(),
    relationshipActivations: z.number().int().nonnegative(),
    sameCharacterD7EligiblePairs: z.number().int().nonnegative(),
    sameCharacterD7Returns: z.number().int().nonnegative(),
    paidAttributions: z.number().int().nonnegative(),
    detailCtr: nullableRateSchema,
    chatStartRate: nullableRateSchema,
    qceRate: nullableRateSchema,
    sameCharacterD7: nullableRateSchema,
    sampleSize: z.number().int().nonnegative(),
    maturity: characterPerformanceMaturitySchema,
    qualityState: characterPerformanceQualitySchema,
    coverageState: z.enum(["exact", "partial", "unavailable", "invalid"]),
    latestDataAt: adminIsoDateTimeSchema.nullable(),
    evidence: z.array(z.string().trim().min(1)).min(1).readonly(),
    contributionMargin: characterContributionMarginSchema,
  })
  .strict()
  .superRefine((summary, ctx) => {
    const cohortPairs: ReadonlyArray<readonly [number, number, string]> = [
      [summary.detailViews, summary.eligibleImpressions, "detailViews"],
      [summary.firstSuccessfulExchanges, summary.detailViews, "firstSuccessfulExchanges"],
      [summary.qceCount, summary.firstSuccessfulExchanges, "qceCount"],
      [summary.sameCharacterD7Returns, summary.sameCharacterD7EligiblePairs, "sameCharacterD7Returns"],
    ];
    for (const [numerator, denominator, field] of cohortPairs) {
      if (numerator > denominator) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: "Numerator must belong to the denominator cohort",
        });
      }
    }
    if (summary.qualityState === "invalid") {
      for (const field of ["detailCtr", "chatStartRate", "qceRate", "sameCharacterD7"] as const) {
        if (summary[field] !== null) {
          ctx.addIssue({
            code: "custom",
            path: [field],
            message: "Invalid performance must fail closed with rate=null",
          });
        }
      }
    }
  });

export const characterReleaseChangeMarkerSchema = z
  .object({
    currentReleaseId: adminIdSchema,
    previousReleaseId: adminIdSchema.nullable(),
    changedAt: adminIsoDateTimeSchema,
    window: characterPerformanceWindowSchema,
    comparable: z.boolean(),
    qceRateDelta: z.number().min(-1).max(1).nullable(),
    sameCharacterD7Delta: z.number().min(-1).max(1).nullable(),
    contributionMarginDeltaMicros: z.number().int().nullable(),
    evidence: z.array(z.string().trim().min(1)).min(1).readonly(),
  })
  .strict()
  .superRefine((marker, ctx) => {
    if (!marker.comparable && [marker.qceRateDelta, marker.sameCharacterD7Delta, marker.contributionMarginDeltaMicros]
      .some((value) => value !== null)) {
      ctx.addIssue({
        code: "custom",
        path: ["comparable"],
        message: "Non-comparable release changes cannot expose numeric deltas",
      });
    }
  });

export const characterPortfolioDecisionRecordSchema = z
  .object({
    id: adminIdSchema,
    characterId: adminIdSchema,
    releaseId: adminIdSchema,
    decision: characterPortfolioDecisionSchema,
    question: z.string().trim().min(1),
    evidenceRefs: z.array(z.string().trim().min(1)).min(1).readonly(),
    evidenceLevel: z.enum(["observational", "attribution", "causal"]),
    confidence: z.number().min(0).max(1).nullable(),
    ownerId: adminIdSchema,
    successCriteria: z.array(z.string().trim().min(1)).min(1).readonly(),
    guardrails: z.array(z.string().trim().min(1)).readonly(),
    reviewAt: adminIsoDateTimeSchema.nullable(),
    outcome: z.record(z.string(), z.unknown()).nullable(),
    createdAt: adminIsoDateTimeSchema,
  })
  .strict();

export const characterPortfolioDecisionRequestSchema = z
  .object({
    releaseId: adminIdSchema,
    decision: characterPortfolioDecisionSchema,
    question: z.string().trim().min(3).max(1_000),
    evidenceRefs: z.array(z.string().trim().min(1)).min(1).max(100),
    evidenceLevel: z.enum(["observational", "attribution", "causal"]),
    confidence: z.number().min(0).max(1).nullable().default(null),
    successCriteria: z.array(z.string().trim().min(1)).min(1).max(50),
    guardrails: z.array(z.string().trim().min(1)).max(50).default([]),
    reviewAt: adminIsoDateTimeSchema.nullable().default(null),
  })
  .strict();

export const characterPortfolioItemSchema = z
  .object({
    characterId: adminIdSchema,
    name: z.string().trim().min(1),
    project: characterProjectSchema,
    serving: characterServingSchema,
    currentRelease: characterReleaseSchema.nullable(),
    candidateRelease: characterReleaseSchema.nullable(),
    readiness: adminReadinessSchema,
    verificationState: adminVerificationStateSchema.optional(),
    priority: adminPrioritySchema,
    performance: z.array(characterPerformanceSummarySchema).readonly(),
    changeMarkers: z.array(characterReleaseChangeMarkerSchema).readonly(),
    latestDecision: characterPortfolioDecisionRecordSchema.nullable(),
    operationalState: operationalStateViewSchema,
  })
  .strict();

export const characterPortfolioQuerySchema = adminCursorQuerySchema.extend({
  phase: characterProjectPhaseSchema.optional(),
  servingState: characterServingStateSchema.optional(),
  readiness: adminReadinessSchema.optional(),
  ownerId: adminIdSchema.optional(),
  decision: characterPortfolioDecisionSchema.optional(),
  placementId: adminIdSchema.optional(),
  sort: z.enum(["project_id_asc"]).default("project_id_asc"),
});

export const characterPortfolioResponseSchema = adminListResponseSchema(characterPortfolioItemSchema);

export const characterPerformanceBackfillRequestSchema = z
  .object({
    source: z.string().trim().min(1).max(120),
    kind: z.enum(["funnel", "variable_cost"]),
    dryRun: z.boolean().default(true),
    batchSize: z.number().int().min(1).max(1_000).default(200),
    cursor: z.string().trim().min(1).nullable().default(null),
  })
  .strict();

export const characterPerformanceBackfillResponseSchema = z.object({
  runId: adminIdSchema,
  status: z.enum(["paused", "completed"]),
  dryRun: z.boolean(),
  scannedCount: z.number().int().nonnegative(),
  wouldApplyCount: z.number().int().nonnegative(),
  appliedCount: z.number().int().nonnegative(),
  skippedCount: z.number().int().nonnegative(),
  mismatchCount: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
  before: z.record(z.string(), z.number().int().nonnegative()),
  after: z.record(z.string(), z.number().int().nonnegative()),
  mismatches: z.array(z.record(z.string(), z.unknown())).readonly(),
}).strict();

export const characterPerformanceReconciliationSchema = z.object({
  scannedFunnelRows: z.number().int().nonnegative(),
  impossibleFunnelRows: z.number().int().nonnegative(),
  missingReleaseRows: z.number().int().nonnegative(),
  nonExactFunnelRows: z.number().int().nonnegative(),
  relevantCostAuthorities: z.number().int().nonnegative(),
  projectedCostAuthorities: z.number().int().nonnegative(),
  missingVariableCostFacts: z.number().int().nonnegative(),
  unauditedEconomicsFacts: z.number().int().nonnegative(),
  partialEconomicsFacts: z.number().int().nonnegative(),
  cashRevenueAuthorityState: z.literal("unavailable"),
  refundAuthorityState: z.literal("unavailable"),
  creditAuthorityState: z.literal("unavailable"),
  qualityState: z.enum(["directional", "invalid"]),
}).strict();

export const characterProjectDraftPatchRequestSchema = z
  .object({
    entityVersion: z.number().int().nonnegative(),
    ownerId: adminIdSchema.nullable(),
    audience: z.string().trim().min(1).max(2_000),
    companionNeed: z.string().trim().min(1).max(2_000),
    hypothesis: z.string().trim().min(1).max(4_000),
    differentiation: z.string().trim().min(1).max(4_000),
    targetPlacementKeys: z.array(z.string().trim().min(1).max(120)).max(24),
    successCriteria: z.array(z.string().trim().min(1).max(500)).min(1).max(24),
    productionPackage: z.string().trim().max(4_000).default(""),
    qaPlan: z.string().trim().max(4_000).default(""),
    plannedLaunchAt: adminIsoDateTimeSchema.nullable(),
    content: z
      .object({
        persona: characterDraftPersonaSchema,
        visualDirection: characterDraftVisualDirectionSchema,
      })
      .strict()
      .optional(),
    reason: z.string().trim().min(3).max(2_000),
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
    plannedLaunchAt: adminIsoDateTimeSchema.nullable(),
    version: z.number().int().nonnegative(),
    updatedAt: adminIsoDateTimeSchema,
  })
  .strict();

export const characterReleaseCheckSchema = z
  .object({
    checkKey: z.string().trim().min(1),
    result: z.enum(["passed", "failed", "blocked", "stale"]),
    evidence: z.record(z.string(), z.unknown()),
    checkedAt: adminIsoDateTimeSchema,
  })
  .strict();

export const characterReleaseMonitorSchema = z
  .object({
    id: adminIdSchema,
    window: z.string().trim().min(1),
    status: z.string().trim().min(1),
    baseline: z.record(z.string(), z.unknown()),
    observed: z.record(z.string(), z.unknown()),
    verification: z.record(z.string(), z.unknown()),
    startedAt: adminIsoDateTimeSchema,
    finishedAt: adminIsoDateTimeSchema.nullable(),
  })
  .strict();

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
  })
  .strict();

export const characterWorkspaceReleaseSchema = z
  .object({
    release: z
      .object({
        id: adminIdSchema,
        projectId: adminIdSchema,
        revisionId: adminIdSchema,
        characterContentVersionId: adminIdSchema,
        visualProfileId: adminIdSchema.nullable(),
        visualProfileVersion: z.number().int().positive().nullable(),
        referenceSetRevisionId: adminIdSchema.nullable(),
        generationProvenance: z.record(z.string(), z.unknown()),
        releasePlacementManifest: z.record(z.string(), z.unknown()),
        snapshotHash: z.string().trim().min(1),
        readiness: z.string().trim().min(1),
        legacy: z.boolean(),
        status: characterReleaseStatusSchema,
        publishedAt: adminIsoDateTimeSchema.nullable(),
        supersedesId: adminIdSchema.nullable(),
        rollbackOfReleaseId: adminIdSchema.nullable(),
        version: z.number().int().nonnegative(),
        createdAt: adminIsoDateTimeSchema,
        updatedAt: adminIsoDateTimeSchema,
      })
      .strict(),
    checks: z.array(characterReleaseCheckSchema).readonly(),
    monitors: z.array(characterReleaseMonitorSchema).readonly(),
  })
  .strict();

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
    serving: characterServingSchema.nullable(),
    releases: z.array(characterWorkspaceReleaseSchema).readonly(),
    preview: z
      .object({
        live: characterPreviewSnapshotSchema.nullable(),
        draft: characterPreviewSnapshotSchema,
        changedFields: z.array(z.string()).readonly(),
      })
      .strict(),
    performance: z.array(characterPerformanceSummarySchema).readonly(),
  })
  .strict();

export const characterReleaseMonitorRefreshRequestSchema = z
  .object({
    entityVersion: z.number().int().nonnegative(),
  })
  .strict();

export type CharacterProject = z.infer<typeof characterProjectSchema>;
export type CharacterDraftPersona = z.infer<typeof characterDraftPersonaSchema>;
export type CharacterDraftVisualDirection = z.infer<typeof characterDraftVisualDirectionSchema>;
export type CharacterProjectCreateRequest = z.infer<typeof characterProjectCreateRequestSchema>;
export type CharacterProjectCreateResponse = z.infer<typeof characterProjectCreateResponseSchema>;
export type CharacterProjectDraft = z.infer<typeof characterProjectDraftSchema>;
export type CharacterProjectDraftAuthority = z.infer<typeof characterProjectDraftAuthoritySchema>;
export type CharacterProjectDraftResume = z.infer<typeof characterProjectDraftResumeSchema>;
export type CharacterRelease = z.infer<typeof characterReleaseSchema>;
export type CharacterServing = z.infer<typeof characterServingSchema>;
export type CharacterPortfolioItem = z.infer<typeof characterPortfolioItemSchema>;
export type CharacterPortfolioQuery = z.infer<typeof characterPortfolioQuerySchema>;
export type CharacterPerformanceSummary = z.infer<typeof characterPerformanceSummarySchema>;
export type CharacterPerformanceWindow = z.infer<typeof characterPerformanceWindowSchema>;
export type CharacterContributionMargin = z.infer<typeof characterContributionMarginSchema>;
export type CharacterPortfolioDecision = z.infer<typeof characterPortfolioDecisionSchema>;
export type CharacterPortfolioDecisionRequest = z.infer<typeof characterPortfolioDecisionRequestSchema>;
export type CharacterPortfolioDecisionRecord = z.infer<typeof characterPortfolioDecisionRecordSchema>;
export type CharacterPerformanceBackfillRequest = z.infer<typeof characterPerformanceBackfillRequestSchema>;
export type CharacterPerformanceReconciliation = z.infer<typeof characterPerformanceReconciliationSchema>;
export type CharacterProjectDraftPatchRequest = z.infer<typeof characterProjectDraftPatchRequestSchema>;
export type CharacterWorkspaceDetail = z.infer<typeof characterWorkspaceDetailSchema>;
export type CharacterReleasePublishCommandRequest = z.infer<
  typeof characterReleasePublishCommandRequestSchema
>;
export type CharacterReleaseScheduleCommandRequest = z.infer<
  typeof characterReleaseScheduleCommandRequestSchema
>;
export type CharacterReleaseRollbackCommandRequest = z.infer<
  typeof characterReleaseRollbackCommandRequestSchema
>;
export type CharacterSessionReleaseMigrationCommandRequest = z.infer<
  typeof characterSessionReleaseMigrationCommandRequestSchema
>;
