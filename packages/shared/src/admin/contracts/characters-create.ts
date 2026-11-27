// SPEC: Character project creation — draft authoring, instructional-sentinel rejection,
// production-ready gate, create request/response.

import { z } from "zod";
import {
  adminCommandReasonSchema,
  adminIdSchema,
  adminIsoDateTimeSchema,
} from "./common";
import { characterServingStateSchema } from "./characters-common";
import { characterTagIdsSchema } from "./content";

export const characterDraftPersonaSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    age: z.number().int().min(18).max(120),
    gender: z.enum(["female", "male", "trans"]),
    characterPromise: z.string().trim().min(1).max(1_000),
    detailsMarkdown: z.string().trim().max(24_000),
    firstMessage: z.string().trim().min(1).max(4_000),
  })
  .strict();

export const characterDraftVisualDirectionSchema = z
  .object({
    identityAnchor: z.string().trim().min(1).max(2_000),
    stableTraits: z.array(z.string().trim().min(1).max(500)).min(1).max(24),
    style: z.enum(["realistic", "anime", "hybrid", "other"]),
    referenceDirection: z.string().trim().min(1).max(4_000),
  })
  .strict();

// SPEC: 创建草稿只包含角色本身：Soul 与视觉方向。
// INTENT: 负责人、排期、市场简报和 QA 计划不参与角色成立或发布，继续放在契约里只会制造空字段。
const characterProjectDraftObjectSchema = z
  .object({
    persona: characterDraftPersonaSchema,
    visualDirection: characterDraftVisualDirectionSchema,
  })
  .strict();

export const characterProjectDraftSchema = characterProjectDraftObjectSchema;

export const characterCreateInstructionalSentinels = [
  [["persona", "name"], "Untitled companion"],
  [
    ["persona", "characterPromise"],
    "A specific, dependable companionship promise",
  ],
  [["persona", "firstMessage"], "I'm here. Where should we begin?"],
  [
    ["visualDirection", "identityAnchor"],
    "A recognizable adult companion identity",
  ],
  [
    ["visualDirection", "referenceDirection"],
    "Describe lighting, framing, wardrobe, and reference direction.",
  ],
] as const;

function valueAtPath(value: Record<string, unknown>, path: readonly string[]) {
  let current: unknown = value;
  for (const segment of path) {
    if (
      current === null ||
      typeof current !== "object" ||
      Array.isArray(current)
    )
      return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

const rejectCharacterCreateInstructionalSentinels: Parameters<
  typeof characterProjectDraftObjectSchema.superRefine
>[0] = (value, ctx) => {
  for (const [path, sentinel] of characterCreateInstructionalSentinels) {
    if (
      valueAtPath(value as unknown as Record<string, unknown>, path) ===
      sentinel
    ) {
      ctx.addIssue({
        code: "custom",
        path: [...path],
        message:
          "Replace the former instructional default with real Character data",
      });
    }
  }
  const listSentinels = [
    ["visualDirection", "stableTraits", "consistent face"],
    ["visualDirection", "stableTraits", "recognizable silhouette"],
  ] as const;
  for (const [section, field, sentinel] of listSentinels) {
    const values = valueAtPath(value as unknown as Record<string, unknown>, [
      section,
      field,
    ]);
    if (Array.isArray(values) && values.some((item) => item === sentinel)) {
      ctx.addIssue({
        code: "custom",
        path: [section, field],
        message:
          "Replace the former instructional default with real Character data",
      });
    }
  }
};

export const characterProjectProductionReadyDraftSchema =
  characterProjectDraftObjectSchema.superRefine(
    rejectCharacterCreateInstructionalSentinels,
  );

// SPEC: 视觉方向的默认值只有这一份：向导、批量导入与复制共用。
// INVARIANT: 外貌只从已有视觉信息补齐——「一句话外貌」退到第一条固定特征，绝不用剧情简介；
//            固定特征没有默认值，缺了就是缺了，由草稿校验如实报告。
export const CHARACTER_DEFAULT_REFERENCE_DIRECTION =
  "Soft natural light, head-and-shoulders portrait, clean uncluttered background";

export function withCharacterVisualDirectionDefaults<
  Draft extends {
    readonly visualDirection: {
      readonly identityAnchor: string;
      readonly stableTraits: readonly string[];
      readonly referenceDirection: string;
    };
  },
>(draft: Draft): Draft {
  const { visualDirection } = draft;
  const identityAnchor = visualDirection.identityAnchor.trim()
    ? visualDirection.identityAnchor
    : visualDirection.stableTraits.find((trait) => trait.trim())?.trim() ?? "";
  const referenceDirection = visualDirection.referenceDirection.trim()
    ? visualDirection.referenceDirection
    : CHARACTER_DEFAULT_REFERENCE_DIRECTION;
  if (
    identityAnchor === visualDirection.identityAnchor &&
    referenceDirection === visualDirection.referenceDirection
  )
    return draft;
  return {
    ...draft,
    visualDirection: { ...visualDirection, identityAnchor, referenceDirection },
  };
}

export const characterProjectCreateRequestSchema =
  characterProjectDraftObjectSchema
    .extend({
      // SPEC: 创建时一并挂载的标签，与 PUT /content/characters/:id/tags 同一份上限，随创建原子写入。
      // INVARIANT: 不带标签的请求与旧请求逐字节相同，requestHash 不变。
      tagIds: characterTagIdsSchema.optional(),
      reason: adminCommandReasonSchema,
      confirmation: z.literal("CREATE CHARACTER"),
    })
    .strict()
    .superRefine(rejectCharacterCreateInstructionalSentinels);

export const characterProjectCreateResponseSchema = z
  .object({
    characterId: adminIdSchema,
    characterContentVersionId: adminIdSchema,
    projectId: adminIdSchema,
    revisionId: adminIdSchema,
    projectVersion: z.number().int().positive(),
    contentVersion: z.number().int().positive(),
    deepLink: z.string().startsWith("/admin/characters/"),
    replayed: z.boolean(),
  })
  .strict();

// SPEC: 复制为独立私有草稿，请求没有可变内容，全部来自源角色。
export const characterProjectDuplicateRequestSchema = z.object({}).strict();

export const characterProjectDuplicateResponseSchema = characterProjectCreateResponseSchema
  .extend({
    sourceCharacterId: adminIdSchema,
    copiedImageCount: z.number().int().nonnegative(),
    skippedImageCount: z.number().int().nonnegative(),
    identityCopied: z.boolean(),
  })
  .strict();

export const customerCharacterPublicationPrepRequestSchema = z
  .object({
    submissionId: adminIdSchema,
    confirmation: z.string().trim().min(1).max(240),
  })
  .strict();

export const customerCharacterPublicationPrepResponseSchema = z
  .object({
    state: z.literal("publication_prep"),
    characterId: adminIdSchema,
    submissionId: adminIdSchema,
    projectId: adminIdSchema,
    revisionId: adminIdSchema,
    projectVersion: z.number().int().positive(),
    servingState: characterServingStateSchema,
    deepLink: z.string().startsWith("/admin/characters/"),
    created: z.boolean(),
    replayed: z.boolean(),
  })
  .strict();

export const characterProjectDraftAuthoritySchema = z
  .object({
    characterId: adminIdSchema,
    projectId: adminIdSchema,
    projectVersion: z.number().int().positive(),
    deepLink: z.string().startsWith("/admin/characters/"),
  })
  .strict();

export const characterProjectDraftResumeSchema = z
  .object({
    authority: characterProjectDraftAuthoritySchema,
    draft: characterProjectDraftSchema,
  })
  .strict();

export const characterProjectDraftPatchRequestSchema = z
  .object({
    entityVersion: z.number().int().nonnegative(),
    content: z
      .object({
        persona: characterDraftPersonaSchema,
        visualDirection: characterDraftVisualDirectionSchema,
      })
      .strict(),
    reason: z.string().trim().min(3).max(2_000),
  })
  .strict();

// SPEC: one save of the Character's persona and, when edited, its visual direction.
// INTENT: saving a draft is routine and reversible (every content version is kept and
// nothing reaches customers until a Release), so it carries no reason.
// INVARIANT: visualDirection absent = keep the current appearance bytes unchanged; legacy
// characters without a visual direction can still save persona edits.
export const characterSoulVersionCreateRequestSchema = z
  .object({
    entityVersion: z.number().int().positive(),
    expectedContentVersionId: adminIdSchema,
    persona: characterDraftPersonaSchema,
    visualDirection: characterDraftVisualDirectionSchema.optional(),
  })
  .strict();

export const characterSoulVersionCreateResponseSchema = z
  .object({
    characterId: adminIdSchema,
    projectId: adminIdSchema,
    projectVersion: z.number().int().positive(),
    contentVersionId: adminIdSchema,
    contentVersion: z.number().int().positive(),
    revisionId: adminIdSchema,
    revision: z.number().int().positive(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    replayed: z.boolean(),
  })
  .strict();

export type CharacterDraftPersona = z.infer<typeof characterDraftPersonaSchema>;

export type CharacterDraftVisualDirection = z.infer<
  typeof characterDraftVisualDirectionSchema
>;

export type CharacterProjectCreateRequest = z.infer<
  typeof characterProjectCreateRequestSchema
>;

export type CharacterProjectCreateResponse = z.infer<
  typeof characterProjectCreateResponseSchema
>;

export type CharacterProjectDuplicateResponse = z.infer<
  typeof characterProjectDuplicateResponseSchema
>;

export type CustomerCharacterPublicationPrepRequest = z.infer<
  typeof customerCharacterPublicationPrepRequestSchema
>;

export type CustomerCharacterPublicationPrepResponse = z.infer<
  typeof customerCharacterPublicationPrepResponseSchema
>;

export type CharacterProjectDraft = z.infer<typeof characterProjectDraftSchema>;

export type CharacterProjectDraftAuthority = z.infer<
  typeof characterProjectDraftAuthoritySchema
>;

export type CharacterProjectDraftResume = z.infer<
  typeof characterProjectDraftResumeSchema
>;

export type CharacterProjectDraftPatchRequest = z.infer<
  typeof characterProjectDraftPatchRequestSchema
>;

export type CharacterSoulVersionCreateRequest = z.infer<
  typeof characterSoulVersionCreateRequestSchema
>;

export type CharacterSoulVersionCreateResponse = z.infer<
  typeof characterSoulVersionCreateResponseSchema
>;
