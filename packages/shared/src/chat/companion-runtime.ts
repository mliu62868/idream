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

const nonEmptyStringSchema = z.string().trim().min(1);
const isoDateTimeSchema = z.string().datetime({ offset: true });
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const nonNegativeIntegerSchema = z.number().int().nonnegative();
const positiveIntegerSchema = z.number().int().positive();
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
        structuredTemperature: z.number().finite().min(0).max(2),
      })
      .strict(),
  })
  .strict();

export const preparedTurnBudgetSchema = z
  .object({
    maxInputTokens: positiveIntegerSchema,
    usedInputTokens: nonNegativeIntegerSchema,
    dropped: z.array(z.enum(["memory", "summary", "transcript"])),
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

export const companionMemoryModeSchema = z.enum(["normal", "private", "shadow"]);

export const companionWorkspaceRebuildMessageSchema = z
  .object({
    id: nonEmptyStringSchema,
    sessionId: nonEmptyStringSchema,
    role: z.enum(["user", "assistant"]),
    content: z.string().min(1),
    createdAt: isoDateTimeSchema,
  })
  .strict();

export const companionWorkspaceRebuildSchema = z
  .object({
    scope: z.literal("relationship"),
    userId: nonEmptyStringSchema,
    characterId: nonEmptyStringSchema,
    messages: z.array(companionWorkspaceRebuildMessageSchema).max(20_000),
  })
  .strict()
  .superRefine((value, context) => {
    const nextRoleBySession = new Map<string, "user" | "assistant">();
    for (const [index, message] of value.messages.entries()) {
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

export const companionInvocationSchema = z
  .object({
    invocationId: nonEmptyStringSchema,
    attemptId: nonEmptyStringSchema,
    sessionId: nonEmptyStringSchema,
    userId: nonEmptyStringSchema,
    characterId: nonEmptyStringSchema,
    preparedTurn: preparedTurnWireSchema,
    memoryMode: companionMemoryModeSchema,
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
    content: z.string().min(1),
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
    z.object({ ...companionEventIdentity, type: z.literal("started") }).strict(),
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
        reason: z.enum(["user", "timeout", "shutdown"]),
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
      reason: z.enum(["user", "timeout", "shutdown"]),
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
    normalizedConfigDigest: sha256Schema,
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
    normalizedConfigDigest: sha256Schema,
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
  })
  .strict();

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
export type CompanionInvocation = z.infer<typeof companionInvocationSchema>;
export type CompanionToolName = z.infer<typeof companionToolNameSchema>;
export type CompanionToolCall = z.infer<typeof companionToolCallSchema>;
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
