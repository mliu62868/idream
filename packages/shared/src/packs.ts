import { z } from "zod";

export const packVisibilitySchema = z.enum(["private", "unlisted", "public"]);
export const packStatusSchema = z.enum(["draft", "published", "withdrawn", "blocked"]);
const itemWriteSchema = z.object({
  mediaAssetId: z.string().min(1).max(128),
  caption: z.string().trim().max(600).default(""),
}).strict();
export const packContentSchema = z.object({
  items: z.array(itemWriteSchema).max(16),
  coverAssetId: z.string().min(1).max(128).nullable().default(null),
  claimUntil: z.iso.datetime().nullable().default(null),
}).strict().superRefine((value, ctx) => {
  const ids = value.items.map(item => item.mediaAssetId);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "Each asset can appear once in a Pack", path: ["items"] });
  if (value.coverAssetId && !ids.includes(value.coverAssetId)) ctx.addIssue({ code: "custom", message: "The cover must be one of the selected assets", path: ["coverAssetId"] });
});
export const packManifestSchema = packContentSchema.safeExtend({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).default(""),
  visibility: packVisibilitySchema.default("private"),
}).strict();
export const packVersionSchema = z.object({ version: z.number().int().positive() }).strict();
export const packWriteSchema = packVersionSchema.extend({ manifest: packManifestSchema }).strict();
export const packClaimSchema = z.object({ releaseId: z.string().min(1).max(128), version: z.number().int().positive() }).strict();
export const packBlockSchema = packVersionSchema.extend({ confirmation: z.string().min(1), reason: z.string().trim().min(3).max(1000) }).strict();
export const PACK_RIGHTS = "personal_view_download_current_only" as const;
export const packSummarySchema = z.object({
  id: z.string(), title: z.string(), description: z.string(),
  visibility: packVisibilitySchema, status: packStatusSchema, version: z.number().int().positive(),
  creator: z.object({ id: z.string().nullable(), displayName: z.string() }).strict(),
  itemCount: z.number().int().nonnegative(), coverUrl: z.string().nullable(),
  releaseId: z.string().nullable(), releaseVersion: z.number().int().positive().nullable(),
  claimUntil: z.string().nullable(), publishedAt: z.string().nullable(), updatedAt: z.string(),
  priceCents: z.literal(0), rights: z.literal(PACK_RIGHTS),
  canManage: z.boolean(), canClaim: z.boolean(),
}).strict();
export const packGrantSchema = z.object({ id: z.string(), releaseId: z.string(), version: z.number().int().positive(), title: z.string(), claimedAt: z.string(), href: z.string() }).strict();
export const packDetailSchema = packSummarySchema.extend({
  manifest: packManifestSchema.nullable(),
  grant: packGrantSchema.nullable(), grants: z.array(packGrantSchema),
  blockedReason: z.string().nullable(),
  release: z.object({
    id: z.string(), version: z.number().int().positive(), title: z.string(), description: z.string(),
    priceCents: z.literal(0), rights: z.literal(PACK_RIGHTS), claimUntil: z.string().nullable(), publishedAt: z.string(),
    canAccess: z.boolean(),
    items: z.array(z.object({ id: z.string(), caption: z.string(), type: z.enum(["image", "video", "voice"]), contentType: z.string(), sizeBytes: z.number().int().positive(), url: z.string().nullable(), downloadUrl: z.string().nullable() }).strict()),
  }).strict().nullable(),
}).strict();
export const packListSchema = z.object({ items: z.array(packSummarySchema), nextCursor: z.string().nullable() }).strict();
export const packSourcesSchema = z.object({ items: z.array(z.object({ id: z.string(), type: z.enum(["image", "video", "voice"]), url: z.string() }).strict()), nextCursor: z.string().nullable() }).strict();
export type PackManifest = z.infer<typeof packManifestSchema>;
export type PackSummary = z.infer<typeof packSummarySchema>;
export type PackDetail = z.infer<typeof packDetailSchema>;
