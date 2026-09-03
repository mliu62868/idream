import { z } from "zod";
import { COMPANION_PRODUCT_PROMPT_VERSION } from "./companion-agent-prompt";

// Shared contains only Main ↔ Chat contracts and operator evidence.
export const COMPANION_RUNTIME_PROTOCOL_VERSION = 2 as const;
export const COMPANION_DSH_VERSION = "0.1.1-rc.2" as const;
export const COMPANION_DSH_COMMIT =
  "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e" as const;
export const COMPANION_IGREP_PLUGIN_VERSION = "0.1.0" as const;

/**
 * SPEC: an unquoted terminal memory-search command is not a completed answer.
 * This recognizes the observed pseudo-call, never executes it or strips it into
 * a pretend answer. Ordinary mentions and quoted/code examples remain text.
 */
export function hasUnexecutedMemorySearchPayload(content: string): boolean {
  const match = /(?:^|\n[ \t]*\n) {0,3}\{[ \t]*memory_search[ \t]*:[ \t]*"(?:[^"\\\r\n]|\\[^\r\n])*"[ \t]*\}[ \t]*$/u.exec(content.trimEnd());
  if (!match) return false;
  let fence: string | undefined;
  for (const line of content.slice(0, match.index).split(/\r?\n/u)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (!marker) continue;
    if (!fence) fence = marker;
    else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
  }
  return !fence;
}

const nonEmptyStringSchema = z.string().trim().min(1);
const isoDateTimeSchema = z.string().datetime({ offset: true });
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const nonNegativeIntegerSchema = z.number().int().nonnegative();
const positiveIntegerSchema = z.number().int().positive();
export const companionIgrepVersionSchema = z.string().regex(/^\d+\.\d+\.\d+$/);
const companionRuntimeInstanceSchema = z
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

export const companionMemoryModeSchema = z.enum(["normal", "private"]);
export const companionWorkspaceBuildModeSchema = z.enum(["project", "rebuild"]);

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
    mode: companionWorkspaceBuildModeSchema,
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
    mode: companionWorkspaceBuildModeSchema,
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
 * The outer request budget must dominate every embedded runtime child deadline:
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

/** Stream one canonical rebuild without imposing an aggregate history cap. */
export function createCompanionWorkspaceRebuildBody(
  request: CompanionWorkspaceRebuild,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let phase: "start" | "message_start" | "content" | "message_complete" | "complete" | "done" = "start";
  let messageIndex = 0;
  let contentOffset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (phase === "start") {
        phase = request.messages.length > 0 ? "message_start" : "complete";
        controller.enqueue(encoder.encode(encodeCompanionWorkspaceRebuildFrame({
          protocolVersion: COMPANION_RUNTIME_PROTOCOL_VERSION,
          type: "start",
          scope: "relationship",
          userId: request.userId,
          characterId: request.characterId,
          mode: request.mode,
          messageCount: request.messages.length,
          ...(request.fence ? { fence: request.fence } : {}),
        })));
        return;
      }
      const message = request.messages[messageIndex];
      if (phase === "message_start" && message) {
        contentOffset = 0;
        phase = "content";
        const { content, ...header } = message;
        controller.enqueue(encoder.encode(encodeCompanionWorkspaceRebuildFrame({
          protocolVersion: COMPANION_RUNTIME_PROTOCOL_VERSION,
          type: "message_start",
          message: header,
          contentLength: content.length,
        })));
        return;
      }
      if (phase === "content" && message) {
        const content = message.content.slice(
          contentOffset,
          contentOffset + COMPANION_WORKSPACE_REBUILD_CONTENT_CHUNK_CHARS,
        );
        contentOffset += content.length;
        phase = contentOffset === message.content.length ? "message_complete" : "content";
        controller.enqueue(encoder.encode(encodeCompanionWorkspaceRebuildFrame({
          protocolVersion: COMPANION_RUNTIME_PROTOCOL_VERSION,
          type: "content_chunk",
          content,
        })));
        return;
      }
      if (phase === "message_complete") {
        messageIndex += 1;
        phase = messageIndex < request.messages.length ? "message_start" : "complete";
        controller.enqueue(encoder.encode(encodeCompanionWorkspaceRebuildFrame({
          protocolVersion: COMPANION_RUNTIME_PROTOCOL_VERSION,
          type: "message_complete",
        })));
        return;
      }
      if (phase === "complete") {
        phase = "done";
        controller.enqueue(encoder.encode(encodeCompanionWorkspaceRebuildFrame({
          protocolVersion: COMPANION_RUNTIME_PROTOCOL_VERSION,
          type: "complete",
          messageCount: request.messages.length,
        })));
        return;
      }
      controller.close();
    },
  });
}

/**
 * Stream a canonical transcript directly from a paged authority reader. The
 * caller supplies the pre-counted message total so the receiver can validate
 * completeness without Main retaining the whole history in memory.
 */
export function createCompanionWorkspaceRebuildStream(input: {
  scope: "relationship";
  userId: string;
  characterId: string;
  mode: CompanionWorkspaceBuildMode;
  fence?: CompanionWorkspaceRebuildFence;
  messageCount: number;
  messages: AsyncIterable<CompanionWorkspaceRebuildMessage>;
}): ReadableStream<Uint8Array> {
  if (!Number.isSafeInteger(input.messageCount) || input.messageCount < 0) {
    throw new Error("relationship rebuild messageCount must be a non-negative integer");
  }
  const encoder = new TextEncoder();
  const iterator = input.messages[Symbol.asyncIterator]();
  let phase: "start" | "next" | "content" | "message_complete" | "done" = "start";
  let current: CompanionWorkspaceRebuildMessage | null = null;
  let contentOffset = 0;
  let emitted = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (phase === "start") {
        // Always probe the async source, including an advertised zero. A stale
        // pre-count of zero must not silently certify an empty projection.
        phase = "next";
        controller.enqueue(encoder.encode(encodeCompanionWorkspaceRebuildFrame({
          protocolVersion: COMPANION_RUNTIME_PROTOCOL_VERSION,
          type: "start",
          scope: input.scope,
          userId: input.userId,
          characterId: input.characterId,
          mode: input.mode,
          messageCount: input.messageCount,
          ...(input.fence ? { fence: input.fence } : {}),
        })));
        return;
      }
      if (phase === "next") {
        const next = await iterator.next();
        if (next.done) {
          if (emitted !== input.messageCount) {
            controller.error(new Error("relationship rebuild source count changed while streaming"));
            return;
          }
          phase = "done";
          controller.enqueue(encoder.encode(encodeCompanionWorkspaceRebuildFrame({
            protocolVersion: COMPANION_RUNTIME_PROTOCOL_VERSION,
            type: "complete",
            messageCount: emitted,
          })));
          return;
        }
        if (emitted >= input.messageCount) {
          await iterator.return?.();
          controller.error(new Error("relationship rebuild source count changed while streaming"));
          return;
        }
        current = companionWorkspaceRebuildMessageSchema.parse(next.value);
        contentOffset = 0;
        phase = "content";
        const { content, ...message } = current;
        controller.enqueue(encoder.encode(encodeCompanionWorkspaceRebuildFrame({
          protocolVersion: COMPANION_RUNTIME_PROTOCOL_VERSION,
          type: "message_start",
          message,
          contentLength: content.length,
        })));
        return;
      }
      if (phase === "content" && current) {
        const content = current.content.slice(
          contentOffset,
          contentOffset + COMPANION_WORKSPACE_REBUILD_CONTENT_CHUNK_CHARS,
        );
        contentOffset += content.length;
        phase = contentOffset === current.content.length ? "message_complete" : "content";
        controller.enqueue(encoder.encode(encodeCompanionWorkspaceRebuildFrame({
          protocolVersion: COMPANION_RUNTIME_PROTOCOL_VERSION,
          type: "content_chunk",
          content,
        })));
        return;
      }
      if (phase === "message_complete") {
        emitted += 1;
        current = null;
        phase = "next";
        controller.enqueue(encoder.encode(encodeCompanionWorkspaceRebuildFrame({
          protocolVersion: COMPANION_RUNTIME_PROTOCOL_VERSION,
          type: "message_complete",
        })));
        return;
      }
      controller.close();
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

const probeToolReservationSchema = z.object({
  attemptId: nonEmptyStringSchema,
  callId: nonEmptyStringSchema,
  name: z.enum(["generate_image_async", "edit_last_image"]),
  argumentsDigest: sha256Schema,
}).strict();

const protocolVersionSchema = z.literal(COMPANION_RUNTIME_PROTOCOL_VERSION);

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
    service: z.literal("chat-runtime"),
    ready: z.literal(true),
    checkedAt: isoDateTimeSchema,
    productPromptVersion: z.literal(COMPANION_PRODUCT_PROMPT_VERSION),
    dshVersion: z.literal(COMPANION_DSH_VERSION),
    dshCommit: z.literal(COMPANION_DSH_COMMIT),
    igrepVersion: companionIgrepVersionSchema,
    pluginVersion: z.literal(COMPANION_IGREP_PLUGIN_VERSION),
    instance: companionRuntimeInstanceSchema,
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
    productPromptVersion: z.literal(COMPANION_PRODUCT_PROMPT_VERSION).optional(),
    preparedTurnVersion: positiveIntegerSchema.optional(),
    systemPromptDigest: sha256Schema.optional(),
    soulFingerprint: sha256Schema.optional(),
    runtime: z.literal("embedded_dsh").optional(),
    memoryMode: companionMemoryModeSchema.optional(),
    provider: nonEmptyStringSchema.optional(),
    model: nonEmptyStringSchema.optional(),
    profileDigest: sha256Schema.optional(),
    runtimeInstanceId: z.string().uuid().optional(),
    igrepVersion: companionIgrepVersionSchema.optional(),
    pluginVersion: nonEmptyStringSchema.optional(),
    requestId: nonEmptyStringSchema.optional(),
    actualProvider: nonEmptyStringSchema.optional(),
    memoryOutcome: z.enum(["projected", "pending", "disabled"]),
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
  memoryOutcome: "projected" | "pending" | "disabled" = mode === "private"
    ? "disabled"
    : "projected",
): z.infer<typeof companionProbeDshEvidenceSchema> {
  const evidence = probeRecord(value);
  const prompt = probeRecord(evidence.prompt);
  const execution = probeRecord(evidence.execution);
  const instance = probeRecord(evidence.runtimeInstance);
  const observations = probeRecord(evidence.igrepObservations);
  const wake = probeIgrepMetric(observations.wake);
  const search = probeIgrepMetric(observations.search);
  const memorySearch = probeIgrepMetric(observations.memory);
  const attribution = probeRecord(evidence.attribution);
  const tools = Array.isArray(evidence.tools) ? evidence.tools : [];
  const failures: string[] = [];
  const expectFact = (condition: boolean, field: string) => {
    if (!condition) failures.push(field);
  };

  expectFact(evidence.authority === "dsh_terminal_candidate", "authority");
  expectFact(
    prompt.productPromptVersion === COMPANION_PRODUCT_PROMPT_VERSION,
    "prompt.productPromptVersion",
  );
  expectFact(
    Number.isSafeInteger(prompt.preparedTurnVersion) && Number(prompt.preparedTurnVersion) > 0,
    "prompt.preparedTurnVersion",
  );
  expectFact(
    typeof prompt.systemPromptDigest === "string" && /^[a-f0-9]{64}$/u.test(prompt.systemPromptDigest),
    "prompt.systemPromptDigest",
  );
  expectFact(
    typeof prompt.soulFingerprint === "string" && /^[a-f0-9]{64}$/u.test(prompt.soulFingerprint),
    "prompt.soulFingerprint",
  );
  expectFact(evidence.runtime === "embedded_dsh", "runtime");
  expectFact(evidence.memoryMode === mode, "memoryMode");
  expectFact(
    typeof evidence.profileDigest === "string" && /^[a-f0-9]{64}$/u.test(evidence.profileDigest),
    "profileDigest",
  );
  expectFact(
    typeof evidence.provider === "string" && evidence.provider.length > 0 &&
      typeof evidence.model === "string" && evidence.model.length > 0,
    "providerModel",
  );
  expectFact(
    typeof instance.id === "string" && z.string().uuid().safeParse(instance.id).success &&
      probeIsoDate(instance.startedAt),
    "runtimeInstance",
  );
  expectFact(
    Number.isSafeInteger(execution.steps) && Number(execution.steps) > 0 &&
      Number.isSafeInteger(execution.toolCalls) && Number(execution.toolCalls) >= 0 &&
      Number(execution.toolCalls) === tools.length &&
      tools.every((tool) => probeToolReservationSchema.safeParse(tool).success),
    "execution.tools",
  );
  expectFact(typeof evidence.contentDigest === "string" && /^[a-f0-9]{64}$/u.test(evidence.contentDigest), "contentDigest");
  expectFact(typeof evidence.igrepVersion === "string" && companionIgrepVersionSchema.safeParse(evidence.igrepVersion).success, "igrepVersion");
  expectFact(typeof evidence.pluginVersion === "string" && evidence.pluginVersion.length > 0, "pluginVersion");
  expectFact(wake.valid && search.valid && memorySearch.valid, "igrepObservations");

  if (mode === "normal") {
    expectFact(
      (typeof attribution.requestId === "string" && attribution.requestId.length > 0) ||
        (typeof attribution.actualProvider === "string" && attribution.actualProvider.length > 0),
      "attribution",
    );
    expectFact(wake.calls > 0 && wake.failures === 0, "igrepObservations.wake");
  } else {
    expectFact(
      memoryOutcome === "disabled" &&
        wake.calls === 0 && search.calls === 0 && memorySearch.calls === 0,
      "privateMemoryIsolation",
    );
  }

  return companionProbeDshEvidenceSchema.parse({
    ok: failures.length === 0,
    ...(prompt.productPromptVersion === COMPANION_PRODUCT_PROMPT_VERSION
      ? { productPromptVersion: COMPANION_PRODUCT_PROMPT_VERSION }
      : {}),
    ...(Number.isSafeInteger(prompt.preparedTurnVersion) && Number(prompt.preparedTurnVersion) > 0
      ? { preparedTurnVersion: Number(prompt.preparedTurnVersion) }
      : {}),
    ...(typeof prompt.systemPromptDigest === "string"
      ? { systemPromptDigest: prompt.systemPromptDigest }
      : {}),
    ...(typeof prompt.soulFingerprint === "string"
      ? { soulFingerprint: prompt.soulFingerprint }
      : {}),
    ...(evidence.runtime === "embedded_dsh" ? { runtime: "embedded_dsh" as const } : {}),
    ...(evidence.memoryMode === "normal" || evidence.memoryMode === "private"
      ? { memoryMode: evidence.memoryMode }
      : {}),
    ...(typeof evidence.provider === "string" ? { provider: evidence.provider } : {}),
    ...(typeof evidence.model === "string" ? { model: evidence.model } : {}),
    ...(typeof evidence.profileDigest === "string" ? { profileDigest: evidence.profileDigest } : {}),
    ...(typeof instance.id === "string" ? { runtimeInstanceId: instance.id } : {}),
    ...(typeof evidence.igrepVersion === "string" ? { igrepVersion: evidence.igrepVersion } : {}),
    ...(typeof evidence.pluginVersion === "string" ? { pluginVersion: evidence.pluginVersion } : {}),
    ...(typeof attribution.requestId === "string" ? { requestId: attribution.requestId } : {}),
    ...(typeof attribution.actualProvider === "string" ? { actualProvider: attribution.actualProvider } : {}),
    memoryOutcome,
    wakeCalls: wake.calls,
    wakeFailures: wake.failures,
    igrepSearchCalls: search.calls,
    igrepSearchFailures: search.failures,
    memorySearchCalls: memorySearch.calls,
    memorySearchHits: memorySearch.hits,
    memorySearchEvidenceMatches: memorySearch.evidenceMatches,
    memorySearchFailures: memorySearch.failures,
    error: failures.length === 0
      ? null
      : `DSH ${mode} evidence failed: ${failures.join(", ")}`,
  });
}

function probeIgrepMetric(value: unknown): {
  valid: boolean;
  calls: number;
  hits: number;
  failures: number;
  evidenceMatches: number;
} {
  const metric = probeRecord(value);
  const values = [metric.calls, metric.hits, metric.failures, metric.evidenceMatches];
  const valid = values.every((entry) =>
    typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0
  ) && Number(metric.evidenceMatches) <= 8
    && Number(metric.hits) + Number(metric.failures) <= Number(metric.calls);
  return valid
    ? {
        valid: true,
        calls: Number(metric.calls),
        hits: Number(metric.hits),
        failures: Number(metric.failures),
        evidenceMatches: Number(metric.evidenceMatches),
      }
    : { valid: false, calls: 0, hits: 0, failures: 0, evidenceMatches: 0 };
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

export type CompanionMemoryMode = z.infer<typeof companionMemoryModeSchema>;
export type CompanionWorkspaceRebuild = z.infer<
  typeof companionWorkspaceRebuildSchema
>;
export type CompanionWorkspaceBuildMode = z.infer<
  typeof companionWorkspaceBuildModeSchema
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
export type CompanionReadiness = z.infer<typeof companionReadinessSchema>;
export type CompanionProbeDshEvidence = z.infer<typeof companionProbeDshEvidenceSchema>;
