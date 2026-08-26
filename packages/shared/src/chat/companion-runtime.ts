import { createHash } from "node:crypto";
import { z } from "zod";

// SPEC: This is the only product-facing wire vocabulary between Chat and the
// companion sidecar. Runtime implementation packages must project into it and
// must never export DSH, Cordis, or plugin-owned types across this boundary.
export const COMPANION_RUNTIME_PROTOCOL_VERSION = 1 as const;
export const COMPANION_DSH_VERSION = "0.1.0-rc.7" as const;
export const COMPANION_DSH_COMMIT =
  "99f6f02fecdb7dff40c3fbc9470f5907c29f74ca" as const;
export const COMPANION_IGREP_VERSION = "0.1.132" as const;
export const COMPANION_IGREP_PLUGIN_VERSION = "0.1.0" as const;
export const COMPANION_TERMINAL_CONTENT_MAX_BYTES = 2_097_152;
// JSON can expand control bytes sixfold (`\u00xx`); 16 MiB safely carries the
// largest valid terminal candidate plus protocol metadata.
export const COMPANION_NDJSON_FRAME_MAX_BYTES = 16 * 1_024 * 1_024;

const nonEmptyStringSchema = z.string().trim().min(1);
const isoDateTimeSchema = z.string().datetime({ offset: true });
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const nonNegativeIntegerSchema = z.number().int().nonnegative();
const positiveIntegerSchema = z.number().int().positive();
const companionSidecarInstanceSchema = z
  .object({
    id: z.string().uuid(),
    startedAt: isoDateTimeSchema,
  })
  .strict();
const credentialFreeHttpUrlSchema = z
  .string()
  .url()
  .superRefine((value, context) => {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      context.addIssue({
        code: "custom",
        message: "runtime endpoints must be credential-free HTTP(S) base URLs",
      });
    }
  });

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

const modelFunctionCallSchema = z
  .object({
    id: nonEmptyStringSchema,
    type: z.literal("function"),
    function: z
      .object({
        name: nonEmptyStringSchema,
        arguments: z.string(),
      })
      .strict(),
  })
  .strict();

const preparedMessageBase = {
  id: nonEmptyStringSchema,
  sourceKind: z.enum(["current_user", "replay", "plugin"]),
  content: z.string(),
};

interface ReleasedKnowledgeDigestInput {
  characterId: string;
  characterContentVersionId: string;
  characterReleaseId: string | null;
  files: ReadonlyArray<{ path: "canon.md"; content: string }>;
}

/** Digest the exact released bytes and authority pins carried over the wire. */
export function releasedKnowledgeDigest(input: ReleasedKnowledgeDigestInput): string {
  return createHash("sha256").update(JSON.stringify({
    characterId: input.characterId,
    characterContentVersionId: input.characterContentVersionId,
    characterReleaseId: input.characterReleaseId,
    files: input.files,
  })).digest("hex");
}

export const releasedKnowledgeSnapshotSchema = z
  .object({
    characterId: nonEmptyStringSchema,
    characterContentVersionId: nonEmptyStringSchema,
    characterReleaseId: nonEmptyStringSchema.nullable(),
    digest: sha256Schema,
    // INTENT: Gate M publishes one canonical file. A literal relative name makes
    // path traversal impossible instead of relying on path sanitization.
    files: z.array(z.object({
      path: z.literal("canon.md"),
      content: z.string().min(1),
    }).strict()).max(1),
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (snapshot.characterReleaseId === null && snapshot.files.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["files"],
        message: "unreleased knowledge snapshots must be empty",
      });
    }
    if (snapshot.digest !== releasedKnowledgeDigest(snapshot)) {
      context.addIssue({
        code: "custom",
        path: ["digest"],
        message: "released knowledge digest does not match its pinned bytes",
      });
    }
  });

export const preparedTurnMessageSchema = z.discriminatedUnion("role", [
  z.object({ ...preparedMessageBase, role: z.literal("system") }).strict(),
  z.object({ ...preparedMessageBase, role: z.literal("user") }).strict(),
  z
    .object({
      ...preparedMessageBase,
      role: z.literal("assistant"),
      tool_calls: z.array(modelFunctionCallSchema).min(1).optional(),
    })
    .strict(),
  z
    .object({
      ...preparedMessageBase,
      role: z.literal("tool"),
      tool_call_id: nonEmptyStringSchema,
    })
    .strict(),
]);

export const companionToolNameSchema = z.enum([
  "generate_image_async",
  "edit_last_image",
]);

export const preparedTurnToolDefinitionSchema = z
  .object({
    name: companionToolNameSchema,
    description: nonEmptyStringSchema,
    parameters: jsonObjectSchema,
  })
  .strict();

export const preparedTurnProfileSchema = z
  .object({
    tier: nonEmptyStringSchema,
    adapter: nonEmptyStringSchema,
    provider: nonEmptyStringSchema,
    // INTENT: endpoint identity crosses the wire for attributable execution;
    // credentials remain transport-local and are rejected by this strict shape.
    baseUrl: credentialFreeHttpUrlSchema,
    model: nonEmptyStringSchema,
    supportsTools: z.boolean(),
    maxOutputTokens: positiveIntegerSchema,
    timeout: z
      .object({
        firstTokenMs: positiveIntegerSchema,
        idleMs: positiveIntegerSchema,
        completionMs: positiveIntegerSchema,
      })
      .strict(),
    sampling: z
      .object({
        temperature: z.number().finite().min(0).max(2),
        topP: z.number().finite().gt(0).max(1),
        repetitionPenalty: z.number().finite().gt(0).max(2),
      })
      .strict(),
  })
  .strict();

export const preparedTurnBudgetSchema = z
  .object({
    maxInputTokens: positiveIntegerSchema,
    usedInputTokens: nonNegativeIntegerSchema,
    dropped: z.array(z.literal("transcript")),
  })
  .strict()
  .superRefine((budget, context) => {
    if (budget.usedInputTokens > budget.maxInputTokens) {
      context.addIssue({
        code: "custom",
        path: ["usedInputTokens"],
        message: "used input tokens cannot exceed the prepared turn budget",
      });
    }
    if (new Set(budget.dropped).size !== budget.dropped.length) {
      context.addIssue({
        code: "custom",
        path: ["dropped"],
        message: "budget degradation entries must be unique",
      });
    }
  });

export const preparedTurnTraceSchema = z
  .object({
    characterContentVersionId: nonEmptyStringSchema,
    characterReleaseId: nonEmptyStringSchema.nullable(),
    soulFingerprint: nonEmptyStringSchema,
    compilerVersion: nonEmptyStringSchema,
    sceneVersion: nonNegativeIntegerSchema,
    relationshipVersion: nonNegativeIntegerSchema.nullable(),
    fileContextRevision: z.string().regex(/^\d+$/),
    releasedKnowledgeDigest: sha256Schema,
  })
  .strict();

export const preparedTurnWireSchema = z
  .object({
    version: z.literal(2),
    model: nonEmptyStringSchema,
    characterName: nonEmptyStringSchema,
    messages: z.array(preparedTurnMessageSchema).min(1),
    tools: z.array(preparedTurnToolDefinitionSchema),
    profile: preparedTurnProfileSchema,
    budget: preparedTurnBudgetSchema,
    releasedKnowledge: releasedKnowledgeSnapshotSchema,
    trace: preparedTurnTraceSchema,
  })
  .strict()
  .superRefine((turn, context) => {
    if (turn.model !== turn.profile.model) {
      context.addIssue({
        code: "custom",
        path: ["model"],
        message: "prepared model must equal the pinned profile model",
      });
    }
    if (
      turn.releasedKnowledge.characterContentVersionId !==
        turn.trace.characterContentVersionId ||
      turn.releasedKnowledge.characterReleaseId !== turn.trace.characterReleaseId ||
      turn.releasedKnowledge.digest !== turn.trace.releasedKnowledgeDigest
    ) {
      context.addIssue({
        code: "custom",
        path: ["releasedKnowledge"],
        message: "released knowledge must retain the prepared turn authority pins and digest",
      });
    }
    const currentMessages = turn.messages.filter(
      (message) => message.sourceKind === "current_user",
    );
    if (currentMessages.length !== 1) {
      context.addIssue({
        code: "custom",
        path: ["messages"],
        message: "a prepared turn must contain exactly one current_user message",
      });
    } else if (currentMessages[0]?.role !== "user") {
      context.addIssue({
        code: "custom",
        path: ["messages"],
        message: "the current_user source must be a user message",
      });
    } else if (turn.messages.at(-1)?.id !== currentMessages[0].id) {
      context.addIssue({
        code: "custom",
        path: ["messages"],
        message: "the current_user message must be the final prepared message",
      });
    }
    const ids = turn.messages.map((message) => message.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["messages"],
        message: "prepared message ids must be unique",
      });
    }
    const toolNames = turn.tools.map((tool) => tool.name);
    if (new Set(toolNames).size !== toolNames.length) {
      context.addIssue({
        code: "custom",
        path: ["tools"],
        message: "prepared tool names must be unique",
      });
    }
  });

export const companionMemoryModeSchema = z.enum(["normal", "private"]);

export const companionWorkspaceRebuildMessageSchema = z
  .object({
    id: nonEmptyStringSchema,
    sessionId: nonEmptyStringSchema,
    role: z.enum(["user", "assistant"]),
    content: z.string().min(1),
    createdAt: isoDateTimeSchema,
  })
  .strict();

export const COMPANION_WORKSPACE_REBUILD_CONTENT_CHUNK_CHARS = 16_384;
const companionWorkspaceRebuildMessageHeaderSchema =
  companionWorkspaceRebuildMessageSchema.omit({ content: true });

export const companionWorkspaceRebuildFenceSchema = z.object({
  mutationId: nonEmptyStringSchema,
  claimToken: z.string().uuid(),
  authorityVersion: z.string().regex(/^[1-9]\d*$/),
}).strict();

export const companionWorkspaceRebuildPromotionSchema = z.object({
  scope: z.literal("relationship"),
  userId: nonEmptyStringSchema,
  characterId: nonEmptyStringSchema,
  rebuildId: z.string().uuid(),
  fence: companionWorkspaceRebuildFenceSchema,
}).strict();

export const companionWorkspaceRebuildSchema = z
  .object({
    scope: z.literal("relationship"),
    userId: nonEmptyStringSchema,
    characterId: nonEmptyStringSchema,
    messages: z.array(companionWorkspaceRebuildMessageSchema),
    fence: companionWorkspaceRebuildFenceSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const nextRoleBySession = new Map<string, "user" | "assistant">();
    const completedSessions = new Set<string>();
    let activeSession: string | undefined;
    for (const [index, message] of value.messages.entries()) {
      if (activeSession !== message.sessionId) {
        if (activeSession) completedSessions.add(activeSession);
        if (completedSessions.has(message.sessionId)) {
          context.addIssue({
            code: "custom",
            path: ["messages", index, "sessionId"],
            message: "relationship rebuild sessions must be contiguous",
          });
        }
        activeSession = message.sessionId;
      }
      const expected = nextRoleBySession.get(message.sessionId) ?? "user";
      if (message.role !== expected) {
        context.addIssue({
          code: "custom",
          path: ["messages", index, "role"],
          message: `relationship rebuild expected ${expected} message`,
        });
      }
      nextRoleBySession.set(
        message.sessionId,
        message.role === "user" ? "assistant" : "user",
      );
    }
    for (const [sessionId, expected] of nextRoleBySession) {
      if (expected === "user") continue;
      context.addIssue({
        code: "custom",
        path: ["messages"],
        message: `relationship rebuild session ${sessionId} has an incomplete exchange`,
      });
    }
  });

/**
 * SPEC: relationship rebuilds cross the process boundary as bounded NDJSON
 * frames, terminated by an explicit count. A production prepare carries the
 * durable projector claim/version fence that the separate promotion request
 * must repeat exactly. The stream has no aggregate byte or message cap because
 * Chat history is canonical and must remain privacy-rebuildable at any age.
 */
export const companionWorkspaceRebuildFrameSchema = z.discriminatedUnion("type", [
  z.object({
    protocolVersion: z.literal(COMPANION_RUNTIME_PROTOCOL_VERSION),
    type: z.literal("start"),
    scope: z.literal("relationship"),
    userId: nonEmptyStringSchema,
    characterId: nonEmptyStringSchema,
    messageCount: nonNegativeIntegerSchema,
    fence: companionWorkspaceRebuildFenceSchema.optional(),
  }).strict(),
  z.object({
    protocolVersion: z.literal(COMPANION_RUNTIME_PROTOCOL_VERSION),
    type: z.literal("message_start"),
    message: companionWorkspaceRebuildMessageHeaderSchema,
    contentLength: positiveIntegerSchema,
  }).strict(),
  z.object({
    protocolVersion: z.literal(COMPANION_RUNTIME_PROTOCOL_VERSION),
    type: z.literal("content_chunk"),
    content: z.string().min(1).max(COMPANION_WORKSPACE_REBUILD_CONTENT_CHUNK_CHARS),
  }).strict(),
  z.object({
    protocolVersion: z.literal(COMPANION_RUNTIME_PROTOCOL_VERSION),
    type: z.literal("message_complete"),
  }).strict(),
  z.object({
    protocolVersion: z.literal(COMPANION_RUNTIME_PROTOCOL_VERSION),
    type: z.literal("complete"),
    messageCount: nonNegativeIntegerSchema,
  }).strict(),
]);

const COMPANION_WORKSPACE_REBUILD_INGEST_BASE_TIMEOUT_MS = 30_000;
const COMPANION_WORKSPACE_REBUILD_INGEST_PER_MIB_MS = 5_000;
const COMPANION_WORKSPACE_REBUILD_FIXED_TIMEOUT_MS = 370_000;
export const COMPANION_WORKSPACE_REBUILD_MAX_TIMEOUT_MS = 2_000_000_000;

export function companionWorkspaceRebuildSessionIngestTimeoutMs(
  estimatedBytes: number,
): number {
  return COMPANION_WORKSPACE_REBUILD_INGEST_BASE_TIMEOUT_MS
    + Math.ceil(Math.max(0, estimatedBytes) / 1_048_576)
    * COMPANION_WORKSPACE_REBUILD_INGEST_PER_MIB_MS;
}

export function companionWorkspaceRebuildMetrics(input: {
  messages: readonly CompanionWorkspaceRebuildMessage[];
}): { messageCount: number; sessionCount: number; estimatedBytes: number } {
  const sessions = new Set<string>();
  let estimatedBytes = 0;
  for (const message of input.messages) {
    sessions.add(message.sessionId);
    // JSON escaping can expand one UTF-16 code unit (for example U+0000 or an
    // unpaired surrogate) to six ASCII bytes. This remains an allocation-free
    // upper bound for the staged transcript and its transport frames.
    estimatedBytes += 256 + 6 * (
      message.id.length
      + message.sessionId.length
      + message.content.length
      + message.createdAt.length
    );
  }
  return {
    messageCount: input.messages.length,
    sessionCount: sessions.size,
    estimatedBytes,
  };
}

/**
 * The outer request budget must dominate every sidecar child deadline:
 * size-aware ingest + 300s maintain + 30s doctor + 10s status + 30s transport.
 * Six bytes per UTF-16 code unit covers the worst JSON escape expansion.
 */
export function companionWorkspaceRebuildBudget(input: {
  messageCount: number;
  sessionCount: number;
  estimatedBytes: number;
}): { totalIngestTimeoutMs: number; totalTimeoutMs: number } {
  const totalIngestTimeoutMs = input.messageCount === 0
    ? 0
    : COMPANION_WORKSPACE_REBUILD_INGEST_BASE_TIMEOUT_MS * input.sessionCount
      + COMPANION_WORKSPACE_REBUILD_INGEST_PER_MIB_MS * (
        input.sessionCount
        + Math.ceil(Math.max(0, input.estimatedBytes) / 1_048_576)
      );
  return {
    totalIngestTimeoutMs,
    totalTimeoutMs: Math.min(
      COMPANION_WORKSPACE_REBUILD_MAX_TIMEOUT_MS,
      totalIngestTimeoutMs + COMPANION_WORKSPACE_REBUILD_FIXED_TIMEOUT_MS,
    ),
  };
}

/** Encode one strictly validated relationship-rebuild frame. */
export function encodeCompanionWorkspaceRebuildFrame(
  frame: CompanionWorkspaceRebuildFrame,
): string {
  return `${JSON.stringify(companionWorkspaceRebuildFrameSchema.parse(frame))}\n`;
}

/** Decode exactly one relationship-rebuild frame. */
export function decodeCompanionWorkspaceRebuildFrame(
  line: string,
): CompanionWorkspaceRebuildFrame {
  let value = line;
  if (value.endsWith("\r\n")) value = value.slice(0, -2);
  else if (value.endsWith("\n")) value = value.slice(0, -1);
  if (!value || value.includes("\n") || value.includes("\r")) {
    throw new Error("expected exactly one relationship rebuild NDJSON frame");
  }
  return companionWorkspaceRebuildFrameSchema.parse(JSON.parse(value));
}

const companionWorkspaceVersionSchema = z.string().regex(
  /^(?:(?:rebuild|commit|migrated)-\d+-)?[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$|^initial-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/,
);

const companionMemoryRecallParitySummarySchema = z.object({
  probeSetChecksum: sha256Schema,
  total: nonNegativeIntegerSchema,
  passed: nonNegativeIntegerSchema,
}).strict().superRefine((value, context) => {
  if (value.passed !== value.total) {
    context.addIssue({ code: "custom", message: "recall parity is incomplete" });
  }
});

const companionMemoryRecallParityProofSchema = companionMemoryRecallParitySummarySchema.extend({
  probes: z.array(z.object({
    probeId: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
    queryHash: sha256Schema,
    legacyExpectedHash: sha256Schema,
    recallContextHash: sha256Schema,
    hitCount: nonNegativeIntegerSchema,
  }).strict()).max(100),
}).strict().superRefine((value, context) => {
  if (value.probes.length !== value.total) {
    context.addIssue({ code: "custom", message: "recall parity probes are incomplete" });
  }
});

export const companionMemoryCutoverProofSchema = z.object({
  schemaVersion: z.literal(1),
  status: z.literal("cutover_ready"),
  mode: z.enum(["imported", "empty"]),
  legacySourceChecksum: sha256Schema,
  importChecksum: sha256Schema,
  igrepVersion: z.literal(COMPANION_IGREP_VERSION),
  cutoverWorkspaceVersion: companionWorkspaceVersionSchema,
  workspaceVersion: companionWorkspaceVersionSchema,
  recallParity: companionMemoryRecallParitySummarySchema,
  completedAt: isoDateTimeSchema,
}).strict().superRefine((value, context) => {
  if ((value.mode === "empty") !== (value.recallParity.total === 0)) {
    context.addIssue({
      code: "custom",
      path: ["recallParity"],
      message: "empty and imported cutover proofs require different parity evidence",
    });
  }
});

export const companionMemoryCutoverSidecarProofSchema = z.object({
  entries: nonNegativeIntegerSchema,
  legacySourceChecksum: sha256Schema,
  checksum: sha256Schema,
  igrepVersion: z.literal(COMPANION_IGREP_VERSION),
  cutoverWorkspaceVersion: companionWorkspaceVersionSchema,
  workspaceVersion: companionWorkspaceVersionSchema,
  status: z.literal("cutover_ready"),
  recallParity: companionMemoryRecallParityProofSchema,
  completedAt: isoDateTimeSchema,
}).strict().superRefine((value, context) => {
  if ((value.entries === 0) !== (value.recallParity.total === 0)) {
    context.addIssue({
      code: "custom",
      path: ["recallParity"],
      message: "empty and imported sidecar proofs require different parity evidence",
    });
  }
});
export const companionInvocationSchema = z
  .object({
    invocationId: nonEmptyStringSchema,
    attemptId: nonEmptyStringSchema,
    sessionId: nonEmptyStringSchema,
    userId: nonEmptyStringSchema,
    characterId: nonEmptyStringSchema,
    preparedTurn: preparedTurnWireSchema,
    memoryMode: companionMemoryModeSchema,
    expectedProfileDigest: sha256Schema,
    deadlineAt: isoDateTimeSchema,
  })
  .strict()
  .superRefine((invocation, context) => {
    if (invocation.preparedTurn.releasedKnowledge.characterId !== invocation.characterId) {
      context.addIssue({
        code: "custom",
        path: ["preparedTurn", "releasedKnowledge", "characterId"],
        message: "released knowledge must belong to the invoked character",
      });
    }
  });

const generateImageArgumentsSchema = z
  .object({
    prompt: z.string().trim().min(12).max(1_200),
    caption: z.string().trim().min(1).max(500).optional(),
    orientation: z.enum(["4:5", "1:1", "16:9"]).optional(),
    outputCount: z.number().int().min(1).max(4).optional(),
  })
  .strict();

const editLastImageArgumentsSchema = z
  .object({
    instruction: z.string().trim().min(4).max(1_200),
    caption: z.string().trim().min(1).max(300).optional(),
  })
  .strict();

const companionToolIdentity = {
  attemptId: nonEmptyStringSchema,
  callId: nonEmptyStringSchema,
};

export const companionToolCallSchema = z.discriminatedUnion("name", [
  z
    .object({
      ...companionToolIdentity,
      name: z.literal("generate_image_async"),
      arguments: generateImageArgumentsSchema,
    })
    .strict(),
  z
    .object({
      ...companionToolIdentity,
      name: z.literal("edit_last_image"),
      arguments: editLastImageArgumentsSchema,
    })
    .strict(),
]);

// INVARIANT: durable/public attempt traces contain only effect identity and a
// canonical argument digest. Raw prompts, captions and edit instructions stay
// inside the live Chat↔sidecar call boundary.
export const companionToolReservationSchema = z
  .object({
    ...companionToolIdentity,
    name: companionToolNameSchema,
    argumentsDigest: sha256Schema,
  })
  .strict();

const companionToolResultIdentity = {
  ...companionToolIdentity,
  name: companionToolNameSchema,
};

const companionErrorSchema = z
  .object({
    code: nonEmptyStringSchema,
    message: nonEmptyStringSchema,
    retryable: z.boolean(),
  })
  .strict();

export const companionToolResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      ...companionToolResultIdentity,
      outcome: z.literal("succeeded"),
      output: jsonValueSchema,
    })
    .strict(),
  z
    .object({
      ...companionToolResultIdentity,
      outcome: z.literal("failed"),
      error: companionErrorSchema,
    })
    .strict(),
  z
    .object({
      ...companionToolResultIdentity,
      outcome: z.literal("unknown"),
      error: companionErrorSchema,
    })
    .strict(),
]);

export const companionUsageSchema = z
  .object({
    promptTokens: nonNegativeIntegerSchema,
    completionTokens: nonNegativeIntegerSchema,
    reasoningTokens: nonNegativeIntegerSchema,
  })
  .strict();

export const companionTerminalCandidateSchema = z
  .object({
    attemptId: nonEmptyStringSchema,
    content: z.string().min(1).superRefine((value, context) => {
      if (new TextEncoder().encode(value).byteLength > COMPANION_TERMINAL_CONTENT_MAX_BYTES) {
        context.addIssue({ code: "custom", message: "terminal candidate content exceeds wire limit" });
      }
    }),
    finishReason: z.enum(["stop", "length"]),
    provider: nonEmptyStringSchema,
    model: nonEmptyStringSchema,
    usage: companionUsageSchema,
    execution: z
      .object({
        steps: positiveIntegerSchema,
        toolCalls: nonNegativeIntegerSchema,
      })
      .strict(),
    completedAt: isoDateTimeSchema,
    attribution: z
      .object({
        requestId: nonEmptyStringSchema.optional(),
        actualProvider: nonEmptyStringSchema.optional(),
      })
      .strict()
      .refine(
        (value) => value.requestId !== undefined || value.actualProvider !== undefined,
        "provider attribution must contain a request id or actual provider",
      )
      .optional(),
  })
  .strict();

export const companionCommitAckSchema = z.discriminatedUnion("accepted", [
  z
    .object({
      attemptId: nonEmptyStringSchema,
      accepted: z.literal(true),
      status: z.enum(["committed", "duplicate"]),
      terminalMessageId: nonEmptyStringSchema,
      committedAt: isoDateTimeSchema,
    })
    .strict(),
  z
    .object({
      attemptId: nonEmptyStringSchema,
      accepted: z.literal(false),
      status: z.literal("rejected"),
      error: z
        .object({
          code: nonEmptyStringSchema,
          message: nonEmptyStringSchema,
        })
        .strict(),
    })
    .strict(),
]);

const companionEventIdentity = {
  invocationId: nonEmptyStringSchema,
  attemptId: nonEmptyStringSchema,
  sequence: positiveIntegerSchema,
  occurredAt: isoDateTimeSchema,
};

export const companionEventSchema = z
  .discriminatedUnion("type", [
    z
      .object({
        ...companionEventIdentity,
        type: z.literal("started"),
        instance: companionSidecarInstanceSchema,
        profileDigest: sha256Schema,
      })
      .strict(),
    z
      .object({
        ...companionEventIdentity,
        type: z.literal("text_delta"),
        delta: z.string().min(1),
      })
      .strict(),
    z
      .object({
        ...companionEventIdentity,
        type: z.literal("reasoning_usage"),
        reasoningTokens: nonNegativeIntegerSchema,
      })
      .strict(),
    z
      .object({
        ...companionEventIdentity,
        type: z.literal("tool_started"),
        callId: nonEmptyStringSchema,
        name: companionToolNameSchema,
      })
      .strict(),
    z
      .object({
        ...companionEventIdentity,
        type: z.literal("tool_finished"),
        callId: nonEmptyStringSchema,
        name: companionToolNameSchema,
        outcome: z.enum(["succeeded", "failed", "unknown"]),
        durationMs: nonNegativeIntegerSchema,
      })
      .strict(),
    z
      .object({
        ...companionEventIdentity,
        type: z.literal("usage"),
        usage: companionUsageSchema,
      })
      .strict(),
    z
      .object({
        ...companionEventIdentity,
        type: z.literal("igrep_observation"),
        operation: z.enum(["wake", "search", "memory"]),
        outcome: z.enum(["hit", "empty", "failure"]),
        resultCount: nonNegativeIntegerSchema.optional(),
        evidenceMatches: nonNegativeIntegerSchema.max(8).optional(),
        durationMs: nonNegativeIntegerSchema,
      })
      .strict(),
    z.object({ ...companionEventIdentity, type: z.literal("heartbeat") }).strict(),
    z
      .object({
        ...companionEventIdentity,
        type: z.literal("terminal_candidate"),
        candidate: companionTerminalCandidateSchema,
      })
      .strict(),
    z
      .object({
        ...companionEventIdentity,
        type: z.literal("failed"),
        error: companionErrorSchema,
      })
      .strict(),
    z
      .object({
        ...companionEventIdentity,
        type: z.literal("cancelled"),
        reason: z.enum(["user", "timeout", "shutdown", "transport"]),
      })
      .strict(),
  ])
  .superRefine((event, context) => {
    if (
      event.type === "terminal_candidate" &&
      event.candidate.attemptId !== event.attemptId
    ) {
      context.addIssue({
        code: "custom",
        path: ["candidate", "attemptId"],
        message: "terminal candidate must retain the event attempt identity",
      });
    }
    if (event.type === "igrep_observation") {
      const expected = event.outcome === "hit"
        ? (event.resultCount ?? 0) > 0
        : event.outcome === "empty"
          ? event.resultCount === 0
          : event.resultCount === undefined;
      if (!expected) {
        context.addIssue({
          code: "custom",
          path: ["resultCount"],
          message: "igrep result count must prove the declared outcome",
        });
      }
      if (
        event.evidenceMatches !== undefined &&
        (event.operation !== "memory" || event.outcome !== "hit")
      ) {
        context.addIssue({
          code: "custom",
          path: ["evidenceMatches"],
          message: "audit evidence matches are valid only for successful memory search results",
        });
      }
    }
  });

const protocolVersionSchema = z.literal(COMPANION_RUNTIME_PROTOCOL_VERSION);

export const companionRuntimeRequestSchema = z.discriminatedUnion("type", [
  z
    .object({
      protocolVersion: protocolVersionSchema,
      type: z.literal("run"),
      invocation: companionInvocationSchema,
    })
    .strict(),
  z
    .object({
      protocolVersion: protocolVersionSchema,
      type: z.literal("cancel"),
      invocationId: nonEmptyStringSchema,
      reason: z.enum(["user", "timeout", "shutdown", "transport"]),
    })
    .strict(),
  z
    .object({
      protocolVersion: protocolVersionSchema,
      type: z.literal("tool_result"),
      invocationId: nonEmptyStringSchema,
      result: companionToolResultSchema,
    })
    .strict(),
  z
    .object({
      protocolVersion: protocolVersionSchema,
      type: z.literal("commit_ack"),
      invocationId: nonEmptyStringSchema,
      ack: companionCommitAckSchema,
    })
    .strict(),
]);

export const companionRuntimeResponseSchema = z
  .discriminatedUnion("type", [
    z
      .object({
        protocolVersion: protocolVersionSchema,
        type: z.literal("event"),
        invocationId: nonEmptyStringSchema,
        event: companionEventSchema,
      })
      .strict(),
    z
      .object({
        protocolVersion: protocolVersionSchema,
        type: z.literal("tool_call"),
        invocationId: nonEmptyStringSchema,
        call: companionToolCallSchema,
      })
      .strict(),
    z
      .object({
        protocolVersion: protocolVersionSchema,
        type: z.literal("commit"),
        invocationId: nonEmptyStringSchema,
        candidate: companionTerminalCandidateSchema,
      })
      .strict(),
  ])
  .superRefine((frame, context) => {
    if (frame.type === "event" && frame.event.invocationId !== frame.invocationId) {
      context.addIssue({
        code: "custom",
        path: ["event", "invocationId"],
        message: "event must retain the frame invocation identity",
      });
    }
  });

export const companionNdjsonFrameSchema = z.union([
  companionRuntimeRequestSchema,
  companionRuntimeResponseSchema,
]);

/** Encode one validated frame. The trailing newline is the NDJSON delimiter. */
export function encodeCompanionNdjsonFrame(frame: CompanionNdjsonFrame): string {
  return `${JSON.stringify(companionNdjsonFrameSchema.parse(frame))}\n`;
}

/** Decode exactly one frame so concatenated or partial protocol input fails loud. */
export function decodeCompanionNdjsonFrame(line: string): CompanionNdjsonFrame {
  let value = line;
  if (value.endsWith("\r\n")) value = value.slice(0, -2);
  else if (value.endsWith("\n")) value = value.slice(0, -1);
  if (!value || value.includes("\n") || value.includes("\r")) {
    throw new Error("expected exactly one NDJSON frame");
  }
  return companionNdjsonFrameSchema.parse(JSON.parse(value));
}

const companionNormalReadyProfileSchema = z
  .object({
    name: z.literal("normal"),
    loaded: z.literal(true),
    executionCompositionDigest: sha256Schema,
    capabilities: z
      .object({
        memoryRead: z.literal(true),
        memoryWrite: z.literal(true),
        tools: z.literal(true),
        commit: z.literal(true),
      })
      .strict(),
  })
  .strict();

const companionPrivateReadyProfileSchema = z
  .object({
    name: z.literal("private"),
    loaded: z.literal(true),
    executionCompositionDigest: sha256Schema,
    capabilities: z
      .object({
        memoryRead: z.literal(false),
        memoryWrite: z.literal(false),
        tools: z.literal(true),
        commit: z.literal(true),
      })
      .strict(),
  })
  .strict();

export const companionReadinessSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    service: z.literal("dsh-companion"),
    ready: z.literal(true),
    checkedAt: isoDateTimeSchema,
    dshVersion: z.literal(COMPANION_DSH_VERSION),
    dshCommit: z.literal(COMPANION_DSH_COMMIT),
    igrepVersion: z.literal(COMPANION_IGREP_VERSION),
    pluginVersion: z.literal(COMPANION_IGREP_PLUGIN_VERSION),
    instance: companionSidecarInstanceSchema,
    provider: z
      .object({
        name: nonEmptyStringSchema,
        baseUrl: credentialFreeHttpUrlSchema,
        model: nonEmptyStringSchema,
        resolved: z.literal(true),
      })
      .strict(),
    profiles: z
      .object({
        normal: companionNormalReadyProfileSchema,
        private: companionPrivateReadyProfileSchema,
      })
      .strict(),
    bridges: z
      .object({
        toolReachable: z.literal(true),
        commitReachable: z.literal(true),
        workspaceRebuildReachable: z.literal(true),
      })
      .strict(),
    verification: z
      .object({
        duplicateIngest: z
          .object({
            replayedSessions: positiveIntegerSchema,
            duplicateDialogueFiles: z.literal(0),
          })
          .strict(),
        crossScope: z
          .object({
            probes: positiveIntegerSchema,
            leakedResults: z.literal(0),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

/** Content-free Gate-E projection shared by the signed probe and its report consumer. */
export const companionProbeDshEvidenceSchema = z
  .object({
    ok: z.boolean(),
    runtime: nonEmptyStringSchema.optional(),
    memoryBackend: nonEmptyStringSchema.optional(),
    profile: nonEmptyStringSchema.optional(),
    private: z.boolean().optional(),
    assignmentReason: nonEmptyStringSchema.optional(),
    primaryRuntime: nonEmptyStringSchema.optional(),
    terminalStatus: nonEmptyStringSchema.optional(),
    sseTerminal: nonEmptyStringSchema.optional(),
    provider: nonEmptyStringSchema.optional(),
    model: nonEmptyStringSchema.optional(),
    profileDigest: sha256Schema.optional(),
    outputAuthority: nonEmptyStringSchema.optional(),
    requestId: nonEmptyStringSchema.optional(),
    actualProvider: nonEmptyStringSchema.optional(),
    memoryOutcome: nonEmptyStringSchema.optional(),
    memoryIngestOutcome: nonEmptyStringSchema.optional(),
    memorySettledAt: isoDateTimeSchema.optional(),
    memorySettleLagMs: z.number().finite().nonnegative().optional(),
    sidecarInstanceId: z.string().uuid().optional(),
    wakeCalls: nonNegativeIntegerSchema,
    wakeFailures: nonNegativeIntegerSchema,
    igrepSearchCalls: nonNegativeIntegerSchema,
    igrepSearchFailures: nonNegativeIntegerSchema,
    memorySearchCalls: nonNegativeIntegerSchema,
    memorySearchHits: nonNegativeIntegerSchema,
    memorySearchEvidenceMatches: nonNegativeIntegerSchema,
    memorySearchFailures: nonNegativeIntegerSchema,
    error: z.string().nullable(),
  })
  .strict();

/**
 * Project internal attempt trace into the only content-free shape an operator
 * probe may consume. Raw trace objects never cross the public Chat API.
 */
export function projectCompanionProbeDshEvidence(
  value: unknown,
  mode: "normal" | "private",
): z.infer<typeof companionProbeDshEvidenceSchema> {
  const trace = probeRecord(value);
  const runtime = probeRecord(trace.companionRuntime);
  const dsh = probeRecord(trace.dsh);
  const telemetry = probeRecord(trace.primaryTelemetry);
  const memory = probeRecord(telemetry.memory);
  const igrep = probeRecord(telemetry.igrep);
  const wake = probeIgrepMetric(igrep.wake);
  const search = probeIgrepMetric(igrep.search);
  const memorySearch = probeIgrepMetric(igrep.memory);
  const sidecar = probeRecord(telemetry.sidecar);
  const companion = probeRecord(trace.companion);
  const attribution = probeRecord(companion.attribution);
  const expectedProfile = mode === "normal"
    ? "idream-companion-memory"
    : "idream-companion-private";
  const failures: string[] = [];
  const expectFact = (condition: boolean, field: string) => {
    if (!condition) failures.push(field);
  };

  expectFact(runtime.runtime === "dsh", "companionRuntime.runtime");
  expectFact(runtime.memoryBackend === "igrep-dsh", "companionRuntime.memoryBackend");
  expectFact(runtime.profile === expectedProfile, "companionRuntime.profile");
  expectFact(runtime.private === (mode === "private"), "companionRuntime.private");
  expectFact(dsh.memoryMode === mode, "dsh.memoryMode");
  expectFact(
    typeof dsh.profileDigest === "string" && /^[a-f0-9]{64}$/u.test(dsh.profileDigest),
    "dsh.profileDigest",
  );
  expectFact(
    typeof sidecar.profileDigest === "string" && sidecar.profileDigest === dsh.profileDigest,
    "primaryTelemetry.sidecar.profileDigest",
  );
  expectFact(
    telemetry.schemaVersion === 1 && telemetry.runtime === "dsh",
    "primaryTelemetry.runtime",
  );
  expectFact(telemetry.terminalStatus === "sent", "primaryTelemetry.terminalStatus");
  expectFact(telemetry.truncated === false, "primaryTelemetry.truncated");
  expectFact(telemetry.sseTerminal === "done", "primaryTelemetry.sseTerminal");
  expectFact(
    typeof telemetry.provider === "string" && telemetry.provider === dsh.provider &&
      typeof telemetry.model === "string" && telemetry.model === dsh.model,
    "primaryTelemetry.providerModel",
  );

  if (mode === "normal") {
    expectFact(companion.profile === expectedProfile, "companion.profile");
    expectFact(
      memory.outcome === "ingested" || memory.outcome === "ingested_rebuilt",
      "primaryTelemetry.memory.outcome",
    );
    expectFact(
      typeof memory.settleLagMs === "number" &&
        Number.isFinite(memory.settleLagMs) && memory.settleLagMs >= 0,
      "primaryTelemetry.memory.settleLagMs",
    );
    expectFact(
      companion.memoryIngestOutcome === "ingested" ||
        companion.memoryIngestOutcome === "ingested_rebuilt",
      "companion.memoryIngestOutcome",
    );
    expectFact(probeIsoDate(companion.memoryIngestSettledAt), "companion.memoryIngestSettledAt");
    expectFact(
      typeof sidecar.instanceId === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(sidecar.instanceId) &&
        probeIsoDate(sidecar.startedAt),
      "primaryTelemetry.sidecar",
    );
    expectFact(
      (typeof attribution.requestId === "string" && attribution.requestId.length > 0) ||
        (typeof attribution.actualProvider === "string" && attribution.actualProvider.length > 0),
      "companion.attribution",
    );
    expectFact(wake.valid && wake.calls > 0 && wake.failure === 0, "primaryTelemetry.igrep.wake");
  } else {
    expectFact(trace.outputAuthority === "model", "outputAuthority");
    expectFact(memory.outcome === "disabled", "primaryTelemetry.memory.outcome");
    expectFact(
      wake.valid && search.valid && memorySearch.valid &&
        wake.calls === 0 && search.calls === 0 && memorySearch.calls === 0,
      "primaryTelemetry.igrep.private",
    );
  }

  return companionProbeDshEvidenceSchema.parse({
    ok: failures.length === 0,
    ...(runtime.runtime === "dsh" ? { runtime: "dsh" as const } : {}),
    ...(runtime.memoryBackend === "igrep-dsh" ? { memoryBackend: "igrep-dsh" as const } : {}),
    ...(typeof runtime.profile === "string" ? { profile: runtime.profile } : {}),
    ...(typeof runtime.private === "boolean" ? { private: runtime.private } : {}),
    ...(telemetry.runtime === "dsh" ? { primaryRuntime: "dsh" as const } : {}),
    ...(typeof telemetry.terminalStatus === "string" ? { terminalStatus: telemetry.terminalStatus } : {}),
    ...(typeof telemetry.sseTerminal === "string" ? { sseTerminal: telemetry.sseTerminal } : {}),
    ...(typeof telemetry.provider === "string" ? { provider: telemetry.provider } : {}),
    ...(typeof telemetry.model === "string" ? { model: telemetry.model } : {}),
    ...(typeof dsh.profileDigest === "string" ? { profileDigest: dsh.profileDigest } : {}),
    ...(typeof trace.outputAuthority === "string" ? { outputAuthority: trace.outputAuthority } : {}),
    ...(typeof attribution.requestId === "string" ? { requestId: attribution.requestId } : {}),
    ...(typeof attribution.actualProvider === "string" ? { actualProvider: attribution.actualProvider } : {}),
    ...(typeof memory.outcome === "string" ? { memoryOutcome: memory.outcome } : {}),
    ...(typeof companion.memoryIngestOutcome === "string"
      ? { memoryIngestOutcome: companion.memoryIngestOutcome }
      : {}),
    ...(typeof companion.memoryIngestSettledAt === "string"
      ? { memorySettledAt: companion.memoryIngestSettledAt }
      : {}),
    ...(typeof memory.settleLagMs === "number" ? { memorySettleLagMs: memory.settleLagMs } : {}),
    ...(typeof sidecar.instanceId === "string" ? { sidecarInstanceId: sidecar.instanceId } : {}),
    wakeCalls: wake.calls,
    wakeFailures: wake.failure,
    igrepSearchCalls: search.calls,
    igrepSearchFailures: search.failure,
    memorySearchCalls: memorySearch.calls,
    memorySearchHits: memorySearch.hit,
    memorySearchEvidenceMatches: memorySearch.evidenceMatches,
    memorySearchFailures: memorySearch.failure,
    error: failures.length === 0
      ? null
      : `DSH ${mode} evidence failed: ${failures.join(", ")}`,
  });
}

function probeIgrepMetric(value: unknown): {
  valid: boolean;
  calls: number;
  hit: number;
  empty: number;
  failure: number;
  evidenceMatches: number;
} {
  if (value === undefined) {
    return { valid: true, calls: 0, hit: 0, empty: 0, failure: 0, evidenceMatches: 0 };
  }
  const metric = probeRecord(value);
  const evidenceMatches = metric.evidenceMatches ?? 0;
  const values = [metric.calls, metric.hit, metric.empty, metric.failure, evidenceMatches];
  const valid = values.every((entry) =>
    typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0
  ) && Number(evidenceMatches) <= 8
    && metric.calls === Number(metric.hit) + Number(metric.empty) + Number(metric.failure);
  return valid
    ? {
        valid: true,
        calls: Number(metric.calls),
        hit: Number(metric.hit),
        empty: Number(metric.empty),
        failure: Number(metric.failure),
        evidenceMatches: Number(evidenceMatches),
      }
    : { valid: false, calls: 0, hit: 0, empty: 0, failure: 0, evidenceMatches: 0 };
}

function probeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function probeIsoDate(value: unknown): value is string {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) &&
    Number.isFinite(Date.parse(value));
}

export type PreparedTurnMessage = z.infer<typeof preparedTurnMessageSchema>;
export type PreparedTurnProfile = z.infer<typeof preparedTurnProfileSchema>;
export type PreparedTurnWire = z.infer<typeof preparedTurnWireSchema>;
export type ReleasedKnowledgeSnapshot = z.infer<
  typeof releasedKnowledgeSnapshotSchema
>;
export type CompanionMemoryMode = z.infer<typeof companionMemoryModeSchema>;
export type CompanionWorkspaceRebuild = z.infer<
  typeof companionWorkspaceRebuildSchema
>;
export type CompanionWorkspaceRebuildMessage = z.infer<
  typeof companionWorkspaceRebuildMessageSchema
>;
export type CompanionWorkspaceRebuildFence = z.infer<
  typeof companionWorkspaceRebuildFenceSchema
>;
export type CompanionWorkspaceRebuildPromotion = z.infer<
  typeof companionWorkspaceRebuildPromotionSchema
>;
export type CompanionWorkspaceRebuildFrame = z.infer<
  typeof companionWorkspaceRebuildFrameSchema
>;
export type CompanionMemoryCutoverProof = z.infer<
  typeof companionMemoryCutoverProofSchema
>;
export type CompanionMemoryCutoverSidecarProof = z.infer<
  typeof companionMemoryCutoverSidecarProofSchema
>;
export type CompanionInvocation = z.infer<typeof companionInvocationSchema>;
export type CompanionToolName = z.infer<typeof companionToolNameSchema>;
export type CompanionToolCall = z.infer<typeof companionToolCallSchema>;
export type CompanionToolReservation = z.infer<typeof companionToolReservationSchema>;
export type CompanionToolResult = z.infer<typeof companionToolResultSchema>;
export type CompanionUsage = z.infer<typeof companionUsageSchema>;
export type CompanionTerminalCandidate = z.infer<
  typeof companionTerminalCandidateSchema
>;
export type CompanionCommitAck = z.infer<typeof companionCommitAckSchema>;
export type CompanionEvent = z.infer<typeof companionEventSchema>;
export type CompanionRuntimeRequest = z.infer<typeof companionRuntimeRequestSchema>;
export type CompanionRuntimeResponse = z.infer<typeof companionRuntimeResponseSchema>;
export type CompanionNdjsonFrame = z.infer<typeof companionNdjsonFrameSchema>;
export type CompanionReadiness = z.infer<typeof companionReadinessSchema>;
export type CompanionProbeDshEvidence = z.infer<typeof companionProbeDshEvidenceSchema>;
