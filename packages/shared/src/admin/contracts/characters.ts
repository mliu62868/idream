import { z } from "zod";
import {
  adminCursorQuerySchema,
  adminCommandRequestSchema,
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
    if (release.status === "published" && release.publishedAt === null) {
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

export const characterPerformanceSummarySchema = z
  .object({
    window: z.enum(["7d", "28d"]),
    sampleSize: z.number().int().nonnegative(),
    maturity: z.enum(["mature", "immature", "insufficient_data"]),
    eligibleImpressions: z.number().int().nonnegative().nullable(),
    chatStartRate: z.number().min(0).max(1).nullable(),
    qceRate: z.number().min(0).max(1).nullable(),
    sameCharacterD7: z.number().min(0).max(1).nullable(),
    contributionMarginMicros: z.number().int().nullable(),
    latestDataAt: adminIsoDateTimeSchema.nullable(),
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
    performance: characterPerformanceSummarySchema.nullable(),
    operationalState: operationalStateViewSchema,
  })
  .strict();

export const characterPortfolioQuerySchema = adminCursorQuerySchema.extend({
  phase: characterProjectPhaseSchema.optional(),
  servingState: characterServingStateSchema.optional(),
  readiness: adminReadinessSchema.optional(),
  ownerId: adminIdSchema.optional(),
});

export const characterPortfolioResponseSchema = adminListResponseSchema(characterPortfolioItemSchema);

export type CharacterProject = z.infer<typeof characterProjectSchema>;
export type CharacterRelease = z.infer<typeof characterReleaseSchema>;
export type CharacterServing = z.infer<typeof characterServingSchema>;
export type CharacterPortfolioItem = z.infer<typeof characterPortfolioItemSchema>;
export type CharacterPortfolioQuery = z.infer<typeof characterPortfolioQuerySchema>;
export type CharacterReleasePublishCommandRequest = z.infer<
  typeof characterReleasePublishCommandRequestSchema
>;
export type CharacterReleaseScheduleCommandRequest = z.infer<
  typeof characterReleaseScheduleCommandRequestSchema
>;
export type CharacterReleaseRollbackCommandRequest = z.infer<
  typeof characterReleaseRollbackCommandRequestSchema
>;
