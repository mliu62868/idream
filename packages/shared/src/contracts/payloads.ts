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

/** Durable internal intent. Runtime context is rebuilt from current authorities. */
export const chatGeneratePayloadSchema = z.object({
  sessionId: z.string().min(1),
  userMessageId: z.string().min(1),
  assistantMessageId: z.string().min(1),
  attempt: z.number().int().min(1),
});

/** Exact source turn used by the asynchronous memory/relationship projector. */
export const chatMemoryExtractPayloadSchema = z.object({
  sessionId: z.string().min(1),
  userMessageId: z.string().min(1),
  assistantMessageId: z.string().min(1),
  attempt: z.number().int().min(1),
});

const generationReferenceImageSchema = z
  .object({
    assetId: z.string(),
    role: z.enum([
      "identity_anchor",
      "identity_reference",
      "look_reference",
      "source_image",
    ]),
    storageKey: z.string().optional(),
    url: z.string().optional(),
    contentType: z.string().optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    weight: z.number().min(0).max(2).optional(),
    b64Json: z.string().optional(),
  })
  .passthrough();

export const imageGeneratePayloadSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("image"),
    requestId: z.string(),
    generationJobId: z.string(),
    attemptId: z.string().min(1),
    attemptNo: z.number().int().positive(),
    provider: z.string().trim().min(1),
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
    referenceImages: z.array(generationReferenceImageSchema).optional(),
  })
  .passthrough();

export const chatImageRequestedPayloadSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("chat.image.requested"),
    requestId: z.string(),
    attachmentId: z.string(),
    sessionId: z.string(),
    // Logical user turn that owns this assistant attachment. Optional for
    // rolling compatibility; it lets later privacy corrections find derived
    // generation jobs without retaining conversation text.
    exchangeId: z.string().min(1).optional(),
    messageId: z.string(),
    userId: z.string(),
    characterId: z.string(),
    // The immutable Character Release pinned to this chat session. Optional
    // for rolling compatibility with older Chat builds; Main fails closed to
    // normal generation when it is absent instead of reusing an arbitrary
    // historical character image.
    characterReleaseId: z.string().min(1).optional(),
    promptHint: z.string().nullable(),
    conversationContext: z.string().nullable(),
    controls: z
      .object({
        orientation: z.string().default("4:5"),
        outputCount: z.number().int().min(1).max(4).default(1),
        // P5 Task 2: img2img source for edit_last_image — the media asset of the
        // last completed photo in the session. Absent for generate_image_async
        // (and for edit_last_image's no-source-photo fallback).
        sourceImageAssetId: z.string().optional(),
      })
      .passthrough()
      .default({ orientation: "4:5", outputCount: 1 }),
    // P4: the character's active CharacterVisualProfile at request time (visual passport).
    // Optional — older chat builds, or characters with no bootstrapped profile, omit it.
    visualProfileId: z.string().optional(),
    visualProfileVersion: z.number().int().optional(),
  })
  .passthrough();

export const chatImageAcceptedPayloadSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("chat.image.accepted"),
    attachmentId: z.string(),
    generationJobId: z.string(),
    costDreamcoins: z.number().int().min(0),
  })
  .passthrough();

export const chatImageCompletedPayloadSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("chat.image.completed"),
    attachmentId: z.string(),
    generationJobId: z.string().nullable().optional(),
    mediaAssetId: z.string(),
    width: z.number().int().min(1).nullable().optional(),
    height: z.number().int().min(1).nullable().optional(),
    // P4 Task 5: short human-readable description of the delivered photo, so the
    // chat agent can recall "what it sent" in later turns without re-fetching the
    // asset. Optional — older main builds omit it.
    summary: z.string().optional(),
  })
  .passthrough();

export const chatImageFailedPayloadSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("chat.image.failed"),
    attachmentId: z.string(),
    generationJobId: z.string().nullable().optional(),
    status: z.enum(["failed", "blocked", "refunded", "rejected"]),
    errorCode: z.string().nullable().optional(),
  })
  .passthrough();

// Legacy transport only. Main records it for rolling compatibility but never
// advances v2 deletion authority from this aggregate-level event. The request
// id is optional because older Chat binaries did not emit it.
export const chatAccountErasureCompletedPayloadSchema = z
  .object({
    userId: z.string().min(1),
    fileMutationId: z.string().min(1),
    deletionRequestEventId: z.string().min(1).optional(),
  })
  .strict();

// SPEC: v2 completion is meaningful only as the terminal response to one exact
// Main deletion request. `binding` is deliberately literal so a generic or
// aggregate-level completion cannot be mistaken for request authority.
export const chatAccountErasureCompletedV2PayloadSchema = z
  .object({
    version: z.literal(2),
    binding: z.literal("request_bound"),
    userId: z.string().min(1),
    fileMutationId: z.string().min(1),
    deletionRequestEventId: z.string().min(1),
  })
  .strict();

export const accountDeletionRequestedV2PayloadSchema = z
  .object({
    userId: z.string().min(1),
  })
  .strict();

// SPEC: A moderation removal identifies the exact decision that caused Chat
// to archive sessions. Aggregate-only character events are not reversible.
export const characterModerationRemovedPayloadSchema = z
  .object({
    version: z.literal(1),
    binding: z.literal("moderation_decision"),
    characterId: z.string().min(1),
    moderationDecisionId: z.string().min(1),
    previousRemovalEventId: z.string().min(1).nullable(),
  })
  .strict();

// SPEC: An appeal restoration is bound to one immutable removal event. Chat
// must restore only the sessions captured by that event's causal snapshot.
export const characterModerationRestorationPayloadSchema = z
  .object({
    version: z.literal(1),
    binding: z.literal("removal_event"),
    appealId: z.string().min(1),
    characterId: z.string().min(1),
    moderationDecisionId: z.string().min(1),
    removalEventId: z.string().min(1),
  })
  .strict();

export type CharacterModerationRemovedPayload = z.infer<
  typeof characterModerationRemovedPayloadSchema
>;
export type CharacterModerationRestorationPayload = z.infer<
  typeof characterModerationRestorationPayloadSchema
>;

export const chatSessionReleaseMigrationRequestedPayloadSchema = z
  .object({
    commandId: z.string().min(1),
    sessionId: z.string().min(1),
    characterId: z.string().min(1),
    fromCharacterContentVersionId: z.string().min(1).nullable(),
    fromCharacterReleaseId: z.string().min(1).nullable(),
    toCharacterContentVersionId: z.string().min(1),
    toCharacterReleaseId: z.string().min(1).nullable(),
    reason: z.string().trim().min(1).max(1_000),
    compatibilityQa: z
      .object({
        status: z.literal("passed"),
        policyVersion: z.string().trim().min(1),
      })
      .passthrough(),
    requestedById: z.string().min(1),
  })
  .passthrough();

export type ChatSessionReleaseMigrationRequestedPayload = z.infer<
  typeof chatSessionReleaseMigrationRequestedPayloadSchema
>;

export const chatSessionReleaseMigrationAppliedPayloadSchema = z
  .object({
    commandId: z.string().min(1),
    sessionId: z.string().min(1),
    characterId: z.string().min(1),
    fromCharacterContentVersionId: z.string().min(1).nullable(),
    fromCharacterReleaseId: z.string().min(1).nullable(),
    toCharacterContentVersionId: z.string().min(1),
    toCharacterReleaseId: z.string().min(1).nullable(),
    appliedAt: z.iso.datetime(),
  })
  .strict();

export const videoGeneratePayloadSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("video"),
    requestId: z.string(),
    generationJobId: z.string(),
    attemptId: z.string().min(1),
    attemptNo: z.number().int().positive(),
    provider: z.string().trim().min(1),
    userId: z.string(),
    characterId: z.string().nullable(),
    prompt: z.string(),
    negativePrompt: z.string().nullable(),
    controls: z.record(z.string(), z.unknown()),
    seconds: z.number().int().min(1).max(30),
    seed: z.string(),
    model: z.string(),
    outputPrefix: z.string(),
    referenceImages: z.array(generationReferenceImageSchema).optional(),
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

const generationQualityDimensionSchema = z
  .object({
    status: z.enum(["passed", "failed", "unscored"]),
    score: z.number().min(0).max(1).optional(),
    threshold: z.number().min(0).max(1).optional(),
    reason: z.string().optional(),
  })
  .passthrough();

export const generationQualitySchema = z
  .object({
    schemaVersion: z.literal("1"),
    evaluatorVersion: z.string(),
    artifact: generationQualityDimensionSchema,
    faceCount: generationQualityDimensionSchema,
    identity: generationQualityDimensionSchema,
    intent: generationQualityDimensionSchema,
    composition: generationQualityDimensionSchema.optional(),
  })
  .passthrough();

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
    quality: generationQualitySchema.optional(),
  })
  .passthrough();

const aiFinalizeVariantsSchema = z.discriminatedUnion("kind", [
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
      attemptId: z.string().min(1),
      attemptNo: z.number().int().positive(),
      terminalRecordRef: z.string().min(1),
      terminalRecordChecksum: z.string().regex(/^[a-f0-9]{64}$/),
      mode: z.enum(["image", "video"]),
      provider: z.string().min(1).optional(),
      model: z.string().min(1).optional(),
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
      attemptId: z.string().min(1),
      attemptNo: z.number().int().positive(),
      terminalRecordRef: z.string().min(1),
      terminalRecordChecksum: z.string().regex(/^[a-f0-9]{64}$/),
      mode: z.enum(["image", "video"]),
      error: z.object({
        code: z.string(),
        message: z.string(),
        retryable: z.boolean(),
        retryability: z.enum(["retryable", "not_retryable", "operator_retry"]).optional(),
      }),
    })
    .passthrough(),
  // SPEC: the provider outcome is ambiguous — it may have already charged us and
  // produced content we cannot see.
  // INTENT: a separate variant, not a flag on generation.failed. The two demand
  // opposite settlements (failed refunds and retries; unknown holds funds and
  // waits for operator reconciliation), so the finalize switch must fail to
  // compile rather than default an ambiguous outcome into the refunding branch.
  z
    .object({
      version: z.literal(1),
      kind: z.literal("generation.unknown"),
      requestId: z.string(),
      generationJobId: z.string(),
      attemptId: z.string().min(1),
      attemptNo: z.number().int().positive(),
      terminalRecordRef: z.string().min(1),
      terminalRecordChecksum: z.string().regex(/^[a-f0-9]{64}$/),
      mode: z.enum(["image", "video"]),
      error: z.object({
        code: z.string(),
        message: z.string(),
        retryable: z.boolean(),
        retryability: z.enum(["retryable", "not_retryable", "operator_retry"]).optional(),
      }),
    })
    .passthrough(),
  z
    .object({
      version: z.literal(1),
      kind: z.literal("generation.blocked"),
      requestId: z.string(),
      generationJobId: z.string(),
      attemptId: z.string().min(1),
      attemptNo: z.number().int().positive(),
      terminalRecordRef: z.string().min(1),
      terminalRecordChecksum: z.string().regex(/^[a-f0-9]{64}$/),
      mode: z.enum(["image", "video"]),
      policyCode: z.string(),
      message: z.string(),
      layer: z.enum(["input", "output", "provider"]).default("input"),
    })
    .passthrough(),
]).superRefine((payload, context) => {
  if (payload.kind !== "generation.completed") return;
  const requiredPrefix = `${payload.mode}/`;
  payload.assets.forEach((asset, index) => {
    if (!asset.contentType.startsWith(requiredPrefix)) {
      context.addIssue({
        code: "custom",
        path: ["assets", index, "contentType"],
        message: `${payload.mode} finalize assets require ${requiredPrefix}* content type`,
      });
    }
  });
});

// INTENT: migration-window compatibility read. Before generation.unknown existed,
// Gen flattened an ambiguous provider outcome into generation.failed carrying an
// optional error.attemptOutcome: "unknown". Payloads in that shape can still be
// sitting in Redis or the Outbox, so we normalize them here — at the single parse
// boundary — instead of re-checking the legacy flag in each finalize branch.
// Writers only ever emit the new shape. Delete this once no pre-cutover payload
// can still be in flight.
function normalizeLegacyGenerationUnknown(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const payload = value as Record<string, unknown>;
  if (payload.kind !== "generation.failed") return value;
  const error = payload.error;
  if (typeof error !== "object" || error === null || Array.isArray(error)) return value;
  const { attemptOutcome, ...restError } = error as Record<string, unknown>;
  if (attemptOutcome !== "unknown") return value;
  return { ...payload, kind: "generation.unknown", error: restError };
}

export const aiFinalizePayloadSchema = z.preprocess(
  normalizeLegacyGenerationUnknown,
  aiFinalizeVariantsSchema,
);

export type ChatStreamEvent = z.infer<typeof chatStreamEventSchema>;
export type ChatGeneratePayload = z.infer<typeof chatGeneratePayloadSchema>;
export type ChatMemoryExtractPayload = z.infer<typeof chatMemoryExtractPayloadSchema>;
export type ImageGeneratePayload = z.infer<typeof imageGeneratePayloadSchema>;
export type VideoGeneratePayload = z.infer<typeof videoGeneratePayloadSchema>;
export type ChatImageRequestedPayload = z.infer<typeof chatImageRequestedPayloadSchema>;
export type ChatImageAcceptedPayload = z.infer<typeof chatImageAcceptedPayloadSchema>;
export type ChatImageCompletedPayload = z.infer<typeof chatImageCompletedPayloadSchema>;
export type ChatImageFailedPayload = z.infer<typeof chatImageFailedPayloadSchema>;
export type ChatAccountErasureCompletedPayload = z.infer<
  typeof chatAccountErasureCompletedPayloadSchema
>;
export type ChatAccountErasureCompletedV2Payload = z.infer<
  typeof chatAccountErasureCompletedV2PayloadSchema
>;
export type AccountDeletionRequestedV2Payload = z.infer<
  typeof accountDeletionRequestedV2PayloadSchema
>;
export type MemorySyncPayload = z.infer<typeof memorySyncPayloadSchema>;
export type MemoryForgetPayload = z.infer<typeof memoryForgetPayloadSchema>;
export type MemoryRebuildPayload = z.infer<typeof memoryRebuildPayloadSchema>;
export type AiFinalizePayload = z.infer<typeof aiFinalizePayloadSchema>;
