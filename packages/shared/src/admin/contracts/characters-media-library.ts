import { z } from "zod";
import { adminIdSchema, adminIsoDateTimeSchema } from "./common";

// INTENT: chat-library membership is independent of the Character's three fixed
// display placements. The descriptor records observed content, never the prompt
// that originally requested it. Main owns publication and visual identity pins.
export const characterMediaLibraryTypeSchema = z.enum(["image", "video"]);
export const characterMediaLibraryStatusSchema = z.enum(["draft", "published", "withdrawn"]);
export const characterMediaLibraryNuditySchema = z.enum(["unknown", "none", "partial", "full"]);
const factSchema = z.string().trim().min(1).max(160);
const factsSchema = z.array(factSchema).max(48);
const descriptionSchema = z.string().trim().min(3).max(2_000);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const visualIdentitySchema = z.object({
  visualProfileId: adminIdSchema,
  visualProfileVersion: z.number().int().positive(),
}).strict();
const coverageSchema = z.object({
  published: z.number().int().nonnegative(),
  hasEligibleMedia: z.boolean(),
}).strict().nullable();

export const characterMediaLibraryEntrySchema = z.object({
  id: adminIdSchema,
  characterId: adminIdSchema,
  sourceAssetId: adminIdSchema,
  mediaType: characterMediaLibraryTypeSchema,
  visualProfileId: adminIdSchema,
  visualProfileVersion: z.number().int().positive(),
  revision: z.number().int().positive(),
  status: characterMediaLibraryStatusSchema,
  description: descriptionSchema,
  facts: factsSchema,
  absentFacts: factsSchema,
  nudity: characterMediaLibraryNuditySchema,
  descriptionSource: z.enum(["operator", "vision"]),
  sourceSha256: digestSchema,
  url: z.string().trim().min(1),
  thumbnailUrl: z.string().trim().min(1).nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  durationSeconds: z.number().positive().nullable(),
  hasAudio: z.boolean().nullable(),
  createdAt: adminIsoDateTimeSchema,
  updatedAt: adminIsoDateTimeSchema,
}).strict();

export const characterMediaLibraryQuerySchema = z.object({
  mediaType: characterMediaLibraryTypeSchema.optional(),
  status: characterMediaLibraryStatusSchema.optional(),
  sourceAssetId: adminIdSchema.optional(),
  search: z.string().trim().min(1).max(200).optional(),
  cursor: z.string().trim().min(1).max(2_048).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
}).strict();

export const characterMediaLibraryContentQuerySchema = z.object({
  thumbnail: z.enum(["0", "1"]).default("0"),
}).strict();

// Binary operations validate their response metadata without consuming the stream.
export const characterMediaLibraryContentResponseSchema = z.object({
  contentType: z.enum(["image/jpeg", "image/png", "image/webp", "video/mp4", "video/webm"]),
  cacheControl: z.literal("private, no-store"),
  status: z.union([z.literal(200), z.literal(206)]),
}).strict();

export const characterMediaLibraryListResponseSchema = z.object({
  items: z.array(characterMediaLibraryEntrySchema),
  nextCursor: z.string().nullable(),
  capabilities: z.object({ describe: z.boolean(), search: z.boolean() }).strict(),
  // The active production identity can advance before the public Release does.
  visualIdentity: visualIdentitySchema.nullable(),
  serving: z.object({ releaseId: adminIdSchema, visualIdentity: visualIdentitySchema.nullable() }).strict().nullable(),
  coverage: z.object({ production: coverageSchema, serving: coverageSchema }).strict(),
}).strict();

const descriptorFields = {
  description: descriptionSchema,
  facts: factsSchema.default([]),
  absentFacts: factsSchema.default([]),
  nudity: characterMediaLibraryNuditySchema,
} as const;

export const characterMediaLibraryCreateRequestSchema = z.object({
  sourceAssetId: adminIdSchema,
  expectedVisualProfileId: adminIdSchema,
  expectedVisualProfileVersion: z.number().int().positive(),
  ...descriptorFields,
  status: z.enum(["draft", "published"]).default("draft"),
}).strict();

export const characterMediaLibraryUpdateRequestSchema = z.object({
  expectedRevision: z.number().int().positive(),
  description: descriptionSchema.optional(),
  facts: factsSchema.optional(),
  absentFacts: factsSchema.optional(),
  nudity: characterMediaLibraryNuditySchema.optional(),
  status: characterMediaLibraryStatusSchema.optional(),
}).strict().refine(
  (body) => Object.keys(body).some((key) => key !== "expectedRevision"),
  "Provide a description or publication change",
);

export const characterMediaLibraryMutationResponseSchema = z.object({
  entry: characterMediaLibraryEntrySchema,
  replayed: z.boolean(),
}).strict();

export const characterMediaLibraryDescribeRequestSchema = z.object({
  sourceAssetId: adminIdSchema,
  visualIdentity: visualIdentitySchema.optional(),
}).strict();

// A model observation is a draft suggestion. Saving the operator's edited text
// does not allow the browser to claim it is an unchanged machine observation.
export const characterMediaLibraryDescribeResponseSchema = z.object({
  ...descriptorFields,
  sourceSha256: digestSchema,
  model: z.string().trim().min(1),
}).strict();

export const characterMediaLibrarySearchRequestSchema = z.object({
  mediaType: characterMediaLibraryTypeSchema,
  visualIdentity: visualIdentitySchema.optional(),
  query: z.string().trim().min(1).max(2_000),
  requiredFacts: factsSchema.default([]),
  excludedFacts: factsSchema.default([]),
  nudity: z.enum(["unspecified", "none", "full"]).default("unspecified"),
}).strict();

export const characterMediaLibrarySearchResponseSchema = z.object({
  matches: z.array(z.object({
    entry: characterMediaLibraryEntrySchema,
    score: z.number().finite(),
    reasons: z.array(z.string()),
  }).strict()),
  elapsedMs: z.number().nonnegative(),
}).strict();

export type CharacterMediaLibraryEntry = z.infer<typeof characterMediaLibraryEntrySchema>;
export type CharacterMediaLibraryVisualIdentity = z.infer<typeof visualIdentitySchema>;
export type CharacterMediaLibraryQuery = z.infer<typeof characterMediaLibraryQuerySchema>;
export type CharacterMediaLibraryListResponse = z.infer<typeof characterMediaLibraryListResponseSchema>;
export type CharacterMediaLibraryCreateRequest = z.infer<typeof characterMediaLibraryCreateRequestSchema>;
export type CharacterMediaLibraryUpdateRequest = z.infer<typeof characterMediaLibraryUpdateRequestSchema>;
export type CharacterMediaLibraryMutationResponse = z.infer<typeof characterMediaLibraryMutationResponseSchema>;
export type CharacterMediaLibraryDescribeRequest = z.infer<typeof characterMediaLibraryDescribeRequestSchema>;
export type CharacterMediaLibraryDescribeResponse = z.infer<typeof characterMediaLibraryDescribeResponseSchema>;
export type CharacterMediaLibrarySearchRequest = z.infer<typeof characterMediaLibrarySearchRequestSchema>;
export type CharacterMediaLibrarySearchResponse = z.infer<typeof characterMediaLibrarySearchResponseSchema>;
