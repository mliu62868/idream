import { z } from "zod";

export const CHAT_PIN_LIMIT = 8;
export const CHAT_PIN_MAX_CHARS = 500;
export const CHAT_INSTRUCTION_MAX_CHARS = 1_500;

// Explicit user-authored context, not an automatic memory extract or a system rule.
export const chatContextDirectiveSchema = z.object({
  id: z.string().min(1).max(160),
  kind: z.enum(["pinned_memory", "custom_instruction"]),
  content: z.string().trim().min(1).max(CHAT_INSTRUCTION_MAX_CHARS),
  version: z.number().int().positive(),
}).strict().superRefine((value, context) => {
  if (value.kind === "pinned_memory" && value.content.length > CHAT_PIN_MAX_CHARS) {
    context.addIssue({ code: "custom", path: ["content"], message: `Pinned memories are limited to ${CHAT_PIN_MAX_CHARS} characters` });
  }
});

export const chatContextDirectivesSchema = z.array(chatContextDirectiveSchema)
  .max(CHAT_PIN_LIMIT + 1)
  .superRefine((items, context) => {
    if (
      items.filter((item) => item.kind === "pinned_memory").length > CHAT_PIN_LIMIT ||
      items.filter((item) => item.kind === "custom_instruction").length > 1 ||
      new Set(items.map((item) => item.id)).size !== items.length
    ) {
      context.addIssue({ code: "custom", message: "Chat context exceeds its per-kind limit or repeats a directive" });
    }
  });

export type ChatContextDirective = z.infer<typeof chatContextDirectiveSchema>;

export const CHAT_PERSONA_MAX_CHARS = 1_500;
export const userChatPersonaValuesSchema = z.object({
  enabled: z.boolean(),
  name: z.string().trim().max(80),
  description: z.string().trim().max(CHAT_PERSONA_MAX_CHARS),
}).strict();
export const userChatPersonaSchema = userChatPersonaValuesSchema.extend({
  version: z.number().int().positive(),
}).strict().refine(value => Boolean(value.name || value.description), {
  message: "Add a name or description, or clear your persona",
});
export const userChatPersonaResponseSchema = z.object({
  ownerScope: z.string().startsWith("user:").max(240),
  persona: userChatPersonaSchema.nullable(),
  version: z.number().int().nonnegative(),
}).strict().refine(value => value.persona === null || value.persona.version === value.version, {
  message: "Persona version does not match its settings",
});
export type UserChatPersona = z.infer<typeof userChatPersonaSchema>;

export const chatSceneGenerationSchema = z.enum(["follow", "advance"]);
export const chatExperienceValuesSchema = z.object({
  responseLength: z.enum(["auto", "short", "long"]),
  interactionIntensity: z.enum(["gentle", "balanced", "expressive"]),
  sceneGeneration: chatSceneGenerationSchema.default("follow"),
}).strict();
export const chatExperiencePreferenceSchema = chatExperienceValuesSchema.extend({
  // Historical accepted preferences predate this control; do not backfill them.
  sceneGeneration: chatSceneGenerationSchema.optional(),
  version: z.number().int().nonnegative(),
}).strict().refine(value => value.version !== 0 || (
  value.responseLength === "auto" && value.interactionIntensity === "balanced" && value.sceneGeneration === "follow"
), { message: "Version zero is reserved for the default conversation preferences" });
export type ChatExperiencePreference = z.infer<typeof chatExperiencePreferenceSchema>;
export const DEFAULT_CHAT_EXPERIENCE = {
  responseLength: "auto", interactionIntensity: "balanced", sceneGeneration: "follow", version: 0,
} as const;

// Main, Chat and voice all exchange the same committed, session-local Scene.
export const chatSceneStateSchema = z.object({
  schemaVersion: z.literal(1),
  version: z.number().int().nonnegative(),
  location: z.string().nullable(),
  time: z.string().nullable(),
  participants: z.array(z.string()),
  emotionalBeat: z.string().nullable(),
  unresolvedThreads: z.array(z.string()),
}).strict();
export type ChatSceneState = z.infer<typeof chatSceneStateSchema>;

function refineSceneAuthority(
  value: { sceneVersion: number; scene: ChatSceneState | null },
  context: z.RefinementCtx,
) {
  if (value.sceneVersion !== (value.scene?.version ?? 0)) {
    context.addIssue({
      code: "custom", path: ["sceneVersion"],
      message: "sceneVersion must match the pinned Scene revision; null Scene requires version zero",
    });
  }
}

export const chatExecutionSnapshotSchema = z.object({
  version: z.literal(1),
  turnId: z.string().min(1),
  sessionId: z.string().min(1),
  userMessageId: z.string().min(1),
  assistantMessageId: z.string().min(1),
  attempt: z.number().int().positive(),
  userId: z.string().min(1),
  characterId: z.string().min(1),
  characterContentVersionId: z.string().min(1),
  characterReleaseId: z.string().min(1).nullable(),
  characterVisualProfileId: z.string().min(1).nullable(),
  characterVisualProfileVersion: z.number().int().positive().nullable(),
  memoryEnabled: z.boolean(),
  // Missing only on historical snapshots; never backfill those with today's settings.
  contextDirectives: chatContextDirectivesSchema.optional(),
  experience: chatExperiencePreferenceSchema.optional(),
  userPersona: userChatPersonaSchema.nullable().optional(),
  contextRevision: z.number().int().nonnegative(),
  userContent: z.string(),
  hasRecentImageContext: z.boolean().default(false),
  recentTurns: z.array(z.object({
    turnId: z.string().min(1),
    userMessageId: z.string().min(1),
    assistantMessageId: z.string().min(1),
    userContent: z.string(),
    assistantContent: z.string(),
    createdAt: z.string().datetime(),
  }).strict()),
  sceneVersion: z.number().int().nonnegative(),
  scene: chatSceneStateSchema.nullable(),
}).strict().superRefine((snapshot, context) => {
  refineSceneAuthority(snapshot, context);
  if (
    (snapshot.characterVisualProfileId === null) !==
    (snapshot.characterVisualProfileVersion === null)
  ) {
    context.addIssue({
      code: "custom",
      path: ["characterVisualProfileId"],
      message: "Character visual profile id and version must be pinned together",
    });
  }
});

const chatPromptAttributionSchema = z.object({
  productPromptVersion: z.string().trim().min(1),
  preparedTurnVersion: z.number().int().positive().nullable(),
  systemPromptDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  soulFingerprint: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
}).strict().superRefine((value, context) => {
  const compiled = value.preparedTurnVersion !== null;
  if (compiled !== (value.systemPromptDigest !== null) || compiled !== (value.soulFingerprint !== null)) {
    context.addIssue({
      code: "custom",
      message: "compiled prompt attribution must include version, system digest, and Soul fingerprint together",
    });
  }
});

export const chatTerminalEvidenceSchema = z.object({
  authority: z.string().trim().min(1),
  prompt: chatPromptAttributionSchema,
}).catchall(z.unknown());

export const chatTerminalCommitSchema = z.object({
  version: z.literal(1),
  turnId: z.string().min(1),
  sessionId: z.string().min(1),
  assistantMessageId: z.string().min(1),
  attempt: z.number().int().positive(),
  status: z.enum(["sent", "blocked", "failed", "cancelled"]),
  content: z.string(),
  model: z.string().nullable(),
  promptTokens: z.number().int().nonnegative().nullable(),
  completionTokens: z.number().int().nonnegative().nullable(),
  sceneVersion: z.number().int().nonnegative(),
  scene: chatSceneStateSchema.nullable(),
  terminalEvidence: chatTerminalEvidenceSchema,
}).strict().superRefine((terminal, context) => {
  refineSceneAuthority(terminal, context);
  if (
    terminal.status === "sent" &&
    terminal.terminalEvidence.prompt.preparedTurnVersion === null
  ) {
    context.addIssue({
      code: "custom",
      path: ["terminalEvidence", "prompt"],
      message: "a sent Chat terminal requires exact compiled prompt attribution",
    });
  }
});

export const chatToolEffectSchema = z.object({
  version: z.literal(2),
  turnId: z.string().min(1),
  attempt: z.number().int().positive(),
  callId: z.string().min(1),
  name: z.enum(["generate_image_async", "edit_last_image"]),
  effectScope: z.enum(["attempt", "turn_action"]),
  intent: z.object({
    requestedNudity: z.enum(["unspecified", "none", "full"]),
  }).strict(),
  arguments: z.record(z.string(), z.unknown()),
}).strict();

// A successful HTTP response alone is not a durable terminal acknowledgement.
export const chatTerminalAckSchema = z.object({
  accepted: z.literal(true),
  duplicate: z.boolean(),
  terminalMessageId: z.string().min(1),
  committedAt: z.string().datetime(),
}).strict();

export type ChatExecutionSnapshot = z.infer<typeof chatExecutionSnapshotSchema>;
export type ChatTerminalCommit = z.infer<typeof chatTerminalCommitSchema>;
export type ChatTerminalAck = z.infer<typeof chatTerminalAckSchema>;
export type ChatToolEffect = z.infer<typeof chatToolEffectSchema>;
