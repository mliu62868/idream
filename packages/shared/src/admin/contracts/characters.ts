import { z } from "zod";
import {
  adminCursorQuerySchema,
  adminCommandStatusSchema,
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
export const characterVisualStyleSchema = z.enum(["realistic", "anime", "hybrid", "other"]);
export const characterVisualIdentityStatusSchema = z.enum(["draft", "active", "archived", "superseded", "retired"]);
export const characterVisualReferenceSetStatusSchema = z.enum(["draft", "active", "superseded"]);
export const characterVisualReferenceRoleSchema = z.enum(["primary_face", "identity_anchor", "identity_reference"]);
export const generationRouteQualificationResultSchema = z.enum(["candidate", "qualified", "paused", "expired"]);

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
    activeReferenceSet: characterVisualReferenceSetSchema.nullable(),
    looks: z.array(characterLookWorkspaceSchema).readonly().optional(),
    routeQualifications: z.array(characterRouteQualificationEvidenceSchema).readonly(),
    routeEvaluation: characterRouteEvaluationWorkspaceSchema,
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

const characterProjectDraftObjectSchema = z
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
  })
  .strict();

export const characterProjectDraftSchema = characterProjectDraftObjectSchema;

export const characterCreateInstructionalSentinels = [
  [["positioning", "audience"], "Define the adult audience for this companion"],
  [["positioning", "companionNeed"], "Define the recurring companionship need"],
  [["positioning", "hypothesis"], "State the behavior and outcome hypothesis"],
  [["positioning", "differentiation"], "Explain why users will choose this character"],
  [["persona", "name"], "Untitled companion"],
  [["persona", "relationshipArchetype"], "trusted companion"],
  [["persona", "characterPromise"], "A specific, dependable companionship promise"],
  [["persona", "personality"], "Warm, observant, and consistent"],
  [["persona", "tone"], "Natural, concise, and emotionally present"],
  [["persona", "backstory"], "Draft the experiences that shape this character's point of view."],
  [["persona", "firstMessage"], "I'm here. Where should we begin?"],
  [["visualDirection", "identityAnchor"], "A recognizable adult companion identity"],
  [["visualDirection", "referenceDirection"], "Describe lighting, framing, wardrobe, and reference direction."],
  [["commercialIntent", "productionPackage"], "Define the required identity, placement, and chat asset package."],
  [["commercialIntent", "qaPlan"], "Define mobile, desktop, and conversation QA evidence."],
] as const;

function valueAtPath(
  value: Record<string, unknown>,
  path: readonly string[],
) {
  let current: unknown = value;
  for (const segment of path) {
    if (
      current === null ||
      typeof current !== "object" ||
      Array.isArray(current)
    ) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

const rejectCharacterCreateInstructionalSentinels: Parameters<
  typeof characterProjectDraftObjectSchema.superRefine
>[0] = (value, ctx) => {
  for (const [path, sentinel] of characterCreateInstructionalSentinels) {
    if (
      valueAtPath(value as unknown as Record<string, unknown>, path) ===
      sentinel
    ) {
      ctx.addIssue({
        code: "custom",
        path: [...path],
        message:
          "Replace the former instructional default with real Character data",
      });
    }
  }
  const listSentinels = [
    ["persona", "exampleDialogue", "Tell me what matters most about that."],
    ["visualDirection", "stableTraits", "consistent face"],
    ["visualDirection", "stableTraits", "recognizable silhouette"],
    ["commercialIntent", "successCriteria", "Define one measurable success criterion"],
  ] as const;
  for (const [section, field, sentinel] of listSentinels) {
    const values = valueAtPath(
      value as unknown as Record<string, unknown>,
      [section, field],
    );
    if (
      Array.isArray(values) &&
      values.some((item) => item === sentinel)
    ) {
      ctx.addIssue({
        code: "custom",
        path: [section, field],
        message:
          "Replace the former instructional default with real Character data",
      });
    }
  }
};

export const characterProjectProductionReadyDraftSchema =
  characterProjectDraftObjectSchema.superRefine(
    rejectCharacterCreateInstructionalSentinels,
  );

export const characterProjectCreateRequestSchema =
  characterProjectDraftObjectSchema
    .extend({
      reason: adminCommandReasonSchema,
      confirmation: z.literal("CREATE CHARACTER"),
    })
    .strict()
    .superRefine(rejectCharacterCreateInstructionalSentinels);

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
    const explicitInvalidCohortDiagnostic =
      summary.qualityState === "invalid" &&
      summary.coverageState === "invalid" &&
      summary.evidence.includes("numerator_outside_denominator_cohort");
    const cohortPairs: ReadonlyArray<readonly [number, number, string]> = [
      [summary.detailViews, summary.eligibleImpressions, "detailViews"],
      [summary.firstSuccessfulExchanges, summary.detailViews, "firstSuccessfulExchanges"],
      [summary.qceCount, summary.firstSuccessfulExchanges, "qceCount"],
      [summary.sameCharacterD7Returns, summary.sameCharacterD7EligiblePairs, "sameCharacterD7Returns"],
    ];
    for (const [numerator, denominator, field] of cohortPairs) {
      if (numerator > denominator && !explicitInvalidCohortDiagnostic) {
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

export const characterPortfolioVisualProductionSchema = z
  .object({
    primaryImageUrl: z.string().trim().min(1).nullable(),
    primaryImageSource: z.enum(["draft", "live"]).nullable(),
    draftPurposes: z
      .array(z.enum([
        "character_cover",
        "character_hero",
        "character_chat",
      ]))
      .max(3)
      .readonly(),
    livePurposes: z
      .array(z.enum([
        "character_cover",
        "character_hero",
        "character_chat",
      ]))
      .max(3)
      .readonly(),
    totalPurposes: z.literal(3),
    deepLink: z.string().startsWith("/admin/characters/"),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const key of ["draftPurposes", "livePurposes"] as const) {
      if (new Set(value[key]).size !== value[key].length) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "Role-image purposes must be unique",
        });
      }
    }
    if ((value.primaryImageUrl === null) !== (value.primaryImageSource === null)) {
      ctx.addIssue({
        code: "custom",
        path: ["primaryImageSource"],
        message: "Primary role-image source must match image availability",
      });
    }
    if (
      value.primaryImageSource === "draft" &&
      !value.draftPurposes.includes("character_cover")
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["draftPurposes"],
        message: "A draft primary image requires an available draft cover",
      });
    }
    if (
      value.primaryImageSource === "live" &&
      !value.livePurposes.includes("character_cover")
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["livePurposes"],
        message: "A live primary image requires an available live cover",
      });
    }
  });

export const characterPortfolioNextActionSchema = z
  .object({
    code: z.enum([
      "create_primary_portrait",
      "prepare_image_production",
      "complete_image_route",
      "continue_image_run",
      "continue_asset_pack",
      "run_preview_qa",
      "review_candidate_release",
      "monitor_live_character",
    ]),
    label: z.string().trim().min(1),
    deepLink: z.string().startsWith("/admin/characters/"),
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
    visualProduction: characterPortfolioVisualProductionSchema,
    nextAction: characterPortfolioNextActionSchema,
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

export const characterDraftImageSelectionRequestSchema = z.object({
  entityVersion: z.number().int().nonnegative(),
  purpose: z.enum(["character_cover", "character_hero", "character_chat"]),
  runId: adminIdSchema,
  itemId: adminIdSchema,
  assetId: adminIdSchema,
  reviewDecisionId: adminIdSchema,
  reason: z.string().trim().min(3).max(2_000),
}).strict();

export const characterDraftImageSelectionResultSchema = z.object({
  characterId: adminIdSchema,
  projectVersion: z.number().int().positive(),
  selectedPurpose: z.enum(["character_cover", "character_hero", "character_chat"]),
  selectedAssetId: adminIdSchema,
  draftImageAssetId: adminIdSchema.nullable(),
  draftAssetPack: z.object({
    character_cover: adminIdSchema.optional(),
    character_hero: adminIdSchema.optional(),
    character_chat: adminIdSchema.optional(),
  }).strict(),
  deepLink: z.string().startsWith("/admin/characters/"),
}).strict();

export const characterIdentityBootstrapRequestSchema = z.object({
  entityVersion: z.number().int().positive(),
  runId: adminIdSchema,
  itemId: adminIdSchema,
  assetId: adminIdSchema,
  reviewDecisionId: adminIdSchema,
  reason: z.string().trim().min(3).max(2_000),
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
    reason: z.string().trim().min(3).max(2_000),
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

export const characterReleaseCheckSchema = z
  .object({
    checkKey: z.string().trim().min(1),
    result: z.enum(["passed", "failed", "blocked", "stale"]),
    evidence: z.record(z.string(), z.unknown()),
    checkedAt: adminIsoDateTimeSchema,
  })
  .strict();

export const characterQaCheckKeySchema = z.enum([
  "explore_feed_card_desktop",
  "explore_feed_card_mobile",
  "character_detail_desktop",
  "character_detail_mobile",
  "opening_message",
  "five_turn_conversation",
  "chat_image",
]);

export const characterQaCheckInputSchema = z.object({
  key: characterQaCheckKeySchema,
  result: z.enum(["passed", "failed"]),
  evidenceRef: z.string().trim().min(1).max(1_000),
  comment: z.string().trim().min(3).max(2_000),
  fixDeepLink: z.string().trim().startsWith("/admin/characters/").max(1_000),
}).strict();

export const characterQaCheckSchema = characterQaCheckInputSchema.extend({
  ownerId: adminIdSchema,
}).strict();

export const characterQaRunCreateRequestSchema = z.object({
  entityVersion: z.number().int().positive(),
  checks: z.array(characterQaCheckInputSchema).length(7),
  reason: z.string().trim().min(3).max(2_000),
}).strict().superRefine((value, ctx) => {
  const keys = new Set(value.checks.map((check) => check.key));
  if (keys.size !== characterQaCheckKeySchema.options.length ||
    characterQaCheckKeySchema.options.some((key) => !keys.has(key))) {
    ctx.addIssue({ code: "custom", path: ["checks"], message: "QA Run requires every check exactly once" });
  }
});

export const characterQaRunSchema = z.object({
  id: adminIdSchema,
  characterId: adminIdSchema,
  projectId: adminIdSchema,
  characterContentVersionId: adminIdSchema,
  projectVersion: z.number().int().positive(),
  visualProfileId: adminIdSchema.nullable(),
  visualProfileVersion: z.number().int().positive().nullable(),
  visualProfileHash: z.string().trim().min(1).nullable(),
  referenceSetRevisionId: adminIdSchema.nullable(),
  referenceSetRevision: z.number().int().positive().nullable(),
  referenceSetHash: z.string().trim().min(1).nullable(),
  draftAssetPackHash: z.string().trim().min(1).nullable(),
  ownerId: adminIdSchema,
  status: z.enum(["passed", "failed"]),
  checks: z.array(characterQaCheckSchema).length(7).readonly(),
  evidenceHash: z.string().trim().min(1),
  createdAt: adminIsoDateTimeSchema,
}).strict();

export const characterReleaseProposalRequestSchema = z.object({
  entityVersion: z.number().int().positive(),
  qaRunId: adminIdSchema,
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1),
}).strict();

export const characterReleaseReviewRequestSchema = z.object({
  entityVersion: z.number().int().positive(),
  decision: z.enum(["approved", "changes_requested"]),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1),
}).strict();

export const characterReleaseValidationRequestSchema = z.object({
  entityVersion: z.number().int().positive(),
  confirmation: z.string().trim().min(1),
}).strict();

export const characterReleaseValidationResultSchema = z.object({
  validationRunId: adminIdSchema,
  result: z.enum(["passed", "failed"]),
  readiness: z.enum(["ready", "blocked"]),
  snapshotHash: z.string().trim().min(1),
  policyVersion: z.string().trim().min(1),
  checks: z.array(z.object({
    key: z.string().trim().min(1),
    passed: z.boolean(),
    evidence: z.record(z.string(), z.unknown()),
  }).strict()).readonly(),
}).strict();

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

export const characterVoiceCloneCreateRequestSchema = z
  .object({
    language: z.string().trim().min(1).max(40).default("english"),
    sampleText: z.string().trim().min(3).max(500),
    reason: z.string().trim().min(3).max(2_000),
  })
  .strict();

export const characterVoiceProfileSchema = z
  .object({
    id: adminIdSchema,
    version: z.number().int().positive(),
    provider: z.literal("pocket_tts"),
    providerVoiceId: z.string().trim().min(1),
    model: z.string().trim().min(1),
    language: z.string().trim().min(1),
    status: z.enum(["candidate", "active", "archived", "failed"]),
    reference: z
      .object({
        assetId: adminIdSchema,
        filename: z.string().trim().min(1),
        contentType: z.string().trim().min(1),
        sizeBytes: z.number().int().nonnegative(),
      })
      .strict(),
    preview: z
      .object({
        assetId: adminIdSchema,
        url: z.string().trim().min(1),
        durationMs: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
    sampleText: z.string(),
    createdById: adminIdSchema,
    createdAt: adminIsoDateTimeSchema,
    archivedAt: adminIsoDateTimeSchema.nullable(),
  })
  .strict();

export const characterVoiceWorkspaceSchema = z
  .object({
    provider: z.enum(["mock", "pipeline", "pocket_tts"]),
    cloningAvailable: z.boolean(),
    runtimeStatus: z.enum([
      "ready",
      "model_access_required",
      "unavailable",
      "inactive",
    ]),
    runtimeLanguage: z.string().trim().min(1),
    currentVoiceId: z.string().nullable(),
    activeProfile: characterVoiceProfileSchema.nullable(),
    candidateProfile: characterVoiceProfileSchema.nullable(),
    history: z.array(characterVoiceProfileSchema).readonly(),
  })
  .strict();

export const characterVoiceCloneCreateResponseSchema = z
  .object({
    profile: characterVoiceProfileSchema,
    replacedCandidateProfileId: adminIdSchema.nullable(),
    replayed: z.boolean(),
  })
  .strict();

export const characterVoiceActivationRequestSchema = z
  .object({
    reason: z.string().trim().min(3).max(2_000),
    expectedActiveProfileId: adminIdSchema.nullable(),
    expectedCurrentVoiceId: z.string().trim().min(1).nullable(),
  })
  .strict();

export const characterVoiceActivationResponseSchema = z
  .object({
    profile: characterVoiceProfileSchema,
    replacedActiveProfileId: adminIdSchema.nullable(),
    replayed: z.boolean(),
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

export const characterReleaseMonitorRefreshRequestSchema = z
  .object({
    entityVersion: z.number().int().nonnegative(),
  })
  .strict();

export const characterReleaseMonitorRefreshResultSchema = z.object({
  releaseId: adminIdSchema,
  window: z.enum(["24h", "72h"]),
  status: z.string().trim().min(1),
  mature: z.boolean(),
  recommendation: z.string().trim().min(1),
  observed: z.record(z.string(), z.unknown()),
}).strict();

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
export type CharacterVoiceProfile = z.infer<typeof characterVoiceProfileSchema>;
export type CharacterVoiceWorkspace = z.infer<typeof characterVoiceWorkspaceSchema>;
export type CharacterVoiceCloneCreateRequest = z.infer<
  typeof characterVoiceCloneCreateRequestSchema
>;
export type CharacterVoiceCloneCreateResponse = z.infer<
  typeof characterVoiceCloneCreateResponseSchema
>;
export type CharacterVoiceActivationRequest = z.infer<
  typeof characterVoiceActivationRequestSchema
>;
export type CharacterVoiceActivationResponse = z.infer<
  typeof characterVoiceActivationResponseSchema
>;
export type CharacterReferenceSetPublishRequest = z.infer<typeof characterReferenceSetPublishRequestSchema>;
export type CharacterLookArchiveRequest = z.infer<typeof characterLookArchiveRequestSchema>;
export type CharacterDraftImageSelectionRequest = z.infer<typeof characterDraftImageSelectionRequestSchema>;
export type CharacterIdentityBootstrapRequest = z.infer<typeof characterIdentityBootstrapRequestSchema>;
export type CharacterIdentityBootstrapResponse = z.infer<typeof characterIdentityBootstrapResponseSchema>;
export type CharacterImageReadinessRepairRequest = z.infer<typeof characterImageReadinessRepairRequestSchema>;
export type CharacterImageReadinessRepairResponse = z.infer<typeof characterImageReadinessRepairResponseSchema>;
export type CharacterQaCheck = z.infer<typeof characterQaCheckSchema>;
export type CharacterQaCheckInput = z.infer<typeof characterQaCheckInputSchema>;
export type CharacterQaRunCreateRequest = z.infer<typeof characterQaRunCreateRequestSchema>;
export type CharacterQaRun = z.infer<typeof characterQaRunSchema>;
export type CharacterReleaseProposalRequest = z.infer<typeof characterReleaseProposalRequestSchema>;
export type CharacterReleaseReviewRequest = z.infer<typeof characterReleaseReviewRequestSchema>;
export type CharacterReleaseValidationRequest = z.infer<typeof characterReleaseValidationRequestSchema>;
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
