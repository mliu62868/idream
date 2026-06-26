import { z } from "zod";

export const modelMessageSchema = z.object({
  id: z.string().optional(),
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string(),
  createdAt: z.string().optional(),
});

export const chatStreamEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("start"),
    attempt: z.number().int().min(1),
  }),
  z.object({
    type: z.literal("delta"),
    attempt: z.number().int().min(1),
    seq: z.number().int().min(1),
    delta: z.string(),
  }),
  z.object({
    type: z.literal("done"),
    attempt: z.number().int().min(1),
    usage: z.object({
      promptTokens: z.number().int().min(0),
      completionTokens: z.number().int().min(0),
    }),
  }),
  z.object({
    type: z.literal("error"),
    attempt: z.number().int().min(1),
    code: z.string(),
    retryable: z.boolean(),
  }),
]);

const entitlementSnapshotSchema = z
  .object({
    modelTier: z.enum(["free", "premium", "deluxe"]),
    memoryMultiplier: z.number().min(1),
    unlimitedMessages: z.boolean(),
  })
  .passthrough();

const chatUserSnapshotSchema = z
  .object({
    userId: z.string(),
    displayName: z.string().nullable(),
    locale: z.string(),
    memoryEnabled: z.boolean(),
    mutedTags: z.array(z.string()),
    safeModeFlags: z.record(z.string(), z.unknown()),
  })
  .passthrough();

const chatCharacterSnapshotSchema = z
  .object({
    characterId: z.string(),
    name: z.string(),
    age: z.number().int().min(18),
    relationship: z.string().nullable(),
    description: z.string(),
    systemPrompt: z.string().nullable(),
    tags: z.array(z.string()),
  })
  .passthrough();

const chatContextSchema = z
  .object({
    sessionSummary: z.string().nullable(),
    recentMessages: z.array(modelMessageSchema),
    longTermMemories: z.array(z.unknown()),
    relationshipState: z.unknown().nullable(),
  })
  .passthrough();

const chatPolicySchema = z
  .object({
    allowMemoryWrite: z.boolean(),
    allowGlobalMemoryWrite: z.boolean(),
    allowRelationshipPatch: z.boolean(),
    outputModerationRequired: z.boolean(),
  })
  .passthrough();

export const chatGeneratePayloadSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("chat.generate"),
    requestId: z.string(),
    sessionId: z.string(),
    userMessageId: z.string(),
    assistantMessageId: z.string(),
    streamKey: z.string(),
    mode: z.enum(["normal", "regenerate", "no_memory", "debug"]),
    entitlements: entitlementSnapshotSchema,
    user: chatUserSnapshotSchema,
    character: chatCharacterSnapshotSchema,
    context: chatContextSchema,
    policy: chatPolicySchema,
  })
  .passthrough();

export const imageGeneratePayloadSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("image"),
    requestId: z.string(),
    generationJobId: z.string(),
    userId: z.string(),
    characterId: z.string().nullable(),
    prompt: z.string(),
    negativePrompt: z.string().nullable(),
    controls: z.record(z.string(), z.unknown()),
    presetIds: z.array(z.string()),
    orientation: z.string(),
    count: z.number().int().min(1).max(4),
    seed: z.string(),
    model: z.string(),
    outputPrefix: z.string(),
  })
  .passthrough();

export const videoGeneratePayloadSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("video"),
    requestId: z.string(),
    generationJobId: z.string(),
    userId: z.string(),
    characterId: z.string().nullable(),
    prompt: z.string(),
    negativePrompt: z.string().nullable(),
    controls: z.record(z.string(), z.unknown()),
    seconds: z.number().int().min(1).max(30),
    seed: z.string(),
    model: z.string(),
    outputPrefix: z.string(),
  })
  .passthrough();

const memoryScopeSchema = z.enum(["global", "character", "session"]);
const memoryTypeSchema = z.enum(["user_fact", "preference", "boundary", "shared_event"]);
const memoryStatusSchema = z.enum(["active", "deleted"]);

export const memoryCandidateSchema = z
  .object({
    operation: z.enum(["upsert", "delete"]).default("upsert"),
    scope: memoryScopeSchema,
    type: memoryTypeSchema,
    text: z.string(),
    confidence: z.number().min(0).max(1),
    sourceMessageIds: z.array(z.string()),
  })
  .passthrough();

export const syncedMemorySchema = z
  .object({
    id: z.string(),
    userId: z.string().optional(),
    characterId: z.string().nullable().optional(),
    sessionId: z.string().nullable().optional(),
    scope: memoryScopeSchema,
    type: memoryTypeSchema,
    text: z.string(),
    confidence: z.number().min(0).max(1).default(1),
    status: memoryStatusSchema.default("active"),
    sourceMessageIds: z.array(z.string()).default([]),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .passthrough();

export const memorySyncChangeSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("upsert"),
      memory: syncedMemorySchema,
    })
    .passthrough(),
  z
    .object({
      operation: z.literal("delete"),
      memoryId: z.string(),
    })
    .passthrough(),
]);

export const memorySyncPayloadSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("memory.sync"),
    requestId: z.string(),
    userId: z.string(),
    characterId: z.string().nullable().optional(),
    changes: z.array(memorySyncChangeSchema),
  })
  .passthrough();

export const memoryForgetPayloadSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("memory.forget"),
    requestId: z.string(),
    userId: z.string(),
    scope: z.enum(["message", "memory", "character", "account"]).optional(),
    targetIds: z.array(z.string()).default([]),
    sessionId: z.string().optional(),
    memoryIds: z.array(z.string()).default([]),
    sourceMessageId: z.string().optional(),
    reason: z.enum([
      "user_delete",
      "session_no_memory",
      "memory_delete",
      "user_deleted_message",
      "user_deleted_memory",
      "memory_disabled",
      "account_deleted",
      "runtime_rebuild",
    ]),
  })
  .passthrough();

export const memoryRebuildPayloadSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("memory.rebuild"),
    requestId: z.string(),
    userId: z.string(),
    characterId: z.string().nullable().optional(),
    source: z
      .object({
        memorySnapshotVersion: z.number().int().min(0).optional(),
        memories: z.array(syncedMemorySchema).default([]),
      })
      .passthrough(),
  })
  .passthrough();

const usageSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));

const memoryPatchSchema = z
  .object({
    sessionSummary: z
      .object({
        operation: z.literal("replace"),
        text: z.string(),
      })
      .optional(),
    candidates: z.array(memoryCandidateSchema).default([]),
  })
  .passthrough();

const generationAssetSchema = z
  .object({
    key: z.string(),
    width: z.number().int().min(1).optional(),
    height: z.number().int().min(1).optional(),
    seconds: z.number().min(0).optional(),
    contentType: z.string(),
  })
  .passthrough();

export const aiFinalizePayloadSchema = z.discriminatedUnion("kind", [
  z
    .object({
      version: z.literal(1),
      kind: z.literal("chat.completed"),
      requestId: z.string(),
      sessionId: z.string(),
      userMessageId: z.string(),
      assistantMessageId: z.string(),
      content: z.string(),
      model: z.string(),
      usage: z.object({
        promptTokens: z.number().int().min(0),
        completionTokens: z.number().int().min(0),
      }),
      memoryPatch: memoryPatchSchema.optional(),
      relationshipPatch: z
        .object({
          operation: z.literal("merge").default("merge"),
          stage: z.enum(["new", "familiar", "close", "committed"]).optional(),
          summaryDelta: z.string().optional(),
          signalsDelta: z.record(z.string(), z.number()).default({}),
          boundaries: z.array(z.string()).optional(),
        })
        .passthrough()
        .optional(),
      trace: z.unknown().optional(),
    })
    .passthrough(),
  z
    .object({
      version: z.literal(1),
      kind: z.literal("chat.failed"),
      requestId: z.string(),
      sessionId: z.string(),
      userMessageId: z.string(),
      assistantMessageId: z.string(),
      error: z.object({
        code: z.string(),
        message: z.string(),
        retryable: z.boolean(),
        partialOutput: z.boolean(),
      }),
    })
    .passthrough(),
  z
    .object({
      version: z.literal(1),
      kind: z.literal("memory.forgotten"),
      requestId: z.string(),
      userId: z.string(),
      scope: z.enum(["message", "memory", "character", "account"]).optional(),
      targetIds: z.array(z.string()).default([]),
      deletedMemoryIds: z.array(z.string()).default([]),
      reason: z.string(),
    })
    .passthrough(),
  z
    .object({
      version: z.literal(1),
      kind: z.literal("generation.completed"),
      requestId: z.string(),
      generationJobId: z.string(),
      mode: z.enum(["image", "video"]),
      assets: z.array(generationAssetSchema),
      usage: usageSchema,
    })
    .passthrough(),
  z
    .object({
      version: z.literal(1),
      kind: z.literal("generation.failed"),
      requestId: z.string(),
      generationJobId: z.string(),
      mode: z.enum(["image", "video"]),
      error: z.object({
        code: z.string(),
        message: z.string(),
        retryable: z.boolean(),
      }),
    })
    .passthrough(),
  z
    .object({
      version: z.literal(1),
      kind: z.literal("generation.blocked"),
      requestId: z.string(),
      generationJobId: z.string(),
      mode: z.enum(["image", "video"]),
      policyCode: z.string(),
      message: z.string(),
      layer: z.enum(["input", "output", "provider"]).default("input"),
    })
    .passthrough(),
]);

export type ChatStreamEvent = z.infer<typeof chatStreamEventSchema>;
export type ChatGeneratePayload = z.infer<typeof chatGeneratePayloadSchema>;
export type ImageGeneratePayload = z.infer<typeof imageGeneratePayloadSchema>;
export type VideoGeneratePayload = z.infer<typeof videoGeneratePayloadSchema>;
export type MemorySyncPayload = z.infer<typeof memorySyncPayloadSchema>;
export type MemoryForgetPayload = z.infer<typeof memoryForgetPayloadSchema>;
export type MemoryRebuildPayload = z.infer<typeof memoryRebuildPayloadSchema>;
export type AiFinalizePayload = z.infer<typeof aiFinalizePayloadSchema>;
