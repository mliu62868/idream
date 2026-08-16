import { z } from "zod";
import {
  adminIdSchema,
  adminIsoDateTimeSchema,
  adminJsonValueSchema,
  adminListResponseSchema,
} from "./common";
import { creativeRunPurposeSchema } from "./creative";

export const contentAssetReviewStatusSchema = z.enum([
  "draft",
  "generated",
  "approved",
  "rejected",
  "published",
  "archived",
]);

export const contentAssetQuerySchema = z.object({
  status: contentAssetReviewStatusSchema.optional(),
  purpose: creativeRunPurposeSchema.optional(),
  profileId: adminIdSchema.optional(),
  targetId: adminIdSchema.optional(),
  tag: z.string().trim().min(1).max(60).optional(),
  search: z.string().trim().min(1).max(200).optional(),
  cursor: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
}).strict();

const optionalText = (max: number) => z.string().trim().max(max).optional();

export const contentAssetPatchRequestSchema = z.object({
  status: contentAssetReviewStatusSchema.optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(48).optional(),
  description: optionalText(2_000),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
}).strict();

export const contentAssetBulkRequestSchema = z.object({
  assetIds: z.array(adminIdSchema.max(180)).min(1).max(100),
  status: contentAssetReviewStatusSchema.optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(48).optional(),
  description: optionalText(2_000),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(20_000),
}).strict();

export const contentAssetBulkPreflightRequestSchema = z.object({
  assetIds: z.array(adminIdSchema.max(180)).min(1).max(100),
}).strict();

export const contentAssetAuthorityDependencySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("character_primary_image"),
    characterId: adminIdSchema,
    repairPath: z.string().trim().min(1),
  }).strict(),
  z.object({
    kind: z.literal("character_project_draft"),
    characterId: adminIdSchema,
    projectId: adminIdSchema,
    repairPath: z.string().trim().min(1),
  }).strict(),
  z.object({
    kind: z.literal("character_visual_identity"),
    characterId: adminIdSchema,
    visualProfileId: adminIdSchema,
    repairPath: z.string().trim().min(1),
  }).strict(),
  z.object({
    kind: z.literal("character_reference_set"),
    characterId: adminIdSchema,
    visualProfileId: adminIdSchema,
    referenceSetRevisionId: adminIdSchema,
    repairPath: z.string().trim().min(1),
  }).strict(),
  z.object({
    kind: z.literal("character_generation_job"),
    characterId: adminIdSchema.nullable(),
    generationJobId: adminIdSchema,
    runId: adminIdSchema.nullable(),
    repairPath: z.string().trim().min(1),
  }).strict(),
  z.object({
    kind: z.literal("character_look"),
    characterId: adminIdSchema,
    lookId: adminIdSchema,
    status: z.string().trim().min(1),
    repairPath: z.string().trim().min(1),
  }).strict(),
  z.object({
    kind: z.literal("creative_run_asset"),
    runId: adminIdSchema,
    itemId: adminIdSchema,
    status: z.string().trim().min(1),
    characterId: adminIdSchema.nullable(),
    repairPath: z.string().trim().min(1),
  }).strict(),
  z.object({
    kind: z.literal("character_release"),
    characterId: adminIdSchema,
    releaseId: adminIdSchema,
    releaseState: z.enum(["current", "scheduled"]),
    slot: z.string().trim().min(1),
    repairPath: z.string().trim().min(1),
  }).strict(),
  z.object({
    kind: z.literal("verified_campaign"),
    placementId: adminIdSchema,
    runId: adminIdSchema.nullable(),
    targetId: adminIdSchema,
    repairPath: z.string().trim().min(1),
  }).strict(),
  z.object({
    kind: z.literal("placement_verification"),
    placementId: adminIdSchema,
    runId: adminIdSchema.nullable(),
    targetId: adminIdSchema,
    repairPath: z.string().trim().min(1),
  }).strict(),
]);

const contentAssetSourceJobSchema = z.object({
  id: adminIdSchema,
  status: z.string().trim().min(1),
  profileId: adminIdSchema.nullable(),
  profileVersion: z.number().int().nullable(),
  recipeId: adminIdSchema.nullable(),
  recipeVersion: z.number().int().nullable(),
  sourceType: z.string().trim().min(1),
  sourceId: adminIdSchema.nullable(),
  sourceMeta: adminJsonValueSchema.nullable(),
}).strict();

const contentAssetSourceBatchSchema = z.object({
  id: adminIdSchema,
  title: z.string(),
  purpose: z.string().trim().min(1),
  status: z.string().trim().min(1),
}).strict();

const contentAssetPlacementSchema = z.object({
  id: adminIdSchema,
  slot: z.string().trim().min(1),
  targetType: z.string().trim().min(1),
  targetId: adminIdSchema,
  status: z.string().trim().min(1),
  publishedAt: adminIsoDateTimeSchema.nullable(),
}).strict();

/**
 * SPEC: one MediaAsset row as the Admin wire sees it — the shape `mediaAssetDTO` produces.
 * INTENT: the Image Library and the Placement editor both carry the same asset row. Declaring
 * it once and composing it keeps a single answer to `customerPublishable` across both, which
 * is the whole reason `mediaAssetDTO` exists on the server side.
 */
export const adminMediaAssetSchema = z.object({
  id: adminIdSchema,
  type: z.string().trim().min(1),
  url: z.string().trim().min(1),
  thumbnailUrl: z.string().trim().min(1),
  contentType: z.string().trim().min(1).nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  safetyStatus: z.string().trim().min(1),
  sourceJobId: adminIdSchema.nullable(),
  isSynthetic: z.boolean(),
  customerPublishable: z.boolean(),
  publishabilityReasons: z.array(z.string().trim().min(1)),
  promptSummary: z.string().nullable(),
  metadata: adminJsonValueSchema,
  createdAt: adminIsoDateTimeSchema,
});

export const contentAssetSchema = adminMediaAssetSchema.extend({
  platformStatus: z.string().trim().min(1),
  purpose: z.string().trim().min(1).nullable(),
  targetType: z.string().trim().min(1).nullable(),
  targetId: adminIdSchema.nullable(),
  tags: z.array(z.string()),
  description: z.string().nullable(),
  sourceJob: contentAssetSourceJobSchema.nullable(),
  sourceBatch: contentAssetSourceBatchSchema.nullable(),
  placements: z.array(contentAssetPlacementSchema),
  authorityDependencies: z.array(contentAssetAuthorityDependencySchema).optional(),
}).strict();

export const contentAssetListResponseSchema = adminListResponseSchema(contentAssetSchema);

export const contentAssetDetailResponseSchema = z.object({
  asset: contentAssetSchema,
}).strict();

export const contentAssetMutationResponseSchema = contentAssetDetailResponseSchema;

export const contentAssetBulkPreflightResponseSchema = z.object({
  assetIds: z.array(adminIdSchema),
  blockers: z.array(z.object({
    assetId: adminIdSchema,
    dependencies: z.array(contentAssetAuthorityDependencySchema),
  }).strict()),
}).strict();

export const contentAssetBulkMutationResponseSchema = z.object({
  updatedIds: z.array(adminIdSchema),
}).strict();

export type ContentAssetQuery = z.infer<typeof contentAssetQuerySchema>;
export type ContentAssetReviewStatus = z.infer<typeof contentAssetReviewStatusSchema>;
export type ContentAssetAuthorityDependency = z.infer<
  typeof contentAssetAuthorityDependencySchema
>;
export type AdminMediaAsset = z.infer<typeof adminMediaAssetSchema>;
export type ContentAsset = z.infer<typeof contentAssetSchema>;
export type ContentAssetListResponse = z.infer<typeof contentAssetListResponseSchema>;
export type ContentAssetDetailResponse = z.infer<typeof contentAssetDetailResponseSchema>;
export type ContentAssetMutationResponse = z.infer<typeof contentAssetMutationResponseSchema>;
export type ContentAssetBulkPreflightResponse = z.infer<
  typeof contentAssetBulkPreflightResponseSchema
>;
export type ContentAssetBulkMutationResponse = z.infer<
  typeof contentAssetBulkMutationResponseSchema
>;
export type ContentAssetPatchRequest = z.infer<typeof contentAssetPatchRequestSchema>;
export type ContentAssetBulkRequest = z.infer<typeof contentAssetBulkRequestSchema>;
export type ContentAssetBulkPreflightRequest = z.infer<
  typeof contentAssetBulkPreflightRequestSchema
>;
