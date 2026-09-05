// SPEC: Character images enter one library through generation or upload, pass
// a visible Review decision, and only then become selectable for a placement.
// Generation provenance and operator-upload provenance remain distinct facts.

import { z } from "zod";
import {
  adminIdSchema,
  adminIsoDateTimeSchema,
} from "./common";
import { CHARACTER_IDENTITY_APPROVAL_MIN_SCORE } from "./creative";

export const characterImagePlacementPurposeSchema = z.enum([
  "character_cover",
  "character_hero",
  "character_chat",
]);

export const characterImageQualificationStateSchema = z.enum([
  "candidate",
  "selectable",
  "rejected",
  "selected",
  "release_qualified",
]);

export const characterImageQualificationBlockerSchema = z.enum([
  "asset_unavailable",
  "source_authority_invalid",
  "purpose_mismatch",
  "review_pending",
  "review_rejected",
  "review_authority_changed",
  "review_evidence_incomplete",
  "visual_authority_missing",
  "visual_authority_changed",
]);

export const characterImageReviewQualitySchema = z.object({
  artifactFree: z.boolean(),
  singleSubject: z.boolean(),
  intentMatch: z.boolean(),
  noVisibleText: z.boolean(),
}).strict();

export const characterImageQualificationSchema = z.object({
  source: z.enum(["generation", "operator_upload", "legacy"]),
  state: characterImageQualificationStateSchema,
  selectablePurposes: z.array(characterImagePlacementPurposeSchema).readonly(),
  selectedPurposes: z.array(characterImagePlacementPurposeSchema).readonly(),
  releaseQualifiedPurposes: z.array(characterImagePlacementPurposeSchema).readonly(),
  blockers: z.array(characterImageQualificationBlockerSchema).readonly(),
  authority: z.object({
    runId: adminIdSchema.nullable(),
    itemId: adminIdSchema.nullable(),
    reviewDecisionId: adminIdSchema.nullable(),
    generationJobId: adminIdSchema.nullable(),
  }).strict(),
  review: z.object({
    id: adminIdSchema,
    decision: z.enum(["approved", "rejected"]),
    identityConsistency: z.enum(["passed", "failed", "unscored"]),
    score: z.number().int().min(0).max(100).nullable(),
    quality: characterImageReviewQualitySchema.nullable(),
    reason: z.string(),
    createdAt: adminIsoDateTimeSchema,
  }).strict().nullable(),
}).strict();

export const characterDraftImageSelectionRequestSchema = z.object({
  entityVersion: z.number().int().nonnegative(),
  purpose: characterImagePlacementPurposeSchema,
  assetId: adminIdSchema,
  // These optional assertions let an already-open generation workspace fail
  // closed if Review authority changed. Main always resolves and persists the
  // canonical lineage; caller-supplied IDs never create authority.
  runId: adminIdSchema.optional(),
  itemId: adminIdSchema.optional(),
  reviewDecisionId: adminIdSchema.optional(),
  reason: z.string().trim().min(3).max(2_000),
}).strict();

export const characterDraftImageSelectionResultSchema = z.object({
  characterId: adminIdSchema,
  projectVersion: z.number().int().positive(),
  selectedPurpose: characterImagePlacementPurposeSchema,
  selectedAssetId: adminIdSchema,
  draftImageAssetId: adminIdSchema.nullable(),
  draftAssetPack: z.object({
    character_cover: adminIdSchema.optional(),
    character_hero: adminIdSchema.optional(),
    character_chat: adminIdSchema.optional(),
  }).strict(),
  deepLink: z.string().startsWith("/admin/characters/"),
}).strict();

export const characterImageSourceUploadRequestSchema = z
  .object({
    purpose: z.enum(["identity_experiment_source", "character_library"]),
  })
  .strict();

export const characterImageSourceQuerySchema = z.object({
  cursor: z.string().trim().min(1).max(2_048).optional(),
  search: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
  purpose: z.enum(["identity_experiment_source", "character_library"])
    .default("identity_experiment_source"),
}).strict();

export const characterImageSourceAssetSchema = z
  .object({
    id: adminIdSchema,
    url: z.string().trim().min(1),
    thumbnailUrl: z.string().trim().min(1).nullable(),
    filename: z.string().trim().min(1),
    contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
    sizeBytes: z.number().int().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    createdAt: adminIsoDateTimeSchema,
    qualification: characterImageQualificationSchema.nullable(),
  })
  .strict();

export const characterImageSourceListResponseSchema = z
  .object({
    items: z.array(characterImageSourceAssetSchema).readonly(),
    nextCursor: z.string().nullable(),
  })
  .strict();

export const characterImageSourceUploadResponseSchema = z
  .object({
    asset: characterImageSourceAssetSchema,
    replayed: z.boolean(),
  })
  .strict();

export const characterImageReviewRequestSchema = z.object({
  supersedesDecisionId: adminIdSchema.optional(),
  decision: z.enum(["approved", "rejected"]),
  identityConsistency: z.enum(["passed", "failed"]),
  score: z.number().int().min(0).max(100).optional(),
  quality: characterImageReviewQualitySchema,
  reason: z.string().trim().min(3).max(2_000),
}).strict().superRefine((review, ctx) => {
  if (review.decision !== "approved") return;
  if (review.identityConsistency !== "passed") {
    ctx.addIssue({
      code: "custom",
      path: ["identityConsistency"],
      message: "An imported Character image can only be approved when identity consistency passes",
    });
  }
  if (
    review.score === undefined ||
    review.score < CHARACTER_IDENTITY_APPROVAL_MIN_SCORE
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["score"],
      message: `An imported Character image approval requires an identity score of at least ${CHARACTER_IDENTITY_APPROVAL_MIN_SCORE}`,
    });
  }
  if (Object.values(review.quality).some((passed) => !passed)) {
    ctx.addIssue({
      code: "custom",
      path: ["quality"],
      message: "Every visible quality check must pass before approval",
    });
  }
});

export const characterImageReviewResultSchema = z.object({
  characterId: adminIdSchema,
  assetId: adminIdSchema,
  decisionId: adminIdSchema,
  qualification: characterImageQualificationSchema,
  replayed: z.boolean(),
}).strict();

export const characterVideoSourceUploadRequestSchema = z
  .object({
    purpose: z.literal("character_video_library"),
  })
  .strict();

export const characterVideoUploadAssetSchema = z
  .object({
    id: adminIdSchema,
    url: z.string().trim().min(1),
    filename: z.string().trim().min(1),
    contentType: z.enum(["video/mp4", "video/webm"]),
    sizeBytes: z.number().int().positive(),
    createdAt: adminIsoDateTimeSchema,
  })
  .strict();

export const characterVideoSourceUploadResponseSchema = z
  .object({
    asset: characterVideoUploadAssetSchema,
    replayed: z.boolean(),
  })
  .strict();

export type CharacterImageSourceAsset = z.infer<
  typeof characterImageSourceAssetSchema
>;

export type CharacterImageSourceListResponse = z.infer<
  typeof characterImageSourceListResponseSchema
>;

export type CharacterImageQualification = z.infer<
  typeof characterImageQualificationSchema
>;

export type CharacterImageReviewRequest = z.infer<
  typeof characterImageReviewRequestSchema
>;

export type CharacterImageReviewResult = z.infer<
  typeof characterImageReviewResultSchema
>;

export type CharacterImageSourceUploadRequest = z.infer<
  typeof characterImageSourceUploadRequestSchema
>;

export type CharacterImageSourceUploadResponse = z.infer<
  typeof characterImageSourceUploadResponseSchema
>;

export type CharacterVideoUploadAsset = z.infer<
  typeof characterVideoUploadAssetSchema
>;

export type CharacterVideoSourceUploadRequest = z.infer<
  typeof characterVideoSourceUploadRequestSchema
>;

export type CharacterVideoSourceUploadResponse = z.infer<
  typeof characterVideoSourceUploadResponseSchema
>;

export type CharacterDraftImageSelectionRequest = z.infer<typeof characterDraftImageSelectionRequestSchema>;
