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

export const collaborationActivityKindSchema = z.enum([
  "comment",
  "mention",
  "handoff",
  "assignment",
  "status_change",
  "checklist",
]);

export const collaborationActivityCreateSchema = z.object({
  kind: z.enum(["comment", "handoff", "checklist"]),
  body: z.string().trim().min(1).max(4_000),
  mentionedIds: z.array(adminIdSchema).max(50).default([]),
  parentId: adminIdSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
}).strict();

export const collaborationWatchSchema = z.object({ watching: z.boolean() }).strict();

export const collaborationActivitySchema = z.object({
  id: adminIdSchema,
  targetType: collaborationTargetTypeSchema,
  targetId: adminIdSchema,
  kind: collaborationActivityKindSchema,
  actorId: adminIdSchema,
  body: z.string().nullable(),
  mentionedIds: z.array(adminIdSchema),
  metadata: z.record(z.string(), z.unknown()),
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

export const collaborationActivityListResponseSchema = z.object({
  items: z.array(collaborationActivitySchema).readonly(),
  watching: z.boolean(),
  pageInfo: adminPageInfoSchema,
  asOf: adminIsoDateTimeSchema,
}).strict();

export const collaborationWatchResponseSchema = z.object({ watching: z.boolean(), duplicate: z.boolean() }).strict();

export type SavedViewQueryState = z.infer<typeof savedViewQueryStateSchema>;
export type CollaborationTargetType = z.infer<typeof collaborationTargetTypeSchema>;
export type SavedView = z.infer<typeof savedViewSchema>;
export type CollaborationActivityListResponse = z.infer<typeof collaborationActivityListResponseSchema>;
