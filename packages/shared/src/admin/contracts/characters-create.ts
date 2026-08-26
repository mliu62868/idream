// SPEC: Character project creation — draft authoring, instructional-sentinel rejection,
// production-ready gate, create request/response.

import { z } from "zod";
import {
  adminCommandReasonSchema,
  adminIdSchema,
  adminIsoDateTimeSchema,
} from "./common";
import {
  characterProjectPhaseSchema,
  characterServingStateSchema,
} from "./characters-common";

export const characterDraftPersonaSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    age: z.number().int().min(18).max(120),
    gender: z.enum(["female", "male", "trans"]),
    relationshipArchetype: z.string().trim().min(1).max(500),
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

/**
 * SPEC: 上线简报（positioning + commercialIntent 的 successCriteria/productionPackage/qaPlan）
 * 是可空的，创建一个角色不需要它们。
 *
 * INTENT: 这七项此前是创建必填，于是「新建角色」的第一步是写四段市场简报，名字排在第二步——
 * 运营要先交论文才能拿到一个角色。而它们在 18 道发布闸里一道都不被检查，落库列本来也可空
 * (CharacterProject.hypothesis/differentiation 是 String?)，且角色页的「编辑详情」里早就有一份
 * 一模一样的编辑器。也就是说这堵墙既不保护发布，也不是唯一入口，只是把表单挪到了最早的位置。
 * 现在它们在创建后按需填写；真正定义「一个角色之所以是角色」的仍然必填：name /
 * relationshipArchetype / characterPromise / firstMessage / identityAnchor / stableTraits /
 * referenceDirection。其余人格内容只有一个可选 detailsMarkdown 字段。
 *
 * INVARIANT: 只放宽下限，max 长度与下面的 instructional sentinel 拒绝原样保留——sentinel 比的是
 * 精确相等，空串永远不等于任何 sentinel，所以「不许把提示文案当数据存进去」这条继续成立。
 */
const characterProjectDraftObjectSchema = z
  .object({
    positioning: z
      .object({
        audience: z.string().trim().max(2_000),
        companionNeed: z.string().trim().max(2_000),
        hypothesis: z.string().trim().max(4_000),
        differentiation: z.string().trim().max(4_000),
      })
      .strict(),
    persona: characterDraftPersonaSchema,
    visualDirection: characterDraftVisualDirectionSchema,
    commercialIntent: z
      .object({
        ownerId: adminIdSchema.nullable(),
        plannedLaunchAt: adminIsoDateTimeSchema.nullable(),
        targetPlacementKeys: z.array(z.string().trim().min(1).max(120)).max(24),
        successCriteria: z.array(z.string().trim().min(1).max(500)).max(24),
        productionPackage: z.string().trim().max(4_000),
        qaPlan: z.string().trim().max(4_000),
      })
      .strict(),
  })
  .strict();

export const characterProjectDraftSchema = characterProjectDraftObjectSchema;

export const characterCreateInstructionalSentinels = [
  [["positioning", "audience"], "Define the adult audience for this companion"],
  [["positioning", "companionNeed"], "Define the recurring companionship need"],
  [["positioning", "hypothesis"], "State the behavior and outcome hypothesis"],
  [["positioning", "differentiation"], "Explain why users will choose this character"],
  [["persona", "name"], "Untitled companion"],
  [["persona", "relationshipArchetype"], "trusted companion"],
  [["persona", "characterPromise"], "A specific, dependable companionship promise"],
  [["persona", "firstMessage"], "I'm here. Where should we begin?"],
  [["visualDirection", "identityAnchor"], "A recognizable adult companion identity"],
  [["visualDirection", "referenceDirection"], "Describe lighting, framing, wardrobe, and reference direction."],
  [["commercialIntent", "productionPackage"], "Define the required identity, placement, and chat asset package."],
  [["commercialIntent", "qaPlan"], "Define mobile, desktop, and conversation QA evidence."],
] as const;

function valueAtPath(
  value: Record<string, unknown>,
  path: readonly string[],
) {
  let current: unknown = value;
  for (const segment of path) {
    if (
      current === null ||
      typeof current !== "object" ||
      Array.isArray(current)
    ) return undefined;
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
    ["commercialIntent", "successCriteria", "Define one measurable success criterion"],
  ] as const;
  for (const [section, field, sentinel] of listSentinels) {
    const values = valueAtPath(
      value as unknown as Record<string, unknown>,
      [section, field],
    );
    if (
      Array.isArray(values) &&
      values.some((item) => item === sentinel)
    ) {
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

export const characterProjectCreateRequestSchema =
  characterProjectDraftObjectSchema
    .extend({
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

export const customerCharacterPublicationPrepRequestSchema = z
  .object({
    submissionId: adminIdSchema,
    reason: z.string().trim().min(3).max(2_000),
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

export const characterProjectSchema = z
  .object({
    id: adminIdSchema,
    characterId: adminIdSchema,
    ownerId: adminIdSchema.nullable(),
    phase: characterProjectPhaseSchema,
    audience: z.string().trim(),
    companionNeed: z.string().trim(),
    hypothesis: z.string().trim(),
    differentiation: z.string().trim(),
    targetPlacementKeys: z.array(z.string().trim().min(1)).readonly(),
    successCriteria: z.array(z.string().trim().min(1)).readonly(),
    plannedLaunchAt: adminIsoDateTimeSchema.nullable(),
    version: z.number().int().nonnegative(),
    createdAt: adminIsoDateTimeSchema,
    updatedAt: adminIsoDateTimeSchema,
  })
  .strict();

export const characterProjectDraftPatchRequestSchema = z
  .object({
    entityVersion: z.number().int().nonnegative(),
    ownerId: adminIdSchema.nullable(),
    audience: z.string().trim().max(2_000),
    companionNeed: z.string().trim().max(2_000),
    hypothesis: z.string().trim().max(4_000),
    differentiation: z.string().trim().max(4_000),
    targetPlacementKeys: z.array(z.string().trim().min(1).max(120)).max(24),
    successCriteria: z.array(z.string().trim().min(1).max(500)).max(24),
    productionPackage: z.string().trim().max(4_000).default(""),
    qaPlan: z.string().trim().max(4_000).default(""),
    plannedLaunchAt: adminIsoDateTimeSchema.nullable(),
    content: z
      .object({
        persona: characterDraftPersonaSchema,
        visualDirection: characterDraftVisualDirectionSchema,
      })
      .strict()
      .optional(),
    reason: z.string().trim().min(3).max(2_000),
  })
  .strict();

export const characterSoulVersionCreateRequestSchema = z
  .object({
    entityVersion: z.number().int().positive(),
    expectedContentVersionId: adminIdSchema,
    persona: characterDraftPersonaSchema,
    reason: z.string().trim().min(3).max(2_000),
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

export type CharacterProject = z.infer<typeof characterProjectSchema>;

export type CharacterDraftPersona = z.infer<typeof characterDraftPersonaSchema>;

export type CharacterDraftVisualDirection = z.infer<typeof characterDraftVisualDirectionSchema>;

export type CharacterProjectCreateRequest = z.infer<typeof characterProjectCreateRequestSchema>;

export type CharacterProjectCreateResponse = z.infer<typeof characterProjectCreateResponseSchema>;

export type CustomerCharacterPublicationPrepRequest = z.infer<typeof customerCharacterPublicationPrepRequestSchema>;

export type CustomerCharacterPublicationPrepResponse = z.infer<typeof customerCharacterPublicationPrepResponseSchema>;

export type CharacterProjectDraft = z.infer<typeof characterProjectDraftSchema>;

export type CharacterProjectDraftAuthority = z.infer<typeof characterProjectDraftAuthoritySchema>;

export type CharacterProjectDraftResume = z.infer<typeof characterProjectDraftResumeSchema>;

export type CharacterProjectDraftPatchRequest = z.infer<typeof characterProjectDraftPatchRequestSchema>;

export type CharacterSoulVersionCreateRequest = z.infer<typeof characterSoulVersionCreateRequestSchema>;

export type CharacterSoulVersionCreateResponse = z.infer<typeof characterSoulVersionCreateResponseSchema>;
