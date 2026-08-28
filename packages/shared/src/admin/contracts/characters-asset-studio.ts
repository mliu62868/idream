// SPEC: Character images enter one library through generation or upload. The
// three product placements select an available library asset directly; a
// Creative review decision is not part of that operator action.

import { z } from "zod";
import {
  adminIdSchema,
  adminIsoDateTimeSchema,
} from "./common";

export const characterDraftImageSelectionRequestSchema = z.object({
  entityVersion: z.number().int().nonnegative(),
  purpose: z.enum(["character_cover", "character_hero", "character_chat"]),
  assetId: adminIdSchema,
  // Historical clients may still send generation lineage. It remains useful
  // evidence when present, but never gates choosing an existing library asset.
  runId: adminIdSchema.optional(),
  itemId: adminIdSchema.optional(),
  reviewDecisionId: adminIdSchema.optional(),
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

export const characterImageSourceUploadRequestSchema = z
  .object({
    purpose: z.enum(["identity_experiment_source", "character_library"]),
  })
  .strict();

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
  })
  .strict();

export const characterImageSourceListResponseSchema = z
  .object({
    items: z.array(characterImageSourceAssetSchema).readonly(),
  })
  .strict();

export const characterImageSourceUploadResponseSchema = z
  .object({
    asset: characterImageSourceAssetSchema,
    replayed: z.boolean(),
  })
  .strict();

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
