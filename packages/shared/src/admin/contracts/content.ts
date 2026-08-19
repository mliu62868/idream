import { z } from "zod";
import { CHARACTER_STYLES, CHARACTER_VISIBILITY, GENDERS } from "../../catalog";
import { adminMediaAssetSchema } from "./assets";
import {
  adminIdSchema,
  adminIsoDateTimeSchema,
  adminJsonValueSchema,
  adminListResponseSchema,
} from "./common";
import { characterProjectCreateResponseSchema } from "./characters-create";

/**
 * SPEC: 内容运营域（角色商品化 / 精选位 / 铺位 / 官方角色 CMS / 模板库 / 标签分类法 /
 *       审核队列 / 制作辅助）的 Admin v2 请求与响应契约。
 * INTENT: 这些端点从 v1 dispatchAdmin 的 `resource === "content"` if 链搬来。v1 里它们的
 *         "契约"是各 handler 自带的局部 zod + 直接回吐 Prisma 行；搬到 v2 的核心工作正是把
 *         响应显式投影成这里的 `.strict()` 形状 —— 多一个字段就是违约。
 */

const reasonSchema = z.string().trim().min(3).max(2_000);
const confirmationSchema = z.string().trim().min(1).max(160);
const shortText = (max: number) => z.string().trim().min(1).max(max);

// ---------------------------------------------------------------------------
// content/characters —— 目录商品化
// ---------------------------------------------------------------------------

export const contentCharacterQuerySchema = z.object({
  search: z.string().trim().min(1).max(200).optional(),
  status: shortText(40).optional(),
  visibility: shortText(40).optional(),
  creatorId: adminIdSchema.max(180).optional(),
  sort: z.enum(["recent", "popular"]).default("recent"),
  cursor: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(60),
}).strict();

const contentCharacterImageSchema = z.object({
  id: adminIdSchema,
  url: z.string().trim().min(1),
  thumbnailUrl: z.string().trim().min(1).nullable(),
}).strict();

const contentCharacterVisualSummarySchema = z.object({
  id: adminIdSchema,
  version: z.number().int(),
  status: shortText(40),
  style: shortText(60),
}).strict();

const contentCharacterStatsSchema = z.object({
  chatsCount: z.number().int(),
  likesCount: z.number().int(),
  viewsCount: z.number().int(),
}).strict();

export const contentCharacterListItemSchema = z.object({
  id: adminIdSchema,
  name: z.string(),
  gender: shortText(40),
  style: shortText(60),
  status: shortText(40),
  visibility: shortText(40),
  creatorId: adminIdSchema.nullable(),
  createdAt: adminIsoDateTimeSchema,
  imageAsset: contentCharacterImageSchema.nullable(),
  visualProfile: contentCharacterVisualSummarySchema.nullable(),
  stats: contentCharacterStatsSchema.nullable(),
}).strict();

export const contentCharacterListResponseSchema = adminListResponseSchema(
  contentCharacterListItemSchema,
);

const contentCharacterTagSchema = z.object({
  id: adminIdSchema,
  slug: shortText(200),
  label: z.string(),
  category: z.string().nullable(),
}).strict();

export const contentCharacterDetailResponseSchema = z.object({
  character: z.object({
    id: adminIdSchema,
    name: z.string(),
    age: z.number().int(),
    description: z.string(),
    gender: shortText(40),
    style: shortText(60),
    status: shortText(40),
    visibility: shortText(40),
    source: shortText(40),
    relationship: z.string().nullable(),
    voiceId: z.string().nullable(),
    imageAssetId: adminIdSchema.nullable(),
    creatorId: adminIdSchema.nullable(),
    appearance: adminJsonValueSchema,
    advancedDetails: adminJsonValueSchema,
    vivid: z.boolean(),
    createdAt: adminIsoDateTimeSchema,
    updatedAt: adminIsoDateTimeSchema,
    creator: z.object({
      id: adminIdSchema,
      email: z.string(),
      displayName: z.string().nullable(),
    }).strict().nullable(),
    stats: contentCharacterStatsSchema.nullable(),
    tags: z.array(contentCharacterTagSchema),
  }).strict(),
  reports: z.array(z.object({
    id: adminIdSchema,
    targetType: shortText(60),
    targetId: adminIdSchema,
    category: shortText(60),
    description: z.string().nullable(),
    status: shortText(40),
    priority: z.number().int(),
    createdAt: adminIsoDateTimeSchema,
  }).strict()),
  recentJobs: z.array(z.object({
    id: adminIdSchema,
    mode: shortText(40),
    status: shortText(40),
    createdAt: adminIsoDateTimeSchema,
  }).strict()),
  chatImageToolEnabled: z.boolean(),
}).strict();

export const contentCharacterVisibilityRequestSchema = z.object({
  visibility: z.enum(CHARACTER_VISIBILITY),
  reason: reasonSchema,
  confirmation: confirmationSchema,
}).strict();

export const contentCharacterStatusRequestSchema = z.object({
  status: z.enum(["approved", "rejected", "removed", "archived"]),
  reason: reasonSchema,
  confirmation: confirmationSchema,
}).strict();

export const contentCharacterModerationResponseSchema = z.object({
  character: z.object({
    id: adminIdSchema,
    visibility: shortText(40),
    status: shortText(40),
  }).strict(),
  replayed: z.boolean(),
}).strict();

// SPEC: 整组替换角色标签，tagIds 必须是 Tag 表里已存在的行。
// INTENT: 只做"把已有词表挂到角色上"，不隐式建标签 —— 造词属于 Taxonomy 的治理动作，
//         从角色页顺手 upsert 出新标签正是分类法失控的起点。
export const contentCharacterTagsRequestSchema = z.object({
  tagIds: z.array(adminIdSchema.max(160)).max(24),
  reason: reasonSchema,
  confirmation: confirmationSchema,
}).strict();

export const contentCharacterTagsResponseSchema = z.object({
  character: z.object({
    id: adminIdSchema,
    tags: z.array(z.string()),
  }).strict(),
  replayed: z.boolean(),
}).strict();

export const contentCharacterChatToolsRequestSchema = z.object({
  imageToolEnabled: z.boolean(),
  reason: reasonSchema,
}).strict();

export const contentCharacterChatToolsResponseSchema = z.object({
  character: z.object({
    id: adminIdSchema,
    imageToolEnabled: z.boolean(),
  }).strict(),
}).strict();

// ---------------------------------------------------------------------------
// content/characters/:id/visual-profiles —— Visual Passport 版本
// ---------------------------------------------------------------------------

export const contentVisualProfileSchema = z.object({
  id: adminIdSchema,
  version: z.number().int(),
  status: shortText(40),
  style: shortText(60),
  identityPrompt: z.string(),
  negativeIdentityPrompt: z.string().nullable(),
  faceTraits: adminJsonValueSchema,
  hairTraits: adminJsonValueSchema,
  bodyTraits: adminJsonValueSchema,
  signatureTraits: adminJsonValueSchema,
  styleTraits: adminJsonValueSchema,
  defaultSeed: z.string().nullable(),
  anchorAssetIds: adminJsonValueSchema,
  qualityScore: z.number().nullable(),
  consistencyScore: z.number().nullable(),
  createdFrom: z.string(),
  createdAt: adminIsoDateTimeSchema,
  identitySource: z.enum(["derived", "manual"]),
  identityStale: z.boolean(),
}).strict();

export const contentVisualProfileListResponseSchema = z.object({
  items: z.array(contentVisualProfileSchema),
}).strict();

export const contentVisualProfileMutationResponseSchema = z.object({
  item: contentVisualProfileSchema,
  replayed: z.boolean(),
}).strict();

// ---------------------------------------------------------------------------
// content/featured —— 精选位
// ---------------------------------------------------------------------------

const contentFeaturedDiagnosticSchema = z.object({
  code: z.enum([
    "setting_not_object",
    "character_ids_not_array",
    "character_id_not_string",
    "character_id_blank",
    "character_id_duplicate",
    "character_id_overflow",
  ]),
  message: z.string(),
  index: z.number().int().optional(),
  id: adminIdSchema.optional(),
}).strict();

const contentFeaturedBlockerSchema = z.object({
  code: shortText(80),
  message: z.string(),
  repairDeepLink: z.string().trim().min(1),
}).strict();

const contentFeaturedItemSchema = z.object({
  id: adminIdSchema,
  name: z.string().nullable(),
  visibility: z.string().nullable(),
  status: z.string().nullable(),
  configuredPosition: z.number().int().nonnegative(),
  configured: z.literal(true),
  effective: z.boolean(),
  blockers: z.array(contentFeaturedBlockerSchema),
}).strict();

export const contentFeaturedResponseSchema = z.object({
  characterIds: z.array(adminIdSchema),
  configuredCharacterIds: z.array(adminIdSchema),
  effectiveCharacterIds: z.array(adminIdSchema),
  settingVersion: z.number().int().nonnegative(),
  settingDiagnostics: z.array(contentFeaturedDiagnosticSchema),
  items: z.array(contentFeaturedItemSchema),
}).strict();

export const contentFeaturedUpdateRequestSchema = z.object({
  characterIds: z.array(adminIdSchema.max(160)).max(24),
  expectedVersion: z.number().int().nonnegative(),
  reason: reasonSchema,
  confirmation: confirmationSchema,
}).strict();

export const contentFeaturedUpdateResponseSchema = z.object({
  characterIds: z.array(adminIdSchema),
  configuredCharacterIds: z.array(adminIdSchema),
  effectiveCharacterIds: z.array(adminIdSchema),
  settingVersion: z.number().int().nonnegative(),
  settingDiagnostics: z.array(contentFeaturedDiagnosticSchema),
  skipped: z.array(adminIdSchema),
  invalid: z.array(z.object({
    id: adminIdSchema,
    reason: z.literal("character_not_found_or_not_configurable"),
  }).strict()),
  replayed: z.boolean(),
}).strict();

// ---------------------------------------------------------------------------
// content/production —— 生产辅助（方向草案 + 成本预估）
// ---------------------------------------------------------------------------

export const contentProductionDirectionsRequestSchema = z.object({
  characterId: adminIdSchema.max(180),
  purpose: z.enum([
    "character_cover",
    "character_hero",
    "character_chat",
    "feed",
    "homepage",
    "seo",
    "template_cover",
    "campaign",
    "model_eval",
  ]),
  creativeBrief: z.string().trim().max(240).default(""),
  scenePrompt: z.string().trim().max(1_200).default(""),
  mood: z.string().trim().max(120).default(""),
  setting: z.string().trim().max(120).default(""),
  outfit: z.string().trim().max(120).default(""),
  camera: z.string().trim().max(120).default(""),
  lighting: z.string().trim().max(120).default(""),
  consistencyMode: z.enum(["strict", "balanced", "creative"]).default("balanced"),
}).strict();

const adminTextRuntimeIdentitySchema = z.object({
  provider: z.enum(["mock", "pipeline"]),
  pipelineUrl: z.string().nullable(),
  model: z.string().nullable(),
  sourceRevision: z.string().trim().min(1).optional(),
}).strict();

export const contentProductionDirectionsResponseSchema = z.object({
  directions: z.array(z.object({
    title: z.string().trim().min(2).max(80),
    scenePrompt: z.string().trim().min(12).max(1_200),
    mood: shortText(120),
    setting: shortText(120),
    outfit: shortText(120),
    camera: shortText(120),
    lighting: shortText(120),
  }).strict()).length(4),
  source: z.literal("model"),
  runtime: adminTextRuntimeIdentitySchema,
}).strict();

export const contentProductionEstimateRequestSchema = z.object({
  profileId: adminIdSchema.max(180),
  count: z.number().int().min(1).max(40).default(4),
}).strict();

export const contentProductionEstimateResponseSchema = z.object({
  perItemCostDreamcoins: z.number().int().nonnegative(),
  totalCostDreamcoins: z.number().int().nonnegative(),
}).strict();

// ---------------------------------------------------------------------------
// content/placements —— legacy 铺位草稿编辑器
// ---------------------------------------------------------------------------

export const contentPlacementSlotSchema = z.enum([
  "character_avatar",
  "character_hero",
  "character_chat",
  "feed_card",
  "homepage_strip",
  "seo_article",
  "template_cover",
  "campaign",
]);

export const contentPlacementQuerySchema = z.object({
  status: shortText(40).optional(),
  slot: contentPlacementSlotSchema.optional(),
  targetId: adminIdSchema.max(180).optional(),
  search: z.string().trim().min(1).max(200).optional(),
  cursor: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
}).strict();

export const contentPlacementSchema = z.object({
  id: adminIdSchema,
  mediaAssetId: adminIdSchema,
  slot: shortText(60),
  targetType: shortText(60),
  targetId: adminIdSchema,
  status: shortText(40),
  version: z.number().int(),
  verificationState: shortText(40),
  managedRunId: adminIdSchema.nullable(),
  scheduledAt: adminIsoDateTimeSchema.nullable(),
  publishedAt: adminIsoDateTimeSchema.nullable(),
  pausedAt: adminIsoDateTimeSchema.nullable(),
  archivedAt: adminIsoDateTimeSchema.nullable(),
  createdById: adminIdSchema,
  createdByEmail: z.string(),
  metadata: adminJsonValueSchema,
  createdAt: adminIsoDateTimeSchema,
  updatedAt: adminIsoDateTimeSchema,
  asset: adminMediaAssetSchema.strict(),
}).strict();

export const contentPlacementListResponseSchema = adminListResponseSchema(
  contentPlacementSchema,
);

export const contentPlacementDetailResponseSchema = z.object({
  placement: contentPlacementSchema,
}).strict();

export const contentPlacementCreateRequestSchema = z.object({
  mediaAssetId: adminIdSchema.max(180),
  slot: contentPlacementSlotSchema,
  targetType: z.enum(["character", "route_page", "campaign", "template"]),
  targetId: adminIdSchema.max(180),
  status: z.literal("draft").default("draft"),
  metadata: z.record(z.string(), z.unknown()).default({}),
  reason: reasonSchema,
}).strict();

export const contentPlacementPatchRequestSchema = z.object({
  status: z.enum(["paused", "archived"]),
  metadata: z.record(z.string(), z.unknown()).optional(),
  reason: reasonSchema,
  confirmation: confirmationSchema,
}).strict();

export const contentPlacementMutationResponseSchema = z.object({
  placement: contentPlacementSchema,
  replayed: z.boolean(),
}).strict();

// ---------------------------------------------------------------------------
// content/official —— 官方角色 CMS（v2 Character Project / Release 的 legacy 适配面）
// ---------------------------------------------------------------------------

const officialRecordSchema = z.record(z.string(), z.unknown());

export const contentOfficialQuerySchema = z.object({
  search: z.string().trim().min(1).max(200).optional(),
  status: shortText(40).optional(),
  gender: shortText(40).optional(),
  style: shortText(60).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(24),
}).strict();

const contentOfficialCharacterSchema = z.object({
  id: adminIdSchema,
  name: z.string(),
  age: z.number().int(),
  description: z.string(),
  gender: shortText(40),
  style: shortText(60),
  status: shortText(40),
  visibility: shortText(40),
  appearance: adminJsonValueSchema,
  advancedDetails: adminJsonValueSchema,
  imageAssetId: adminIdSchema.nullable(),
  createdAt: adminIsoDateTimeSchema,
  updatedAt: adminIsoDateTimeSchema,
  tags: z.array(z.string()),
  stats: contentCharacterStatsSchema.nullable(),
  visualProfile: z.object({
    id: adminIdSchema,
    version: z.number().int(),
    status: shortText(40),
    style: shortText(60),
    qualityScore: z.number().nullable(),
    consistencyScore: z.number().nullable(),
    faceTraits: adminJsonValueSchema,
  }).strict().nullable(),
}).strict();

export const contentOfficialListResponseSchema = z.object({
  items: z.array(contentOfficialCharacterSchema),
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  totalPages: z.number().int().positive(),
}).strict();

export const contentOfficialCreateRequestSchema = z.object({
  name: z.string().trim().min(1).max(80),
  age: z.number().int().min(18).max(99),
  gender: z.enum(GENDERS),
  style: z.enum(CHARACTER_STYLES),
  description: z.string().trim().min(1).max(1500),
  appearance: officialRecordSchema.default({}),
  advancedDetails: officialRecordSchema.default({}),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
  reason: reasonSchema,
}).strict();

export const contentOfficialCreateResponseSchema = z.object({
  character: contentOfficialCharacterSchema,
  project: characterProjectCreateResponseSchema,
}).strict();

export const contentOfficialUpdateRequestSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  age: z.number().int().min(18).max(99).optional(),
  gender: z.enum(GENDERS).optional(),
  style: z.enum(CHARACTER_STYLES).optional(),
  description: z.string().trim().min(1).max(1500).optional(),
  appearance: officialRecordSchema.optional(),
  advancedDetails: officialRecordSchema.optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
  reason: reasonSchema,
}).strict();

export const contentOfficialUpdateResponseSchema = z.object({
  character: contentOfficialCharacterSchema,
  projectId: adminIdSchema,
  projectVersion: z.number().int().positive(),
  deepLink: z.string().trim().min(1),
}).strict();

export const contentOfficialStateRequestSchema = z.object({
  status: z.enum(["approved", "archived"]),
  reason: reasonSchema,
}).strict();

export const contentOfficialStateResponseSchema = z.object({
  character: z.object({
    id: adminIdSchema,
    status: shortText(40),
    visibility: shortText(40),
  }).strict(),
  commandId: adminIdSchema,
}).strict();

// ---------------------------------------------------------------------------
// content/templates —— 角色创建模板库（Starters）
// ---------------------------------------------------------------------------

export const contentTemplateQuerySchema = z.object({
  search: z.string().trim().min(1).max(200).optional(),
  scope: z.enum(["built_in", "community"]).optional(),
  status: z.enum(["active", "disabled"]).optional(),
  cursor: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
}).strict();

export const contentTemplateSchema = z.object({
  id: adminIdSchema,
  scope: shortText(40),
  name: z.string(),
  summary: z.string().nullable(),
  gender: z.string().nullable(),
  style: z.string().nullable(),
  appearance: adminJsonValueSchema,
  advancedDetails: adminJsonValueSchema,
  tags: adminJsonValueSchema,
  coverAssetId: adminIdSchema.nullable(),
  isActive: z.boolean(),
  sortOrder: z.number().int(),
  createdById: adminIdSchema.nullable(),
  createdAt: adminIsoDateTimeSchema,
  updatedAt: adminIsoDateTimeSchema,
}).strict();

export const contentTemplateListResponseSchema = adminListResponseSchema(
  contentTemplateSchema,
);

export const contentTemplateDetailResponseSchema = z.object({
  template: contentTemplateSchema,
}).strict();

export const contentTemplateCreateRequestSchema = z.object({
  name: z.string().trim().min(1).max(80),
  summary: z.string().trim().max(200).optional(),
  gender: z.string().trim().max(40).optional(),
  style: z.string().trim().max(60).optional(),
  appearance: officialRecordSchema.default({}),
  advancedDetails: officialRecordSchema.default({}),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
  coverAssetId: z.string().trim().max(160).optional(),
  sortOrder: z.number().int().default(0),
  scope: z.enum(["built_in", "community"]).default("built_in"),
  reason: reasonSchema,
}).strict();

export const contentTemplateUpdateRequestSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  summary: z.string().trim().max(200).optional(),
  gender: z.string().trim().max(40).optional(),
  style: z.string().trim().max(60).optional(),
  appearance: officialRecordSchema.optional(),
  advancedDetails: officialRecordSchema.optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
  coverAssetId: z.string().trim().max(160).nullable().optional(),
  sortOrder: z.number().int().optional(),
  scope: z.enum(["built_in", "community"]).optional(),
  reason: reasonSchema,
}).strict();

export const contentTemplateActiveRequestSchema = z.object({
  active: z.boolean(),
  reason: reasonSchema,
  confirmation: confirmationSchema,
}).strict();

// ---------------------------------------------------------------------------
// content/tags —— 标签分类法治理
// ---------------------------------------------------------------------------

export const contentTagQuerySchema = z.object({
  search: z.string().trim().min(1).max(200).optional(),
  category: shortText(40).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
}).strict();

export const contentTagSchema = z.object({
  id: adminIdSchema,
  slug: z.string(),
  label: z.string(),
  category: z.string().nullable(),
  isSensitive: z.boolean(),
  isMutedByDefault: z.boolean(),
}).strict();

export const contentTagListResponseSchema = z.object({
  items: z.array(contentTagSchema.extend({
    characterCount: z.number().int().nonnegative(),
  }).strict()),
}).strict();

// SPEC: 至少一个可变字段 + reason；category 可为 null（清除分类）。
export const contentTagPatchRequestSchema = z.object({
  label: z.string().trim().min(1).max(80).optional(),
  category: z.string().trim().max(40).nullable().optional(),
  isSensitive: z.boolean().optional(),
  isMutedByDefault: z.boolean().optional(),
  reason: reasonSchema,
  confirmation: confirmationSchema,
}).strict().refine(
  (body) =>
    body.label !== undefined ||
    body.category !== undefined ||
    body.isSensitive !== undefined ||
    body.isMutedByDefault !== undefined,
  { message: "At least one tag field must be provided" },
);

export const contentTagPatchResponseSchema = z.object({
  tag: contentTagSchema,
}).strict();

export const contentTagMergeRequestSchema = z.object({
  sourceId: adminIdSchema.max(160),
  targetId: adminIdSchema.max(160),
  reason: reasonSchema,
  confirmation: confirmationSchema,
}).strict();

export const contentTagMergeResponseSchema = z.object({
  merged: z.literal(true),
  movedCount: z.number().int().nonnegative(),
}).strict();

// ---------------------------------------------------------------------------
// content/review-queue —— 用户角色公开审核
// ---------------------------------------------------------------------------

export const contentReviewQueueQuerySchema = z.object({
  search: z.string().trim().min(1).max(200).optional(),
  reportFilter: z.enum(["all", "reported", "clean"]).default("all"),
  cursor: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
}).strict();

export const contentReviewQueueItemSchema = z.object({
  submissionId: adminIdSchema,
  submittedAt: adminIsoDateTimeSchema,
  character: z.object({
    id: adminIdSchema,
    name: z.string(),
    gender: shortText(40),
    style: shortText(60),
    visibility: shortText(40),
    status: shortText(40),
    description: z.string(),
    imageAssetId: adminIdSchema.nullable(),
    source: shortText(40),
    createdAt: adminIsoDateTimeSchema,
  }).strict(),
  reportCount: z.number().int().nonnegative(),
}).strict();

export const contentReviewQueueListResponseSchema = adminListResponseSchema(
  contentReviewQueueItemSchema,
);

export const contentReviewDecisionRequestSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  reviewReason: z.string().trim().max(2_000).optional(),
  reason: reasonSchema,
  confirmation: confirmationSchema,
}).strict();

export const contentReviewDecisionResponseSchema = z.object({
  submission: z.object({
    id: adminIdSchema,
    characterId: adminIdSchema,
    status: shortText(40),
    reviewReason: z.string().nullable(),
    reviewerId: adminIdSchema.nullable(),
    submittedAt: adminIsoDateTimeSchema,
    reviewedAt: adminIsoDateTimeSchema.nullable(),
  }).strict(),
  publication: z.object({
    state: z.literal("publication_prep"),
    characterId: adminIdSchema,
    submissionId: adminIdSchema,
    projectId: adminIdSchema,
    revisionId: adminIdSchema,
    projectVersion: z.number().int(),
    servingState: shortText(40),
    deepLink: z.string().trim().min(1),
    created: z.boolean(),
  }).strict().nullable(),
  replayed: z.boolean(),
}).strict();

// ---------------------------------------------------------------------------
// content/character-assist —— 一句话 seed → 角色创作底稿（只产出建议，不落库）
// ---------------------------------------------------------------------------

export const contentCharacterAssistRequestSchema = z.object({
  seed: z.string().trim().min(3).max(400),
  gender: z.enum(GENDERS).optional(),
  style: z.enum(CHARACTER_STYLES).optional(),
}).strict();

export const contentCharacterAssistResponseSchema = z.object({
  description: z.string(),
  nameIdeas: z.array(z.string()),
  advancedDetails: z.object({
    personality: z.string(),
    speakingStyle: z.string(),
    firstMessage: z.string(),
    visualBrief: z.string(),
  }).strict(),
  runtime: adminTextRuntimeIdentitySchema,
}).strict();

export type ContentCharacterQuery = z.infer<typeof contentCharacterQuerySchema>;
export type ContentCharacterListItem = z.infer<typeof contentCharacterListItemSchema>;
export type ContentCharacterVisibilityRequest = z.infer<
  typeof contentCharacterVisibilityRequestSchema
>;
export type ContentCharacterStatusRequest = z.infer<typeof contentCharacterStatusRequestSchema>;
export type ContentCharacterTagsRequest = z.infer<typeof contentCharacterTagsRequestSchema>;
export type ContentCharacterChatToolsRequest = z.infer<
  typeof contentCharacterChatToolsRequestSchema
>;
export type ContentVisualProfile = z.infer<typeof contentVisualProfileSchema>;
export type ContentFeaturedUpdateRequest = z.infer<typeof contentFeaturedUpdateRequestSchema>;
export type ContentProductionDirectionsRequest = z.infer<
  typeof contentProductionDirectionsRequestSchema
>;
export type ContentProductionEstimateRequest = z.infer<
  typeof contentProductionEstimateRequestSchema
>;
export type ContentPlacementQuery = z.infer<typeof contentPlacementQuerySchema>;
export type ContentPlacementCreateRequest = z.infer<typeof contentPlacementCreateRequestSchema>;
export type ContentPlacementPatchRequest = z.infer<typeof contentPlacementPatchRequestSchema>;
export type ContentOfficialQuery = z.infer<typeof contentOfficialQuerySchema>;
export type ContentOfficialCreateRequest = z.infer<typeof contentOfficialCreateRequestSchema>;
export type ContentOfficialUpdateRequest = z.infer<typeof contentOfficialUpdateRequestSchema>;
export type ContentOfficialStateRequest = z.infer<typeof contentOfficialStateRequestSchema>;
export type ContentTemplateQuery = z.infer<typeof contentTemplateQuerySchema>;
export type ContentTemplate = z.infer<typeof contentTemplateSchema>;
export type ContentTemplateCreateRequest = z.infer<typeof contentTemplateCreateRequestSchema>;
export type ContentTemplateUpdateRequest = z.infer<typeof contentTemplateUpdateRequestSchema>;
export type ContentTemplateActiveRequest = z.infer<typeof contentTemplateActiveRequestSchema>;
export type ContentTagQuery = z.infer<typeof contentTagQuerySchema>;
export type ContentTagPatchRequest = z.infer<typeof contentTagPatchRequestSchema>;
export type ContentTagMergeRequest = z.infer<typeof contentTagMergeRequestSchema>;
export type ContentReviewQueueQuery = z.infer<typeof contentReviewQueueQuerySchema>;
export type ContentReviewDecisionRequest = z.infer<typeof contentReviewDecisionRequestSchema>;
export type ContentCharacterAssistRequest = z.infer<typeof contentCharacterAssistRequestSchema>;
