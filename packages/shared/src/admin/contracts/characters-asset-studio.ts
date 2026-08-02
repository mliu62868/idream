// SPEC: Asset Studio — selecting a reviewed Run item as a draft image, and the
// operator-uploaded image sources feeding it.

import { z } from "zod";
import {
  adminIdSchema,
  adminIsoDateTimeSchema,
} from "./common";

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

export const characterImageSourceUploadRequestSchema = z
  .object({
    purpose: z.literal("identity_experiment_source"),
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

export type CharacterDraftImageSelectionRequest = z.infer<typeof characterDraftImageSelectionRequestSchema>;
