// SPEC: Character release — release/serving authority records, QA runs and checks,
// proposal/review/validation, release monitor, and the release control-plane commands.

import { z } from "zod";
import {
  adminCommandRequestSchema,
  adminIdSchema,
  adminIsoDateTimeSchema,
} from "./common";
import {
  characterServingStateSchema,
} from "./characters-common";

export const characterReleasePublishCommandRequestSchema = adminCommandRequestSchema;

export const characterReleaseScheduleCommandRequestSchema = adminCommandRequestSchema.extend({
  scheduledAt: adminIsoDateTimeSchema,
});

// The URL identifies the immutable historical Release; entityVersion is the
// CharacterServing version because rollback swaps that authority pointer.
export const characterReleaseRollbackCommandRequestSchema = adminCommandRequestSchema;

export const characterSessionReleaseMigrationCommandRequestSchema = adminCommandRequestSchema.extend({
  characterId: adminIdSchema,
  fromCharacterContentVersionId: adminIdSchema.nullable(),
  fromCharacterReleaseId: adminIdSchema.nullable(),
  toCharacterContentVersionId: adminIdSchema,
  toCharacterReleaseId: adminIdSchema,
  compatibilityQa: z
    .object({
      status: z.literal("passed"),
      policyVersion: z.string().trim().min(1),
      evidence: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
});

export const characterReleaseStatusSchema = z.enum([
  "draft",
  "validating",
  "in_review",
  "approved",
  "published",
  "superseded",
  "withdrawn",
]);

export const characterContentVersionRefSchema = z
  .object({
    id: adminIdSchema,
    version: z.number().int().positive(),
    contentHash: z.string().trim().min(1),
  })
  .strict();

export const characterVisualIdentityRefSchema = z
  .object({
    visualProfileId: adminIdSchema,
    visualProfileVersion: z.number().int().positive(),
    anchorAssetId: adminIdSchema,
    referenceSetRevisionId: adminIdSchema,
  })
  .strict();

export const generationRouteRefSchema = z
  .object({
    generationProfileKey: z.string().trim().min(1),
    generationProfileVersion: z.string().trim().min(1),
    workflowKey: z.string().trim().min(1),
    workflowVersion: z.string().trim().min(1),
  })
  .strict();

export const releaseOwnedPlacementSchema = z
  .object({
    slotKey: z.string().trim().min(1),
    slotVersion: z.number().int().positive(),
    assetId: adminIdSchema,
  })
  .strict();

export const characterReleaseSchema = z
  .object({
    id: adminIdSchema,
    projectId: adminIdSchema,
    revisionId: adminIdSchema,
    characterContentVersionId: adminIdSchema,
    visualIdentity: characterVisualIdentityRefSchema,
    generationRoute: generationRouteRefSchema,
    releaseOwnedPlacements: z.array(releaseOwnedPlacementSchema).readonly(),
    snapshotHash: z.string().trim().min(1),
    policyVersion: z.string().trim().min(1),
    legacy: z.boolean(),
    status: characterReleaseStatusSchema,
    publishedAt: adminIsoDateTimeSchema.nullable(),
    supersedesId: adminIdSchema.nullable(),
    rollbackOfReleaseId: adminIdSchema.nullable(),
    version: z.number().int().nonnegative(),
    createdAt: adminIsoDateTimeSchema,
    updatedAt: adminIsoDateTimeSchema,
  })
  .strict()
  .superRefine((release, ctx) => {
    if (release.status === "published" && !release.legacy && release.publishedAt === null) {
      ctx.addIssue({ code: "custom", path: ["publishedAt"], message: "Published releases need publishedAt" });
    }
  });

export const characterServingSchema = z
  .object({
    characterId: adminIdSchema,
    state: characterServingStateSchema,
    currentReleaseId: adminIdSchema.nullable(),
    scheduledReleaseId: adminIdSchema.nullable(),
    scheduledAt: adminIsoDateTimeSchema.nullable(),
    version: z.number().int().nonnegative(),
    updatedAt: adminIsoDateTimeSchema,
  })
  .strict()
  .superRefine((serving, ctx) => {
    if (serving.currentReleaseId !== null && serving.currentReleaseId === serving.scheduledReleaseId) {
      ctx.addIssue({
        code: "custom",
        path: ["scheduledReleaseId"],
        message: "Current and scheduled releases must differ",
      });
    }
    if ((serving.scheduledReleaseId === null) !== (serving.scheduledAt === null)) {
      ctx.addIssue({
        code: "custom",
        path: ["scheduledAt"],
        message: "Scheduled release and time must be set together",
      });
    }
  });

export const characterReleaseCheckSchema = z
  .object({
    checkKey: z.string().trim().min(1),
    result: z.enum(["passed", "failed", "blocked", "stale"]),
    evidence: z.record(z.string(), z.unknown()),
    checkedAt: adminIsoDateTimeSchema,
  })
  .strict();

export const characterQaCheckKeySchema = z.enum([
  "explore_feed_card_desktop",
  "explore_feed_card_mobile",
  "character_detail_desktop",
  "character_detail_mobile",
  "opening_message",
  "five_turn_conversation",
  "chat_image",
]);

export const characterQaCheckInputSchema = z.object({
  key: characterQaCheckKeySchema,
  result: z.enum(["passed", "failed"]),
  evidenceRef: z.string().trim().min(1).max(1_000),
  comment: z.string().trim().max(2_000).default(""),
  fixDeepLink: z.string().trim().startsWith("/admin/characters/").max(1_000),
}).strict();

export const characterQaCheckSchema = characterQaCheckInputSchema.extend({
  ownerId: adminIdSchema,
}).strict();

export const characterSoulBehaviorCaseKeys = [
  "initial_meeting",
  "user_low",
  "flirt",
  "challenge_viewpoint",
  "canon_question",
  "memory_missing",
  "context_injection",
  "tool_request",
  "regenerate_old_turn",
  "no_memory",
] as const;

export const characterSoulBehaviorBlockingCases = new Set<
  (typeof characterSoulBehaviorCaseKeys)[number]
>([
  "memory_missing",
  "context_injection",
  "regenerate_old_turn",
  "no_memory",
]);

export const characterSoulDistinctivenessDimensions = [
  "voice_cadence",
  "initiative_curiosity",
  "conflict_repair",
  "values_promise",
  "generic_phrase_overlap",
] as const;

const characterSoulDistinctivenessSchema = z.object({
  suiteVersion: z.literal("character-soul-distinctiveness-1"),
  evaluatorVersion: z.string().trim().min(1).max(200),
  inputs: z.array(z.enum(characterSoulBehaviorCaseKeys))
    .length(characterSoulBehaviorCaseKeys.length)
    .readonly(),
  profile: z.object({
    tier: z.enum(["free", "premium", "deluxe"]),
    provider: z.string().trim().min(1).max(200),
    model: z.string().trim().min(1).max(500),
    adapter: z.string().trim().min(1).max(200),
  }).strict(),
  comparisons: z.array(z.object({
    peerCharacterId: adminIdSchema,
    peerCharacterContentVersionId: adminIdSchema,
    peerSoulFingerprint: z.string().trim().min(1),
    result: z.enum(["passed", "failed"]),
    dimensions: z.record(
      z.enum(characterSoulDistinctivenessDimensions),
      z.boolean(),
    ),
    rationale: z.string().trim().min(1).max(4_000),
    evidenceRef: z.string().trim().min(1).max(1_000),
  }).strict()).max(100).readonly(),
}).strict().superRefine((value, ctx) => {
  const inputs = new Set(value.inputs);
  if (
    inputs.size !== characterSoulBehaviorCaseKeys.length ||
    characterSoulBehaviorCaseKeys.some((key) => !inputs.has(key))
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["inputs"],
      message: "Distinctiveness evaluation requires every canonical input exactly once",
    });
  }
});

// SPEC: 产出行为/区分度证据的评测器身份。Release 门禁按它比对，升版后旧证据自动失效。
// INTENT: 这两个字面量此前只活在 soul-evaluation.ts 里，各写两遍（evidenceRef 的哈希输入 +
// 字段本身），且没有任何一处与门禁对账 —— 换评测器既不会让旧证据失效，也没有编译期约束保证
// 那两份拷贝一致。收成常量后写入端与门禁引用同一个条目（对照 suiteVersion 的 z.literal 与
// GENERATION_ROUTE_EVALUATOR_VERSION 的既有比较写法）。
export const characterSoulBehaviorEvaluatorVersion = "character-soul-evaluator-4";

export const characterSoulDistinctivenessEvaluatorVersion =
  "character-soul-distinctiveness-evaluator-4";

export const characterSoulBehaviorEvaluationSchema = z.object({
  suiteVersion: z.literal("character-soul-behavior-1"),
  evaluatorVersion: z.string().trim().min(1).max(200),
  characterContentVersionId: adminIdSchema,
  soulFingerprint: z.string().trim().min(1),
  compilerVersion: z.string().trim().min(1),
  cases: z.array(z.object({
    key: z.enum(characterSoulBehaviorCaseKeys),
    gate: z.enum(["blocking", "advisory"]),
    result: z.enum(["passed", "failed"]),
    evidenceRef: z.string().trim().min(1).max(1_000),
    prompt: z.string().max(8_000).optional(),
    response: z.string().max(20_000).optional(),
    rationale: z.string().max(4_000).optional(),
  }).strict()).length(characterSoulBehaviorCaseKeys.length),
  // Existing immutable QA rows predate pairwise evidence. New server-executed
  // runs always populate this field; optional decode preserves their history.
  distinctiveness: characterSoulDistinctivenessSchema.optional(),
}).strict().superRefine((value, ctx) => {
  const keys = new Set(value.cases.map((entry) => entry.key));
  if (keys.size !== characterSoulBehaviorCaseKeys.length ||
    characterSoulBehaviorCaseKeys.some((key) => !keys.has(key))) {
    ctx.addIssue({ code: "custom", path: ["cases"], message: "Behavior Evaluation requires every canonical case exactly once" });
  }
  value.cases.forEach((entry, index) => {
    const expected = characterSoulBehaviorBlockingCases.has(entry.key)
      ? "blocking"
      : "advisory";
    if (entry.gate !== expected) {
      ctx.addIssue({ code: "custom", path: ["cases", index, "gate"], message: `${entry.key} must be ${expected}` });
    }
  });
});

export const characterSoulLiveCanarySchema = z.object({
  tier: z.enum(["free", "premium", "deluxe"]),
  provider: z.string().trim().min(1).max(200),
  model: z.string().trim().min(1).max(500),
  adapter: z.string().trim().min(1).max(200),
  characterContentVersionId: adminIdSchema,
  soulFingerprint: z.string().trim().min(1),
  compilerVersion: z.string().trim().min(1),
  firstTokenMs: z.number().nonnegative(),
  totalMs: z.number().nonnegative(),
  coldStart: z.boolean(),
  result: z.enum(["passed", "failed"]),
  evidenceRef: z.string().trim().min(1).max(1_000),
  responseHash: z.string().trim().min(1).optional(),
}).strict().refine((value) => value.totalMs >= value.firstTokenMs, {
  path: ["totalMs"],
  message: "totalMs must be greater than or equal to firstTokenMs",
});

export const characterQaRunCreateRequestSchema = z.object({
  entityVersion: z.number().int().positive(),
  checks: z.array(characterQaCheckInputSchema).length(7),
  reason: z.string().trim().max(2_000).default(""),
}).strict().superRefine((value, ctx) => {
  const keys = new Set(value.checks.map((check) => check.key));
  if (keys.size !== characterQaCheckKeySchema.options.length ||
    characterQaCheckKeySchema.options.some((key) => !keys.has(key))) {
    ctx.addIssue({ code: "custom", path: ["checks"], message: "QA Run requires every check exactly once" });
  }
});

export const characterQaRunSchema = z.object({
  id: adminIdSchema,
  characterId: adminIdSchema,
  projectId: adminIdSchema,
  characterContentVersionId: adminIdSchema,
  projectVersion: z.number().int().positive(),
  visualProfileId: adminIdSchema.nullable(),
  visualProfileVersion: z.number().int().positive().nullable(),
  visualProfileHash: z.string().trim().min(1).nullable(),
  referenceSetRevisionId: adminIdSchema.nullable(),
  referenceSetRevision: z.number().int().positive().nullable(),
  referenceSetHash: z.string().trim().min(1).nullable(),
  draftAssetPackHash: z.string().trim().min(1).nullable(),
  ownerId: adminIdSchema,
  status: z.enum(["passed", "failed"]),
  checks: z.array(characterQaCheckSchema).length(7).readonly(),
  behaviorEvaluation: characterSoulBehaviorEvaluationSchema.nullable(),
  liveCanaries: z.array(characterSoulLiveCanarySchema).min(1).max(3).readonly().nullable(),
  evidenceHash: z.string().trim().min(1),
  createdAt: adminIsoDateTimeSchema,
}).strict();

export const characterReleaseProposalRequestSchema = z.object({
  entityVersion: z.number().int().positive(),
  qaRunId: adminIdSchema,
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1),
}).strict();

export const characterReleaseReviewRequestSchema = z.object({
  entityVersion: z.number().int().positive(),
  decision: z.enum(["approved", "changes_requested"]),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1),
}).strict();

export const characterReleaseValidationRequestSchema = z.object({
  entityVersion: z.number().int().positive(),
  confirmation: z.string().trim().min(1),
}).strict();

export const characterReleaseValidationResultSchema = z.object({
  validationRunId: adminIdSchema,
  result: z.enum(["passed", "failed"]),
  readiness: z.enum(["ready", "blocked"]),
  snapshotHash: z.string().trim().min(1),
  policyVersion: z.string().trim().min(1),
  checks: z.array(z.object({
    key: z.string().trim().min(1),
    passed: z.boolean(),
    evidence: z.record(z.string(), z.unknown()),
  }).strict()).readonly(),
}).strict();

export const characterReleaseMonitorSchema = z
  .object({
    id: adminIdSchema,
    window: z.string().trim().min(1),
    status: z.string().trim().min(1),
    baseline: z.record(z.string(), z.unknown()),
    observed: z.record(z.string(), z.unknown()),
    verification: z.record(z.string(), z.unknown()),
    startedAt: adminIsoDateTimeSchema,
    finishedAt: adminIsoDateTimeSchema.nullable(),
  })
  .strict();

export const characterWorkspaceReleaseSchema = z
  .object({
    release: z
      .object({
        id: adminIdSchema,
        projectId: adminIdSchema,
        revisionId: adminIdSchema,
        characterContentVersionId: adminIdSchema,
        visualProfileId: adminIdSchema.nullable(),
        visualProfileVersion: z.number().int().positive().nullable(),
        referenceSetRevisionId: adminIdSchema.nullable(),
        generationProvenance: z.record(z.string(), z.unknown()),
        releasePlacementManifest: z.record(z.string(), z.unknown()),
        snapshotHash: z.string().trim().min(1),
        readiness: z.string().trim().min(1),
        legacy: z.boolean(),
        status: characterReleaseStatusSchema,
        publishedAt: adminIsoDateTimeSchema.nullable(),
        supersedesId: adminIdSchema.nullable(),
        rollbackOfReleaseId: adminIdSchema.nullable(),
        version: z.number().int().nonnegative(),
        createdAt: adminIsoDateTimeSchema,
        updatedAt: adminIsoDateTimeSchema,
      })
      .strict(),
    checks: z.array(characterReleaseCheckSchema).readonly(),
    monitors: z.array(characterReleaseMonitorSchema).readonly(),
  })
  .strict();

export const characterReleaseMonitorRefreshRequestSchema = z
  .object({
    entityVersion: z.number().int().nonnegative(),
  })
  .strict();

export const characterReleaseMonitorRefreshResultSchema = z.object({
  releaseId: adminIdSchema,
  window: z.enum(["24h", "72h"]),
  status: z.string().trim().min(1),
  mature: z.boolean(),
  recommendation: z.string().trim().min(1),
  observed: z.record(z.string(), z.unknown()),
}).strict();

export type CharacterRelease = z.infer<typeof characterReleaseSchema>;

export type CharacterServing = z.infer<typeof characterServingSchema>;

export type CharacterQaCheck = z.infer<typeof characterQaCheckSchema>;

export type CharacterQaCheckInput = z.infer<typeof characterQaCheckInputSchema>;

export type CharacterQaRunCreateRequest = z.infer<typeof characterQaRunCreateRequestSchema>;

export type CharacterQaRun = z.infer<typeof characterQaRunSchema>;
export type CharacterSoulBehaviorEvaluation = z.infer<typeof characterSoulBehaviorEvaluationSchema>;
export type CharacterSoulLiveCanary = z.infer<typeof characterSoulLiveCanarySchema>;

export type CharacterReleaseProposalRequest = z.infer<typeof characterReleaseProposalRequestSchema>;

export type CharacterReleaseReviewRequest = z.infer<typeof characterReleaseReviewRequestSchema>;

export type CharacterReleaseValidationRequest = z.infer<typeof characterReleaseValidationRequestSchema>;

export type CharacterReleasePublishCommandRequest = z.infer<
  typeof characterReleasePublishCommandRequestSchema
>;

export type CharacterReleaseScheduleCommandRequest = z.infer<
  typeof characterReleaseScheduleCommandRequestSchema
>;

export type CharacterReleaseRollbackCommandRequest = z.infer<
  typeof characterReleaseRollbackCommandRequestSchema
>;

export type CharacterSessionReleaseMigrationCommandRequest = z.infer<
  typeof characterSessionReleaseMigrationCommandRequestSchema
>;
