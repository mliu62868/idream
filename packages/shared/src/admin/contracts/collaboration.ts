import { z } from "zod";
import { adminCursorQuerySchema, adminIdSchema, adminIsoDateTimeSchema, adminPageInfoSchema } from "./common";

export const collaborationTargetTypeSchema = z.enum([
  "character_project",
  "creative_run",
  "case",
  "incident",
]);

export const savedViewQueryStateSchema = z.object({
  search: z.string().trim().max(200).default(""),
  filters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()])),
  sort: z.object({
    field: z.string().trim().min(1).max(64),
    direction: z.enum(["asc", "desc"]),
  }).strict(),
  pageSize: z.number().int().min(1).max(200).default(50),
}).strict();

export const savedViewCreateSchema = z.object({
  scope: collaborationTargetTypeSchema,
  label: z.string().trim().min(1).max(80),
  queryState: savedViewQueryStateSchema,
}).strict();

export const savedViewUpdateSchema = z.object({
  expectedVersion: z.number().int().positive(),
  label: z.string().trim().min(1).max(80).optional(),
  queryState: savedViewQueryStateSchema.optional(),
}).strict();

export const savedViewListQuerySchema = z.object({
  scope: collaborationTargetTypeSchema,
}).strict();

export const savedViewDeleteSchema = z.object({ deleted: z.literal(true) }).strict();

export const collaborationActivityKindSchema = z.enum([
  "comment",
  "mention",
  "handoff",
  "assignment",
  "status_change",
  "checklist",
  "draft_saved",
  "evidence_attached",
]);

export const collaborationAttachmentSchema = z.object({
  id: adminIdSchema,
  label: z.string().trim().min(1).max(160),
  mimeType: z.string().trim().min(1).max(120).optional(),
}).strict();

export const collaborationChecklistItemSchema = z.object({
  id: adminIdSchema,
  label: z.string().trim().min(1).max(240),
  completed: z.boolean(),
  ownerId: adminIdSchema.optional(),
}).strict();

export const collaborationActivityMetadataSchema = z.object({
  attachments: z.array(collaborationAttachmentSchema).max(20).default([]),
  handoffToActorId: adminIdSchema.optional(),
  checklistItems: z.array(collaborationChecklistItemSchema).max(100).default([]),
}).strict();

export const collaborationActivityCreateSchema = z.object({
  kind: z.enum(["comment", "handoff", "checklist"]),
  expectedVersion: z.number().int().positive().optional(),
  body: z.string().trim().min(1).max(4_000),
  mentionedIds: z.array(adminIdSchema).max(50).default([]),
  parentId: adminIdSchema.optional(),
  metadata: collaborationActivityMetadataSchema.default({ attachments: [], checklistItems: [] }),
}).strict().superRefine((input, context) => {
  if (input.kind === "handoff" && !input.metadata.handoffToActorId) {
    context.addIssue({ code: "custom", path: ["metadata", "handoffToActorId"], message: "Handoffs require a target actor" });
  }
  if (input.kind === "handoff" && input.expectedVersion === undefined) {
    context.addIssue({ code: "custom", path: ["expectedVersion"], message: "Handoffs require the current entity version" });
  }
  if (input.kind === "checklist" && input.metadata.checklistItems.length === 0) {
    context.addIssue({ code: "custom", path: ["metadata", "checklistItems"], message: "Checklist updates require at least one item" });
  }
});

export const collaborationWatchSchema = z.object({ watching: z.boolean() }).strict();

export const collaborationActivitySchema = z.object({
  id: adminIdSchema,
  targetType: collaborationTargetTypeSchema,
  targetId: adminIdSchema,
  kind: collaborationActivityKindSchema,
  actorId: adminIdSchema,
  body: z.string().nullable(),
  mentionedIds: z.array(adminIdSchema),
  metadata: collaborationActivityMetadataSchema,
  parentId: adminIdSchema.nullable(),
  createdAt: adminIsoDateTimeSchema,
}).strict();

export const collaborationQuerySchema = adminCursorQuerySchema.pick({ cursor: true, limit: true });

export const savedViewSchema = z.object({
  id: adminIdSchema,
  scope: collaborationTargetTypeSchema,
  label: z.string().trim().min(1).max(80),
  queryState: savedViewQueryStateSchema,
  version: z.number().int().positive(),
  createdAt: adminIsoDateTimeSchema,
  updatedAt: adminIsoDateTimeSchema,
}).strict();

export const savedViewListResponseSchema = z.object({ items: z.array(savedViewSchema).readonly() }).strict();
export const savedViewMutationResponseSchema = z.object({ view: savedViewSchema, duplicate: z.boolean() }).strict();
export const savedViewUpdateResponseSchema = z.object({ view: savedViewSchema }).strict();

// SPEC: 活动列表随附本页出现过的操作者名录（id → 显示名）。
// INTENT: 时间线和关注者列表原先只有 actorId，运营看到的是 `seed-admin-user` 这种原始 ID，
// 认不出是谁。名录随列表一次返回，避免前端按人 N+1 查询；查不到名字的仍回落到 ID。
export const collaborationActorSchema = z.object({
  id: adminIdSchema,
  displayName: z.string().trim().min(1),
}).strict();

export const collaborationActivityListResponseSchema = z.object({
  items: z.array(collaborationActivitySchema).readonly(),
  actors: z.array(collaborationActorSchema).readonly(),
  watching: z.boolean(),
  watcherIds: z.array(adminIdSchema).readonly(),
  pageInfo: adminPageInfoSchema,
  asOf: adminIsoDateTimeSchema,
}).strict();

// SPEC: 提及信箱的响应 —— 跨所有目标、点名到本人的活动。
// INTENT: manifest 原先把它指向 collaborationActivityListResponseSchema，而那个契约带
// watching / watcherIds / actors —— 三个都是「某一个目标」的事实。跨目标的信箱没有那个目标可以
// 回答，所以 handler 从来没发这几个字段，也从来没有人发现：声明的契约从未在出参上执行过。
// 与其编一个恒为 false 的 watching 去凑形状，不如把它真正提供的形状声明出来。
export const collaborationMentionListResponseSchema = z.object({
  items: z.array(collaborationActivitySchema).readonly(),
  pageInfo: adminPageInfoSchema,
}).strict();

export const collaborationWatchResponseSchema = z.object({ watching: z.boolean(), duplicate: z.boolean() }).strict();
export const collaborationAuthoritySchema = z.object({
  ownerId: adminIdSchema.nullable(),
  version: z.number().int().positive(),
}).strict();
export const collaborationActivityMutationSchema = z.object({
  activity: collaborationActivitySchema,
  authority: collaborationAuthoritySchema.nullable(),
  duplicate: z.boolean(),
}).strict();

export type SavedViewQueryState = z.infer<typeof savedViewQueryStateSchema>;
export type CollaborationTargetType = z.infer<typeof collaborationTargetTypeSchema>;
export type SavedView = z.infer<typeof savedViewSchema>;
export type CollaborationActivityListResponse = z.infer<typeof collaborationActivityListResponseSchema>;
export type CollaborationActivityMutation = z.infer<typeof collaborationActivityMutationSchema>;
