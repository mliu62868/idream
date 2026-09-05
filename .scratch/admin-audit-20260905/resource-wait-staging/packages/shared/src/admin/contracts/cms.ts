import { z } from "zod";
import { adminIsoDateTimeSchema, adminJsonValueSchema } from "./common";

/**
 * SPEC: Admin CMS/SEO 页面的公开请求与响应契约。
 * INTENT: `path` 在这里只有长度约束。「哪些 pathname 归 CMS 所有」由 Main 的
 *   `server/cms/route-page-contract` 说了算（归一化正则 + 保留前缀 + 可发布性），
 *   把那份规则复制进 shared 会立刻长出第二份权威，且它拒绝任何通用字符串夹具。
 *   传输契约负责字段在不在、类型对不对；域规则仍由 authority 在解析后执行。
 * INVARIANT: 写操作不声明 idempotency-key —— v1 的并发语义是 `expectedUpdatedAt`
 *   CAS，声明一个没有去重实现的幂等头只会是又一条「声明了但不执行」的契约。
 */

const cmsPagePathFieldSchema = z.string().trim().min(2).max(512);
const cmsPageCanonicalFieldSchema = z.string().trim().min(1).max(512).nullable();
const cmsPageReasonSchema = z.string().trim().min(3).max(2_000);
const cmsPageConfirmationSchema = z.string().trim().min(1).max(512);

export const cmsPageContentStatusSchema = z.enum(["template", "draft", "published"]);
export const cmsPageIndexingStatusSchema = z.enum(["noindex", "index"]);
export const cmsPageTemplateSchema = z.literal("article");

// TextEncoder rather than Buffer: this barrel is bundled into the Admin browser client.
export const cmsPageBodySchema = z
  .record(z.string(), z.unknown())
  .superRefine((body, ctx) => {
    if (new TextEncoder().encode(JSON.stringify(body)).length > 128 * 1_024) {
      ctx.addIssue({ code: "custom", message: "CMS body must not exceed 128 KiB" });
    }
  });

export const cmsPublicationIssueSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    path: z.string(),
  })
  .strict();

export const cmsPageSummarySchema = z
  .object({
    path: cmsPagePathFieldSchema,
    template: z.string().min(1),
    title: z.string(),
    description: z.string(),
    canonical: z.string().nullable(),
    contentStatus: cmsPageContentStatusSchema,
    contentSchemaVersion: z.number().int().nullable(),
    indexingStatus: cmsPageIndexingStatusSchema,
    publishedAt: adminIsoDateTimeSchema.nullable(),
    updatedAt: adminIsoDateTimeSchema,
    editable: z.boolean(),
    publishability: z.enum(["ready", "blocked"]),
    issues: z.array(cmsPublicationIssueSchema).readonly(),
  })
  .strict();

export const cmsPageDetailSchema = cmsPageSummarySchema
  .extend({ body: adminJsonValueSchema })
  .strict();

export const cmsPageListQuerySchema = z
  .object({
    status: cmsPageContentStatusSchema.optional(),
    q: z.string().trim().min(1).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();

export const cmsPageDetailQuerySchema = z
  .object({ path: cmsPagePathFieldSchema })
  .strict();

export const cmsPageListResponseSchema = z
  .object({ items: z.array(cmsPageSummarySchema).readonly() })
  .strict();

export const cmsPageDetailResponseSchema = z
  .object({ page: cmsPageDetailSchema })
  .strict();

export const cmsPageMutationResponseSchema = z
  .object({
    page: cmsPageDetailSchema,
    cacheRevalidated: z.boolean(),
  })
  .strict();

export const cmsPageCreateRequestSchema = z
  .object({
    path: cmsPagePathFieldSchema,
    template: cmsPageTemplateSchema.default("article"),
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(320).default(""),
    canonical: cmsPageCanonicalFieldSchema.optional().default(null),
    indexingStatus: cmsPageIndexingStatusSchema.default("noindex"),
    body: cmsPageBodySchema.default({}),
    reason: cmsPageReasonSchema,
    confirmation: cmsPageConfirmationSchema,
  })
  .strict();

export const cmsPagePatchRequestSchema = z
  .object({
    path: cmsPagePathFieldSchema,
    template: cmsPageTemplateSchema.optional(),
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(320).optional(),
    canonical: cmsPageCanonicalFieldSchema.optional(),
    indexingStatus: cmsPageIndexingStatusSchema.optional(),
    body: cmsPageBodySchema.optional(),
    expectedUpdatedAt: adminIsoDateTimeSchema,
    reason: cmsPageReasonSchema,
    confirmation: cmsPageConfirmationSchema,
  })
  .strict();

export const cmsPagePublicationRequestSchema = z
  .object({
    path: cmsPagePathFieldSchema,
    contentStatus: z.enum(["draft", "published"]),
    expectedUpdatedAt: adminIsoDateTimeSchema,
    reason: cmsPageReasonSchema,
    confirmation: cmsPageConfirmationSchema,
  })
  .strict();

export type CmsPageSummary = z.infer<typeof cmsPageSummarySchema>;
export type CmsPageDetail = z.infer<typeof cmsPageDetailSchema>;
export type CmsPageListResponse = z.infer<typeof cmsPageListResponseSchema>;
export type CmsPageMutationResponse = z.infer<typeof cmsPageMutationResponseSchema>;
