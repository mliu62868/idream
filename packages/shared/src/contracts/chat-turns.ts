import { z } from "zod";

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
  scene: z.unknown().nullable(),
}).strict().superRefine((snapshot, context) => {
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
  scene: z.unknown().nullable(),
  terminalEvidence: chatTerminalEvidenceSchema,
}).strict().superRefine((terminal, context) => {
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

export type ChatExecutionSnapshot = z.infer<typeof chatExecutionSnapshotSchema>;
export type ChatTerminalCommit = z.infer<typeof chatTerminalCommitSchema>;
export type ChatToolEffect = z.infer<typeof chatToolEffectSchema>;
