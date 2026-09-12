import { z } from "zod";

export const comicVisibilitySchema = z.enum(["private", "unlisted", "public"]);
export const comicStatusSchema = z.enum(["draft", "pending_review", "published", "withdrawn"]);
const pageWriteSchema = z.object({
  mediaAssetId: z.string().min(1).max(128),
  caption: z.string().trim().max(600).default(""),
}).strict();
export const comicManifestSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).default(""),
  visibility: comicVisibilitySchema.default("private"),
  allowRemix: z.boolean().default(false),
  episodes: z.array(z.object({
    title: z.string().trim().min(1).max(120),
    pages: z.array(pageWriteSchema).max(50),
  }).strict()).min(1).max(20),
}).strict().superRefine((value, ctx) => {
  if (value.episodes.reduce((total, episode) => total + episode.pages.length, 0) > 200) {
    ctx.addIssue({ code: "custom", message: "A Comic can contain at most 200 pages", path: ["episodes"] });
  }
});
export const comicWriteSchema = z.object({
  version: z.number().int().positive(),
  manifest: comicManifestSchema,
}).strict();
export const comicVersionSchema = z.object({ version: z.number().int().positive() }).strict();
export const comicDecisionSchema = comicVersionSchema.extend({
  decision: z.enum(["approve", "reject", "remove"]),
  reason: z.string().trim().min(3).max(1000),
}).strict();
const creatorSchema = z.object({ id: z.string(), displayName: z.string() }).strict();
export const comicSummarySchema = z.object({
  id: z.string(), title: z.string(), description: z.string(),
  visibility: comicVisibilitySchema, status: comicStatusSchema,
  allowRemix: z.boolean(),
  version: z.number().int().positive(), creator: creatorSchema,
  pageCount: z.number().int().nonnegative(), episodeCount: z.number().int().nonnegative(),
  coverUrl: z.string().nullable(), updatedAt: z.string(), publishedAt: z.string().nullable(),
  canManage: z.boolean(),
}).strict();
export const comicDetailSchema = comicSummarySchema.extend({
  reviewNote: z.string().nullable(),
  episodes: z.array(z.object({
    id: z.string(), title: z.string(), ordinal: z.number().int(),
    pages: z.array(z.object({
      id: z.string(), mediaAssetId: z.string().nullable(), ordinal: z.number().int(),
      caption: z.string(), url: z.string().nullable(), remixHref: z.string().nullable(),
      character: z.object({
        id: z.string(), name: z.string(), remixHref: z.string(),
      }).strict().nullable(),
    }).strict()),
  }).strict()),
}).strict();
export const comicListSchema = z.object({ items: z.array(comicSummarySchema), nextCursor: z.string().nullable() }).strict();
export type ComicManifest = z.infer<typeof comicManifestSchema>;
export type ComicSummary = z.infer<typeof comicSummarySchema>;
export type ComicDetail = z.infer<typeof comicDetailSchema>;
