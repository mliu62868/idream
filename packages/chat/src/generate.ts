// SPEC: chat.generate worker (design §3 steps 8-14). Build context → stream model
// tokens to Redis → output-moderate → IDEMPOTENT finalize TX (chat.* ledger +
// outbox) → append session.jsonl → enqueue memory.extract.
// INVARIANTS:
//   - idempotent on message.status: already sent/blocked/deleted ⇒ no-op (no double
//     usage, no duplicate selected version).
//   - finalize writes message + selected version + usage + summary + moderation +
//     outbox in ONE transaction (atomic ledger).
//   - session.jsonl append is the agent trace (separate fact; user-visible = PG).
import { createHash } from "node:crypto";
import type { Prisma } from "../generated/client/client.js";
import type { ChatPrismaClient } from "./db.js";
import { chatPrisma, chatProjectorPrisma } from "./db.js";
import { providers } from "./providers.js";
import type { ChatChunk, ChatToolCall, ModelMessage } from "./providers.js";
import type { BuiltContext } from "./context.js";
import {
  prepareCompanionTurn,
  preparedTurnRuntime,
  toPreparedTurnWire,
  type PreparedTurn,
} from "./prepared-turn.js";
import { characterAvailableToUser } from "./character-eligibility.js";
import { appendStreamEvent, streamKey } from "./stream.js";
import { recordOutbox, scheduleOutboxDelivery } from "./outbox.js";
import { createId } from "./id.js";
import { enqueue, type ChatJob } from "./queue.js";
import { logger } from "./logger.js";
import {
  CHAT_CONTEXT_INVALIDATING_FILE_MUTATIONS,
  projectChatFileMutations,
  withTurnAuthority,
} from "./file-mutations.js";
import {
  EDIT_LAST_IMAGE_TOOL,
  findAgentTool,
  GENERATE_IMAGE_ASYNC_TOOL,
  imageToolCaption,
  planAgentToolCall,
  shouldPlanImageTool,
  type AgentToolCallPlan,
  type ImageAgentToolCall,
} from "./agent-tools.js";
import {
  CHAT_QUEUES,
  CHAT_TO_MAIN_EVENTS,
  idempotencyKeys,
  type ChatGeneratePayload,
  type ChatImageRequestedPayload,
  type ChatMemoryExtractPayload,
} from "@idream/shared/contracts";
import {
  ChatModelOutputLimitError,
  noMemoryAuthorityReply,
} from "@idream/shared";
import { runtimeReadiness } from "./runtime-readiness.js";
import { env } from "./env.js";
import {
  pinCompanionRuntimeForAttempt,
  type CompanionAttemptRuntime,
} from "./companion-runtime-selection.js";
import { DshCompanionRuntime } from "./companion-runtime.js";
import { verifiedCompanionProfileDigest } from "./companion-sidecar-readiness.js";
import {
  COMPANION_DSH_COMMIT,
  COMPANION_DSH_VERSION,
  COMPANION_IGREP_PLUGIN_VERSION,
  COMPANION_IGREP_VERSION,
  companionToolCallSchema,
  type CompanionCommitAck,
  type CompanionEvent,
  type CompanionInvocation,
  type CompanionTerminalCandidate,
  type CompanionToolCall,
  type CompanionToolResult,
} from "@idream/shared/chat/companion-runtime";

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export type GeneratePayload = ChatGeneratePayload;

export interface GenerateHooks {
  afterContextBuilt?: (context: BuiltContext) => Promise<void> | void;
  jobAttempt?: Pick<ChatJob, "attemptsMade" | "maxAttempts">;
  projectorPrisma?: ChatPrismaClient;
}

export type GenerateWorkerJob = Pick<
  ChatJob<GeneratePayload>,
  "payload" | "attemptsMade" | "maxAttempts"
>;

/** BullMQ-facing seam: retries reuse the same durable assistant placeholder. */
export async function processGenerateJob(
  job: GenerateWorkerJob,
  prisma: ChatPrismaClient = chatPrisma,
  hooks: GenerateHooks = {},
) {
  return processGenerate(job.payload, prisma, {
    ...hooks,
    jobAttempt: {
      attemptsMade: job.attemptsMade,
      maxAttempts: job.maxAttempts,
    },
  });
}

export async function terminalizeGenerateJobFailure(
  payload: GeneratePayload,
  prisma: ChatPrismaClient = chatPrisma,
): Promise<boolean> {
  const terminalized = await failAssistant(
    prisma,
    payload.assistantMessageId,
  );
  if (!terminalized) return false;
  await appendStreamEvent(streamKey(payload.assistantMessageId), {
    type: "error",
    attempt: payload.attempt,
    code: "generation_retries_exhausted",
    retryable: false,
  }).catch(() => {});
  return true;
}

export async function processGenerate(
  payload: GeneratePayload,
  prisma: ChatPrismaClient = chatPrisma,
  hooks: GenerateHooks = {},
): Promise<{ status: "sent" | "blocked" | "skipped" | "failed" }> {
  const projectorPrisma =
    hooks.projectorPrisma ?? chatProjectorPrisma;
  const assistant = await prisma.message.findUnique({ where: { id: payload.assistantMessageId } });
  if (!assistant) return { status: "skipped" };
  if (
    assistant.role !== "assistant" ||
    assistant.sessionId !== payload.sessionId ||
    assistant.replyToMessageId !== payload.userMessageId
  ) {
    return { status: "skipped" };
  }
  const sourceTurn = await prisma.message.findUnique({
    where: { id: payload.userMessageId },
    select: { role: true, sessionId: true, content: true },
  });
  if (sourceTurn?.role !== "user" || sourceTurn.sessionId !== payload.sessionId) {
    return { status: "skipped" };
  }
  const session = await prisma.chatSession.findUnique({ where: { id: payload.sessionId } });
  if (!session) return { status: "skipped" };
  // Crash recovery: a prior terminal DB commit may still have a pending trace
  // projection. Drain it before treating a terminal assistant as a no-op.
  await projectChatFileMutations(session.userId, projectorPrisma);
  // Idempotency: terminal states are final.
  if (["sent", "blocked", "deleted", "failed"].includes(assistant.status)) return { status: "skipped" };
  if (assistant.attempt !== payload.attempt) return { status: "skipped" };

  if (session.status !== "active") {
    await failAssistant(prisma, payload.assistantMessageId);
    await appendStreamEvent(streamKey(payload.assistantMessageId), {
      type: "error",
      attempt: payload.attempt,
      code: "session_inactive",
      retryable: false,
    }).catch(() => {});
    return { status: "failed" };
  }
  const character = await prisma.chatCharacterView.findUnique({
    where: { characterId: session.characterId },
  });
  if (
    !character ||
    character.age < 18 ||
    !characterAvailableToUser(character, session.userId)
  ) {
    await failAssistant(prisma, payload.assistantMessageId);
    await appendStreamEvent(streamKey(payload.assistantMessageId), {
      type: "error",
      attempt: payload.attempt,
      code: "character_unavailable",
      retryable: false,
    }).catch(() => {});
    return { status: "failed" };
  }
  const turnMemoryEnabled = assistant.memoryAuthority === "enabled";
  const priorRuntimeTrace =
    assistant.runtimeTrace &&
    typeof assistant.runtimeTrace === "object" &&
    !Array.isArray(assistant.runtimeTrace)
      ? assistant.runtimeTrace as Record<string, unknown>
      : null;
  const companionRuntimeConfig = env.COMPANION_RUNTIME_CONFIG;
  const attemptRuntime = pinCompanionRuntimeForAttempt({
    config: companionRuntimeConfig,
    memoryAuthority: turnMemoryEnabled ? "enabled" : "disabled",
    userId: session.userId,
    characterId: session.characterId,
    priorPin: priorRuntimeTrace?.companionRuntime,
  });
  const companionRuntimePin = {
    runtime: attemptRuntime.runtime,
    memoryBackend: attemptRuntime.memoryBackend,
    profile: attemptRuntime.profile,
    private: attemptRuntime.private,
    sidecarUrl: attemptRuntime.sidecarUrl,
    deadlineMs: attemptRuntime.deadlineMs,
    assignment: attemptRuntime.assignment,
  };
  const admissionRuntimeTrace = JSON.parse(JSON.stringify({
    schemaVersion: 1,
    attempt: payload.attempt,
    assistantMessageId: payload.assistantMessageId,
    userMessageId: payload.userMessageId,
    companionRuntime: companionRuntimePin,
  })) as Prisma.InputJsonValue;

  const claimed = await prisma.message.updateMany({
    where: {
      id: payload.assistantMessageId,
      status: { in: ["pending", "generating"] },
      attempt: payload.attempt,
      deletedAt: null,
    },
    data: {
      status: "generating",
      updatedAt: new Date(),
      // Persist the route in the same admission write. A crash before
      // PreparedTurn is built must not let a retry observe a newer cohort.
      ...(!priorRuntimeTrace ? { runtimeTrace: admissionRuntimeTrace } : {}),
    },
  });
  if (claimed.count === 0) return { status: "skipped" };
  let lastHeartbeatAt = Date.now();
  const heartbeat = async (force = false): Promise<void> => {
    const now = Date.now();
    if (!force && now - lastHeartbeatAt < 30_000) return;
    lastHeartbeatAt = now;
    await prisma.message.updateMany({
      where: { id: payload.assistantMessageId, status: "generating", attempt: payload.attempt },
      data: { updatedAt: new Date(now) },
    });
  };

  // The lease belongs to the whole generation lifecycle, not to token flow.
  // First-token latency, tool planning, provider pauses, and moderation can all
  // be silent for longer than the reconciler deadline while work is healthy.
  let heartbeatInFlight = false;
  const heartbeatTimer = setInterval(() => {
    if (heartbeatInFlight) return;
    heartbeatInFlight = true;
    heartbeat(true)
      .catch((error) => logger.warn({ err: error, assistantMessageId: payload.assistantMessageId }, "generation heartbeat failed"))
      .finally(() => {
        heartbeatInFlight = false;
      });
  }, 30_000);
  heartbeatTimer.unref();

  try {
  const key = streamKey(payload.assistantMessageId);
  const prepared = await prepareCompanionTurn({
    prisma,
    userId: session.userId,
    characterId: session.characterId,
    sessionId: session.id,
    turnMemoryEnabled,
    userMessageId: payload.userMessageId,
    genericMemoryBackend:
      attemptRuntime.memoryBackend === "igrep-dsh" ? "runtime" : "legacy",
  });
  const context = preparedTurnRuntime(prepared);
  const authoritativeNoMemoryReply = turnMemoryEnabled
    ? null
    : noMemoryAuthorityReply(sourceTurn.content);
  await hooks.afterContextBuilt?.(context);
  const priorDshTrace = priorRuntimeTrace?.dsh && typeof priorRuntimeTrace.dsh === "object"
    && !Array.isArray(priorRuntimeTrace.dsh)
    ? priorRuntimeTrace.dsh as Record<string, unknown>
    : null;
  const dshProfileDigest = attemptRuntime.runtime === "dsh"
    ? typeof priorDshTrace?.profileDigest === "string"
      && /^[a-f0-9]{64}$/.test(priorDshTrace.profileDigest)
      ? priorDshTrace.profileDigest
      : verifiedCompanionProfileDigest(
          attemptRuntime.sidecarUrl,
          attemptRuntime.private ? "private" : "normal",
        )
    : null;
  const runtimeTraceFacts: Record<string, unknown> = {
    schemaVersion: 1,
    attempt: payload.attempt,
    assistantMessageId: payload.assistantMessageId,
    userMessageId: payload.userMessageId,
    profile: prepared.profile,
    trace: prepared.trace,
    budget: prepared.budget,
    companionRuntime: companionRuntimePin,
    ...(priorRuntimeTrace?.companionTool
      ? { companionTool: priorRuntimeTrace.companionTool }
      : {}),
    ...(attemptRuntime.runtime === "dsh"
      ? {
          dsh: {
            version: COMPANION_DSH_VERSION,
            commit: COMPANION_DSH_COMMIT,
            sessionId: `${payload.assistantMessageId}:${payload.attempt}`,
            igrepVersion: COMPANION_IGREP_VERSION,
            pluginVersion: COMPANION_IGREP_PLUGIN_VERSION,
            profileDigest: dshProfileDigest,
            workspaceKeyHash: digestWorkspaceKey(session.userId, session.characterId),
            memoryMode: attemptRuntime.private ? "private" : "normal",
            provider: prepared.profile.provider,
            model: prepared.profile.model,
          },
        }
      : {}),
    scene: context.scene,
    outputAuthority: authoritativeNoMemoryReply
      ? "no_memory_boundary"
      : "model",
  };
  const runtimeTrace = JSON.parse(
    JSON.stringify(runtimeTraceFacts),
  ) as Prisma.InputJsonValue;
  const attemptVersionId = `mv:${payload.assistantMessageId}:${payload.attempt}`;
  // INVARIANT: every attempt that reaches PreparedTurn records its exact model
  // and immutable content authority even when file memory is disabled or the
  // provider later fails before producing a token.
  await prisma.message.updateMany({
    where: {
      id: payload.assistantMessageId,
      status: "generating",
      attempt: payload.attempt,
    },
    data: { runtimeTrace },
  });
  await prisma.messageVersion.upsert({
    where: { id: attemptVersionId },
    create: {
      id: attemptVersionId,
      messageId: payload.assistantMessageId,
      content: "",
      model: prepared.model,
      selected: false,
      attempt: payload.attempt,
      runtimeTrace,
    },
    update: { runtimeTrace },
  });

  await appendStreamEvent(key, { type: "start", attempt: payload.attempt });

  if (attemptRuntime.runtime === "dsh" && !authoritativeNoMemoryReply) {
    return processDshCompanionTurn({
      prisma,
      projectorPrisma,
      payload,
      session,
      prepared,
      context,
      runtimeTraceFacts,
      attemptRuntime,
      sidecarToken: companionRuntimeConfig.sidecarToken,
      heartbeat,
      key,
      jobAttempt: hooks.jobAttempt,
    });
  }

  const modelMessages = prepared.messages;
  const chunks: string[] = [];
  let seq = 0;
  // Set when the stream died after the user already watched text arrive; the
  // ledger keeps the partial reply and the trace records why it is short.
  let truncated = false;
  // Real token counts, reported by the provider on the terminal chunk. Absent for
  // every locally-authored reply (no-memory boundary, tool caption) and for any
  // stream that never reached `done`, which is what estimateTokens covers.
  let providerUsage: { promptTokens: number; completionTokens: number } | null = null;
  let imageToolCall: ImageAgentToolCall | null = null;
  // metadata.trigger for the attachment (finalize, below): "agent_fc" when the model's
  // native function call produced it, "agent_tool_call" for the legacy regex+planner path.
  let toolCallTrigger: "agent_fc" | "agent_tool_call" = "agent_tool_call";

  const fcEnabled = providers.chat.supportsTools === true && prepared.tools.length > 0;

  const streamDelta = async (delta: string): Promise<void> => {
    await heartbeat();
    seq += 1;
    chunks.push(delta);
    await appendStreamEvent(key, { type: "delta", attempt: payload.attempt, seq, delta });
  };

  // A provider that reports usage wins over the estimate; one that does not
  // leaves providerUsage null and changes nothing.
  const readChunkUsage = (part: ChatChunk): void => {
    if (part.usage) providerUsage = part.usage;
  };

  const streamPlain = async (): Promise<void> => {
    for await (const part of providers.chat.stream(prepared)) {
      readChunkUsage(part);
      if (part.delta) await streamDelta(part.delta);
    }
  };

  const streamCaption = async (toolCall: ImageAgentToolCall): Promise<void> => {
    const reply = imageToolCaption(toolCall, context.persona.name);
    for (const piece of chunk(reply, 96)) await streamDelta(piece);
  };

  // FC follow-up call (behavior contract point 3): when a legal tool call left no
  // prose behind, ask the model for a short in-character line to accompany the photo.
  const streamToolFollowup = async (rawCall: ChatToolCall, toolCall: ImageAgentToolCall): Promise<void> => {
    const followupMessages: ModelMessage[] = [
      ...modelMessages,
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: rawCall.id, type: "function", function: { name: rawCall.name, arguments: rawCall.arguments } }],
      },
      {
        role: "tool",
        tool_call_id: rawCall.id,
        content: JSON.stringify({
          status: "generating",
          note: "The photo is being generated and will be delivered shortly. Respond to the user now with a short in-character message accompanying the incoming photo.",
        }),
      },
    ];
    let reply = "";
    try {
      const completion = await providers.chat.complete({
        ...prepared,
        messages: followupMessages,
        maxTokens: 300,
      });
      reply = completion.content.trim();
    } catch (error) {
      logger.warn(
        { err: error, assistantMessageId: payload.assistantMessageId },
        "chat agent tool follow-up complete() failed; falling back to caption",
      );
    }
    if (!reply) reply = toolCall.arguments.caption?.trim() || imageToolCaption(toolCall, context.persona.name);
    for (const piece of chunk(reply, 96)) await streamDelta(piece);
  };

  // Legacy regex-gate + planner path (pre-FC behavior), used when FC is unavailable
  // and as the safety net when FC is available but the model didn't call the tool.
  const runPlannerFallback = async (): Promise<void> => {
    // policy.imageToolEnabled off (entitlement or character advancedDetails.imageToolEnabled=false)
    // suppresses the tool entirely — not just the FC path, so the legacy planner must not run either.
    if (prepared.tools.length === 0) return;
    if (!shouldPlanImageTool(prepared)) return;
    try {
      const toolPlan = await planAgentToolCall({
        chat: providers.chat,
        model: prepared.model,
        turn: prepared,
      });
      imageToolCall = toolPlan.toolCall;
      toolCallTrigger = "agent_tool_call";
    } catch {
      imageToolCall = null;
    }
  };

  // Legal-tool-call validation shared by the FC path: unknown tool name or a JSON/schema
  // failure is dropped silently (contract point 2) — never thrown.
  const validateToolCall = (rawCall: ChatToolCall): AgentToolCallPlan | null => {
    const tool = findAgentTool(rawCall.name);
    if (!tool) {
      logger.warn(
        { toolName: rawCall.name, assistantMessageId: payload.assistantMessageId },
        "chat agent tool call references unknown tool; ignoring",
      );
      return null;
    }
    try {
      const plan = tool.parseCall(JSON.parse(rawCall.arguments) as unknown);
      if (!plan) {
        logger.warn(
          { toolName: rawCall.name, assistantMessageId: payload.assistantMessageId },
          "chat agent tool call failed args validation; ignoring",
        );
        return null;
      }
      return plan;
    } catch (error) {
      logger.warn(
        { err: error, toolName: rawCall.name, assistantMessageId: payload.assistantMessageId },
        "chat agent tool call has invalid JSON arguments; ignoring",
      );
      return null;
    }
  };

  try {
    if (authoritativeNoMemoryReply) {
      for (const piece of chunk(authoritativeNoMemoryReply, 96)) {
        await streamDelta(piece);
      }
    } else if (fcEnabled) {
      let toolCalls: ChatToolCall[] = [];
      let fellBackAlready = false;
      try {
        for await (const part of providers.chat.stream(prepared)) {
          readChunkUsage(part);
          if (part.toolCalls) toolCalls = part.toolCalls;
          if (part.delta) await streamDelta(part.delta);
        }
      } catch (streamError) {
        if (seq > 0) throw streamError;
        // The FC-enabled call died before any content streamed: fall back to the
        // full legacy path (contract point 5) rather than failing the turn.
        fellBackAlready = true;
        await runPlannerFallback();
        if (imageToolCall) await streamCaption(imageToolCall);
        else await streamPlain();
      }

      const rawCall = toolCalls[0];
      if (rawCall) {
        const plan = validateToolCall(rawCall);
        if (plan) {
          imageToolCall = toolCallFromPlan(plan);
          toolCallTrigger = "agent_fc";
          if (!chunks.join("").trim()) await streamToolFollowup(rawCall, imageToolCall);
        }
        // else: illegal call — ignore it, keep whatever prose already streamed, don't throw.
      } else if (!fellBackAlready) {
        // FC available but returned no tool call: the regex-gate + planner remains the
        // safety net so a missed FC call doesn't silently drop the image path.
        await runPlannerFallback();
        if (imageToolCall && !chunks.join("").trim()) await streamCaption(imageToolCall);
      }
    } else {
      await runPlannerFallback();
      if (imageToolCall) await streamCaption(imageToolCall);
      else await streamPlain();
    }
  } catch (error) {
    const outputLimitReached = error instanceof ChatModelOutputLimitError;
    const retryable = seq === 0 && hasWorkerRetryRemaining(hooks.jobAttempt);
    if (!outputLimitReached) runtimeReadiness.recordTurnFailure(error);
    // A stream that died after the user already watched text arrive keeps what
    // was delivered: erasing a visibly-streamed reply is worse than a short one.
    // An output limit is not that case — the model itself ran out of room, the
    // tail is structurally missing, and the turn stays terminal (retry/regenerate).
    if (seq > 0 && !outputLimitReached) {
      truncated = true;
      logger.warn(
        { err: error, assistantMessageId: payload.assistantMessageId, seq },
        "chat stream dropped mid-reply; finalizing the partial content",
      );
    } else {
      if (!retryable) {
        await failAssistant(prisma, payload.assistantMessageId);
      }
      await appendStreamEvent(key, {
        type: "error",
        attempt: payload.attempt,
        code: outputLimitReached ? "provider_output_limit" : "provider_failed",
        retryable,
      });
      if (seq === 0) throw error instanceof Error ? error : new Error(String(error));
      return { status: "failed" };
    }
  }

  let content = chunks.join("");
  if (!content.trim()) {
    const error = new Error("chat model returned an empty response");
    const retryable = hasWorkerRetryRemaining(hooks.jobAttempt);
    runtimeReadiness.recordTurnFailure(error);
    if (!retryable) {
      await failAssistant(prisma, payload.assistantMessageId);
    }
    await appendStreamEvent(key, {
      type: "error",
      attempt: payload.attempt,
      code: "empty_model_response",
      retryable,
    });
    throw error;
  }
  // The provider answered, so whatever knocked earlier turns over was not a
  // process-wide outage. A locally-authored reply proves nothing about it, and a
  // truncated one is exactly the failure the streak is counting.
  if (!authoritativeNoMemoryReply && !truncated) runtimeReadiness.recordTurnSuccess();

  const model = prepared.model;
  const usage = providerUsage ?? {
    promptTokens: prepared.budget.usedInputTokens,
    completionTokens: estimateTokens(content),
  };
  // Ops must be able to tell a model that chose to stop from a stream that was
  // cut, since only the second one is worth chasing.
  const finalRuntimeTrace = truncated
    ? (JSON.parse(
        JSON.stringify({ ...runtimeTraceFacts, truncated: true }),
      ) as Prisma.InputJsonValue)
    : null;

  // Output moderation (design §3 step 10).
  const moderation = await providers.moderation.check({ targetType: "text", content });
  const blocked = moderation.status === "blocked";
  const traceEntry: Record<string, unknown> | null = turnMemoryEnabled
    ? JSON.parse(JSON.stringify({
        ts: new Date().toISOString(),
        kind: "chat.turn",
        attempt: payload.attempt,
        assistantMessageId: payload.assistantMessageId,
        userMessageId: payload.userMessageId,
        system:
          modelMessages.find((message) => message.role === "system")?.content ??
          "",
        injectedMemories: context.longTermMemories,
        boundaries: context.boundaries,
        rawOutput: content,
        toolCalls: imageToolCall ? [imageToolCall] : [],
        moderation,
        model,
        preparedTurn: {
          trace: prepared.trace,
          budget: prepared.budget,
        },
      })) as Record<string, unknown>
    : null;

  await heartbeat(true);
  const finalized = await finalize({
    prisma,
    payload,
    session,
    content: blocked ? "" : content,
    model,
    usage,
    moderation,
    blocked,
    context,
    imageToolCall,
    toolCallTrigger,
    traceEntry,
    projectorPrisma,
    runtimeTrace: finalRuntimeTrace,
  });
  if (finalized === "stale") {
    await appendStreamEvent(key, {
      type: "error",
      attempt: payload.attempt,
      code: "context_changed",
      retryable: true,
    }).catch(() => {});
    return { status: "failed" };
  }
  if (finalized === "skipped") return { status: "skipped" };

  await appendStreamEvent(key, { type: "done", attempt: payload.attempt, usage });

  // Scene is ordinary session continuity and advances even for an incognito turn.
  // The worker independently gates file memory and relationship writes using the
  // immutable per-turn memoryAuthority captured on the assistant message.
  if (!blocked) {
    await enqueue({
      queue: CHAT_QUEUES.memoryExtract,
      payload: {
        sessionId: session.id,
        assistantMessageId: payload.assistantMessageId,
        userMessageId: payload.userMessageId,
        attempt: payload.attempt,
      } satisfies ChatMemoryExtractPayload,
      dedupeKey: idempotencyKeys.chatMemoryExtract(payload.assistantMessageId, payload.attempt),
    }).catch((error) => {
      // Reconcile scans sent messages whose memory_extracted_attempt lags.
      logger.warn({ err: error, assistantMessageId: payload.assistantMessageId }, "memory extraction enqueue deferred");
    });
  }

  await scheduleOutboxDelivery();
  return { status: blocked ? "blocked" : "sent" };
  } finally {
    clearInterval(heartbeatTimer);
  }
}

interface DshTurnInput {
  prisma: ChatPrismaClient;
  projectorPrisma: ChatPrismaClient;
  payload: GeneratePayload;
  session: FinalizeInput["session"];
  prepared: PreparedTurn;
  context: BuiltContext;
  runtimeTraceFacts: Record<string, unknown>;
  attemptRuntime: CompanionAttemptRuntime;
  sidecarToken: string;
  heartbeat(force?: boolean): Promise<void>;
  key: string;
  jobAttempt: GenerateHooks["jobAttempt"];
}

async function processDshCompanionTurn(
  input: DshTurnInput,
): Promise<{ status: "sent" | "blocked" | "skipped" | "failed" }> {
  const {
    prisma,
    projectorPrisma,
    payload,
    session,
    prepared,
    context,
    runtimeTraceFacts,
    attemptRuntime,
    heartbeat,
    key,
  } = input;
  const attemptId = `${payload.assistantMessageId}:${payload.attempt}`;
  const invocationId = `inv:${attemptId}`;
  const invocation: CompanionInvocation = {
    invocationId,
    attemptId,
    sessionId: payload.sessionId,
    userId: session.userId,
    characterId: session.characterId,
    preparedTurn: toPreparedTurnWire(prepared),
    memoryMode: attemptRuntime.private ? "private" : "normal",
    deadlineAt: new Date(Date.now() + attemptRuntime.deadlineMs).toISOString(),
  };
  const runtime = new DshCompanionRuntime({
    baseUrl: attemptRuntime.sidecarUrl,
    token: input.sidecarToken,
  });
  const chunks: string[] = [];
  let sequence = 0;
  let usage: { promptTokens: number; completionTokens: number } | null = null;
  let reasoningTokens = 0;
  let imageToolCall: ImageAgentToolCall | null = null;
  let toolIdentity: { attemptId: string; callId: string } | null = null;
  const toolResults = new Map<
    string,
    { fingerprint: string; result: CompanionToolResult }
  >();
  const durableToolReservation = companionToolCallSchema.safeParse(
    runtimeTraceFacts.companionTool,
  );
  let commitAck: CompanionCommitAck | null = null;
  let announcedCandidate: CompanionTerminalCandidate | null = null;
  let terminalStatus: "sent" | "blocked" | "skipped" | null = null;
  let committedUsage: { promptTokens: number; completionTokens: number } | null = null;
  let committedTrace: Record<string, unknown> | null = null;

  const emitDelta = async (delta: string): Promise<void> => {
    await heartbeat();
    sequence += 1;
    chunks.push(delta);
    await appendStreamEvent(key, {
      type: "delta",
      attempt: payload.attempt,
      seq: sequence,
      delta,
    });
  };

  const executeTool = async (
    call: CompanionToolCall,
  ): Promise<CompanionToolResult> => {
    const fingerprint = stableJson(call);
    const previous = toolResults.get(call.callId);
    if (previous) {
      if (previous.fingerprint === fingerprint) return previous.result;
      return {
        attemptId: call.attemptId,
        callId: call.callId,
        name: call.name,
        outcome: "unknown",
        error: {
          code: "tool_identity_conflict",
          message: "the same callId was replayed with different arguments",
          retryable: false,
        },
      };
    }
    if (durableToolReservation.success) {
      const reserved = durableToolReservation.data;
      if (reserved.callId !== call.callId || reserved.attemptId !== call.attemptId) {
        return {
          attemptId: call.attemptId,
          callId: call.callId,
          name: call.name,
          outcome: "failed",
          error: {
            code: "tool_limit_reached",
            message: "this attempt already has a durable image-tool reservation",
            retryable: false,
          },
        };
      }
      if (stableJson(reserved) !== fingerprint) {
        return {
          attemptId: call.attemptId,
          callId: call.callId,
          name: call.name,
          outcome: "unknown",
          error: {
            code: "tool_identity_conflict",
            message: "the durable callId reservation has different arguments",
            retryable: false,
          },
        };
      }
      const replayed = findAgentTool(reserved.name)?.parseCall(reserved.arguments);
      if (!replayed) {
        throw new Error("durable companion tool reservation failed Chat schema validation");
      }
      imageToolCall = toolCallFromPlan(replayed);
      toolIdentity = { attemptId: reserved.attemptId, callId: reserved.callId };
      const result: CompanionToolResult = {
        attemptId: call.attemptId,
        callId: call.callId,
        name: call.name,
        outcome: "succeeded",
        output: {
          status: "accepted_for_terminal_commit",
          effectId: `${call.attemptId}:${call.callId}`,
        },
      };
      toolResults.set(call.callId, { fingerprint, result });
      return result;
    }
    const parsed = findAgentTool(call.name)?.parseCall(call.arguments);
    let result: CompanionToolResult;
    if (!parsed) {
      result = {
        attemptId: call.attemptId,
        callId: call.callId,
        name: call.name,
        outcome: "failed",
        error: {
          code: "invalid_tool_arguments",
          message: "tool arguments failed the Chat-owned schema",
          retryable: false,
        },
      };
    } else if (imageToolCall) {
      result = {
        attemptId: call.attemptId,
        callId: call.callId,
        name: call.name,
        outcome: "failed",
        error: {
          code: "tool_limit_reached",
          message: "one image tool effect is allowed per companion turn",
          retryable: false,
        },
      };
    } else {
      imageToolCall = toolCallFromPlan(parsed);
      toolIdentity = { attemptId: call.attemptId, callId: call.callId };
      // SPEC: execution here is a durable reservation. The only external image
      // effect is created later inside Chat's terminal CAS transaction.
      result = {
        attemptId: call.attemptId,
        callId: call.callId,
        name: call.name,
        outcome: "succeeded",
        output: {
          status: "accepted_for_terminal_commit",
          effectId: `${call.attemptId}:${call.callId}`,
        },
      };
      const trace = JSON.parse(JSON.stringify({
        ...runtimeTraceFacts,
        companionTool: { ...toolIdentity, name: call.name, arguments: call.arguments },
      })) as Prisma.InputJsonValue;
      await prisma.message.updateMany({
        where: {
          id: payload.assistantMessageId,
          status: "generating",
          attempt: payload.attempt,
        },
        data: { runtimeTrace: trace },
      });
    }
    toolResults.set(call.callId, { fingerprint, result });
    return result;
  };

  const commit = async (
    candidate: CompanionTerminalCandidate,
  ): Promise<CompanionCommitAck> => {
    if (commitAck) return commitAck;
    if (
      !announcedCandidate ||
      JSON.stringify(announcedCandidate) !== JSON.stringify(candidate)
    ) {
      commitAck = rejectedCommit(
        attemptId,
        "terminal_candidate_not_announced",
        "commit candidate was not the exact stable event previously announced",
      );
      return commitAck;
    }
    if (candidate.content !== chunks.join("")) {
      commitAck = rejectedCommit(
        attemptId,
        "stream_candidate_mismatch",
        "terminal candidate differs from the text delivered over SSE",
      );
      return commitAck;
    }
    if (
      candidate.model !== prepared.model ||
      candidate.provider !== prepared.profile.provider
    ) {
      commitAck = rejectedCommit(
        attemptId,
        "provider_identity_mismatch",
        "terminal candidate differs from the pinned provider profile",
      );
      return commitAck;
    }
    if (candidate.finishReason === "length") {
      commitAck = rejectedCommit(
        attemptId,
        "provider_output_limit",
        "provider stopped at the pinned output limit",
      );
      return commitAck;
    }
    const content = candidate.content;
    const moderation = await providers.moderation.check({
      targetType: "text",
      content,
    });
    const blocked = moderation.status === "blocked";
    const candidateUsage = {
      promptTokens: candidate.usage.promptTokens,
      completionTokens: candidate.usage.completionTokens,
    };
    const committedAt = new Date().toISOString();
    const terminalTrace: Record<string, unknown> = {
      ...runtimeTraceFacts,
      companion: {
        invocationId,
        attemptId,
        profile: attemptRuntime.profile,
        terminalCandidateAt: candidate.completedAt,
        commitAckAt: committedAt,
        memoryIngestOutcome: blocked
          ? "discarded_blocked"
          : attemptRuntime.private
            ? "disabled"
            : "pending",
        execution: candidate.execution,
        usage: candidate.usage,
        ...(candidate.attribution ? { attribution: candidate.attribution } : {}),
        ...(toolIdentity ? { toolIdentity } : {}),
      },
    };
    const traceEntry: Record<string, unknown> | null = attemptRuntime.private
      ? null
      : JSON.parse(JSON.stringify({
          ts: committedAt,
          kind: "chat.turn",
          attempt: payload.attempt,
          assistantMessageId: payload.assistantMessageId,
          userMessageId: payload.userMessageId,
          system: prepared.messages.find((message) => message.role === "system")?.content ?? "",
          injectedMemories: [],
          boundaries: context.boundaries,
          rawOutput: content,
          toolCalls: imageToolCall ? [imageToolCall] : [],
          moderation,
          model: candidate.model,
          runtime: "dsh",
          invocationId,
          preparedTurn: { trace: prepared.trace, budget: prepared.budget },
        })) as Record<string, unknown>;
    await heartbeat(true);
    const finalized = await finalize({
      prisma,
      payload,
      session,
      content: blocked ? "" : content,
      model: candidate.model,
      usage: candidateUsage,
      moderation,
      blocked,
      context,
      imageToolCall,
      toolCallTrigger: "agent_fc",
      toolCallIdentity: toolIdentity,
      traceEntry,
      projectorPrisma,
      runtimeTrace: JSON.parse(JSON.stringify(terminalTrace)) as Prisma.InputJsonValue,
    });
    if (finalized !== "finalized") {
      terminalStatus = finalized === "stale" ? null : "skipped";
      commitAck = rejectedCommit(
        attemptId,
        finalized === "stale" ? "context_changed" : "terminal_cas_conflict",
        "Chat terminal authority rejected the candidate",
      );
      return commitAck;
    }
    terminalStatus = blocked ? "blocked" : "sent";
    committedUsage = candidateUsage;
    committedTrace = terminalTrace;
    commitAck = blocked
      ? rejectedCommit(
          attemptId,
          "output_blocked",
          "terminal output was blocked and must not enter runtime memory",
        )
      : {
          attemptId,
          accepted: true,
          status: "committed",
          terminalMessageId: payload.assistantMessageId,
          committedAt,
        };
    return commitAck;
  };

  let runError: unknown = null;
  const deadlineSignal = AbortSignal.timeout(attemptRuntime.deadlineMs);
  try {
    await runtime.run(invocation, {
      async emit(event: CompanionEvent) {
        switch (event.type) {
          case "text_delta":
            await emitDelta(event.delta);
            return;
          case "usage":
            usage = {
              promptTokens: event.usage.promptTokens,
              completionTokens: event.usage.completionTokens,
            };
            reasoningTokens = event.usage.reasoningTokens;
            return;
          case "reasoning_usage":
            reasoningTokens = event.reasoningTokens;
            return;
          case "terminal_candidate":
            if (announcedCandidate) {
              throw new Error("companion announced more than one terminal candidate");
            }
            announcedCandidate = event.candidate;
            return;
          case "failed":
            throw new Error(`${event.error.code}: ${event.error.message}`);
          case "cancelled":
            throw new Error(`companion invocation cancelled: ${event.reason}`);
          default:
            return;
        }
      },
      executeTool,
      commit,
    }, deadlineSignal);
  } catch (error) {
    runError = error;
    if (deadlineSignal.aborted) {
      await runtime.cancel(invocationId, "timeout").catch(() => {});
    }
  }

  // Match the native persistence invariant: once the user has seen text, a
  // transport/runtime failure may not erase it from the Chat ledger. This is a
  // Chat-authored truncated terminal, never an accepted sidecar commit, so the
  // isolated igrep attempt is still discarded.
  const observedCandidate = announcedCandidate as CompanionTerminalCandidate | null;
  if (
    runError &&
    terminalStatus === null &&
    chunks.join("").trim() &&
    observedCandidate === null &&
    commitAck === null
  ) {
    const content = chunks.join("");
    const moderation = await providers.moderation.check({
      targetType: "text",
      content,
    });
    const blocked = moderation.status === "blocked";
    const partialUsage = usage ?? {
      promptTokens: prepared.budget.usedInputTokens,
      completionTokens: estimateTokens(content),
    };
    const truncatedAt = new Date().toISOString();
    const truncatedTrace: Record<string, unknown> = {
      ...runtimeTraceFacts,
      truncated: true,
      companion: {
        invocationId,
        attemptId,
        profile: attemptRuntime.profile,
        memoryIngestOutcome: "discarded_truncated",
        memoryIngestSettledAt: truncatedAt,
        execution: {
          steps: 1,
          toolCalls: toolResults.size,
        },
        usage: {
          ...partialUsage,
          reasoningTokens,
        },
        failure: runError instanceof Error ? runError.message : String(runError),
      },
    };
    const finalized = await finalize({
      prisma,
      payload,
      session,
      content: blocked ? "" : content,
      model: prepared.model,
      usage: partialUsage,
      moderation,
      blocked,
      context,
      imageToolCall,
      toolCallTrigger: "agent_fc",
      toolCallIdentity: toolIdentity,
      traceEntry: null,
      projectorPrisma,
      runtimeTrace: JSON.parse(JSON.stringify(truncatedTrace)) as Prisma.InputJsonValue,
    });
    if (finalized === "finalized") {
      terminalStatus = blocked ? "blocked" : "sent";
      committedUsage = partialUsage;
      committedTrace = truncatedTrace;
      runtimeReadiness.recordTurnFailure(
        runError instanceof Error ? runError : new Error(String(runError)),
      );
    } else if (finalized === "skipped") {
      terminalStatus = "skipped";
    }
  }

  // These are assigned by callbacks invoked inside runtime.run(); TypeScript's
  // local control-flow analysis cannot observe those writes across the port.
  const settledTrace = committedTrace as Record<string, unknown> | null;
  const settledAck = commitAck as CompanionCommitAck | null;
  if (terminalStatus === "sent" || terminalStatus === "blocked") {
    const priorMemoryOutcome = settledTrace?.companion &&
        typeof settledTrace.companion === "object" &&
        !Array.isArray(settledTrace.companion)
      ? (settledTrace.companion as Record<string, unknown>).memoryIngestOutcome
      : undefined;
    const memoryIngestOutcome = priorMemoryOutcome === "discarded_truncated"
      ? priorMemoryOutcome
      : terminalStatus === "blocked"
        ? "discarded_blocked"
        : attemptRuntime.private
          ? "disabled"
          : runError
            ? "failed"
            : "ingested";
    if (settledTrace) {
      const companion = settledTrace.companion as Record<string, unknown>;
      const finalTrace = JSON.parse(JSON.stringify({
        ...settledTrace,
        companion: {
          ...companion,
          memoryIngestOutcome,
          memoryIngestSettledAt: new Date().toISOString(),
          reasoningTokens,
        },
      })) as Prisma.InputJsonValue;
      await prisma.message.updateMany({
        where: {
          id: payload.assistantMessageId,
          status: terminalStatus,
          attempt: payload.attempt,
        },
        data: { runtimeTrace: finalTrace },
      });
      await prisma.messageVersion.update({
        where: { id: `mv:${payload.assistantMessageId}:${payload.attempt}` },
        data: { runtimeTrace: finalTrace },
      });
    }
    if (runError && terminalStatus === "sent" && memoryIngestOutcome === "discarded_truncated") {
      logger.warn(
        { err: runError, invocationId, assistantMessageId: payload.assistantMessageId },
        "DSH reply finalized as truncated; isolated runtime memory discarded",
      );
    } else if (runError && terminalStatus === "sent") {
      // The provider already produced and Chat committed this candidate. Keep its
      // health evidence independent from the failed post-commit memory promotion.
      runtimeReadiness.recordTurnSuccess();
      runtimeReadiness.recordMemoryPromotionFailure(runError);
      logger.warn(
        { err: runError, invocationId, assistantMessageId: payload.assistantMessageId },
        "DSH turn committed but isolated memory promotion failed",
      );
    } else if (terminalStatus === "sent") {
      runtimeReadiness.recordTurnSuccess();
      if (memoryIngestOutcome === "ingested") {
        runtimeReadiness.recordMemoryPromotionSuccess();
      }
    }
    await appendStreamEvent(key, {
      type: "done",
      attempt: payload.attempt,
      usage: committedUsage ?? usage ?? {
        promptTokens: prepared.budget.usedInputTokens,
        completionTokens: estimateTokens(chunks.join("")),
      },
    });
    if (terminalStatus === "sent") {
      await enqueue({
        queue: CHAT_QUEUES.memoryExtract,
        payload: {
          sessionId: session.id,
          assistantMessageId: payload.assistantMessageId,
          userMessageId: payload.userMessageId,
          attempt: payload.attempt,
        } satisfies ChatMemoryExtractPayload,
        dedupeKey: idempotencyKeys.chatMemoryExtract(
          payload.assistantMessageId,
          payload.attempt,
        ),
      }).catch((error) => {
        logger.warn(
          { err: error, assistantMessageId: payload.assistantMessageId },
          "Scene and relationship extraction enqueue deferred",
        );
      });
    }
    await scheduleOutboxDelivery();
    return { status: terminalStatus };
  }

  if (terminalStatus === "skipped") return { status: "skipped" };
  const retryable = hasWorkerRetryRemaining(input.jobAttempt);
  runtimeReadiness.recordTurnFailure(runError ?? new Error("DSH returned without a terminal commit"));
  if (!retryable) await failAssistant(prisma, payload.assistantMessageId);
  await appendStreamEvent(key, {
    type: "error",
    attempt: payload.attempt,
    code: settledAck && !settledAck.accepted ? settledAck.error.code : "provider_failed",
    retryable,
  });
  throw runError instanceof Error
    ? runError
    : new Error("DSH returned without a terminal commit");
}

function rejectedCommit(
  attemptId: string,
  code: string,
  message: string,
): CompanionCommitAck {
  return {
    attemptId,
    accepted: false,
    status: "rejected",
    error: { code, message },
  };
}

interface FinalizeInput {
  prisma: ChatPrismaClient;
  payload: GeneratePayload;
  session: {
    id: string;
    userId: string;
    characterId: string;
    entryExposureId: string | null;
    entryJourneyId: string | null;
    entryPlacementId: string | null;
  };
  content: string;
  model: string;
  usage: { promptTokens: number; completionTokens: number };
  moderation: { status: string; policyCode?: string; confidence: number };
  blocked: boolean;
  context: BuiltContext;
  imageToolCall: ImageAgentToolCall | null;
  toolCallTrigger: "agent_fc" | "agent_tool_call";
  toolCallIdentity?: { attemptId: string; callId: string } | null;
  traceEntry: Record<string, unknown> | null;
  projectorPrisma: ChatPrismaClient;
  /** Non-null only when the pre-stream trace needs correcting (truncated reply). */
  runtimeTrace: Prisma.InputJsonValue | null;
}

async function finalize(
  input: FinalizeInput,
): Promise<"finalized" | "stale" | "skipped"> {
  const { prisma, payload, session, content, model, usage, moderation, blocked, context, imageToolCall, toolCallTrigger, toolCallIdentity, traceEntry, projectorPrisma, runtimeTrace } = input;

  // Account/session/message privacy operations use the same lock. Re-read all
  // authority after acquiring it so a deleted user turn or session cannot be
  // finalized by a worker that started from an older snapshot.
  return withTurnAuthority(
    {
      userId: session.userId,
      sessionId: session.id,
      prisma,
      projectorPrisma,
    },
    async (tx, recordIntent) => {
    const currentUser = await tx.chatUserView.findUnique({
      where: { userId: session.userId },
    });
    const currentSession = await tx.chatSession.findUnique({
      where: { id: session.id },
    });
    const currentCharacter = await tx.chatCharacterView.findUnique({
      where: { characterId: session.characterId },
    });
    const current = await tx.message.findUnique({
      where: { id: payload.assistantMessageId },
    });
    const sourceTurn = await tx.message.findUnique({
      where: { id: payload.userMessageId },
    });
    const latestInvalidatingMutation = await tx.chatFileMutation.findFirst({
      where: {
        userId: session.userId,
        status: "applied",
        kind: {
          in: [...CHAT_CONTEXT_INVALIDATING_FILE_MUTATIONS],
        },
      },
      orderBy: { sequence: "desc" },
      select: { sequence: true },
    });
    if (
      !currentUser ||
      currentUser.status !== "active" ||
      currentUser.deletedAt ||
      !currentSession ||
      currentSession.userId !== session.userId ||
      currentSession.status !== "active" ||
      currentSession.deletedAt ||
      !currentCharacter ||
      currentCharacter.age < 18 ||
      !characterAvailableToUser(currentCharacter, session.userId) ||
      !current ||
      current.role !== "assistant" ||
      current.sessionId !== currentSession.id ||
      current.replyToMessageId !== payload.userMessageId ||
      current.deletedAt ||
      current.status !== "generating" ||
      current.attempt !== payload.attempt ||
      !sourceTurn ||
      sourceTurn.role !== "user" ||
      sourceTurn.sessionId !== currentSession.id ||
      sourceTurn.deletedAt ||
      sourceTurn.status !== "sent"
    ) {
      return "skipped";
    }
    if (
      currentSession.contextRevision !==
        context.sessionContextRevision ||
      (latestInvalidatingMutation?.sequence ?? 0n) !==
        context.fileContextRevision
    ) {
      await tx.message.updateMany({
        where: {
          id: payload.assistantMessageId,
          status: "generating",
          attempt: payload.attempt,
        },
        data: { status: "failed", content: "" },
      });
      return "stale";
    }

    const tokenCount = usage.completionTokens;
    const updated = await tx.message.updateMany({
      where: { id: payload.assistantMessageId, status: "generating", attempt: payload.attempt },
      data: {
        status: blocked ? "blocked" : "sent",
        content,
        model,
        tokenCount,
        safetyStatus: blocked ? "blocked" : moderation.status === "flagged" ? "flagged" : "passed",
        ...(runtimeTrace ? { runtimeTrace } : {}),
      },
    });
    if (updated.count === 0) return "skipped";

    if (!blocked) {
      // flip previous selected off, add the new selected version
      await tx.messageVersion.updateMany({
        where: { messageId: payload.assistantMessageId, selected: true },
        data: { selected: false },
      });
      await tx.messageVersion.update({
        where: { id: `mv:${payload.assistantMessageId}:${payload.attempt}` },
        data: {
          content,
          model,
          selected: true,
          ...(runtimeTrace ? { runtimeTrace } : {}),
        },
      });

      // usage++ (period = UTC day; free quota is daily, design P0-C)
      const periodStart = startOfUtcDay();
      const periodEnd = startOfNextUtcDay();
      await tx.chatUsage.upsert({
        where: { userId_periodStart: { userId: session.userId, periodStart } },
        update: { messagesUsed: { increment: 1 } },
        create: {
          id: createId("usage"),
          userId: session.userId,
          sessionId: session.id,
          messagesUsed: 1,
          periodStart,
          periodEnd,
        },
      });

      // memorySummary is cleared, not written. What used to live there was the
      // newest turn clamped to 900 chars — a strict subset of the 12 recent
      // messages the prompt already carries verbatim, so it only ever spent
      // tokens restating them. Nulling it here (rather than just not writing)
      // drains rows that still hold a value from before it was dropped;
      // otherwise a frozen summary would be injected into every prompt forever.
      await tx.chatSession.update({
        where: { id: session.id },
        data: { lastMessageAt: new Date(), memorySummary: null },
      });
    }

    // moderation trail (always)
    await tx.chatModerationEvent.create({
      data: {
        id: createId("mod"),
        targetType: "message",
        targetId: payload.assistantMessageId,
        layer: "output",
        status: moderation.status,
        policyCode: moderation.policyCode ?? null,
        confidence: moderation.confidence,
        details: {} as Prisma.InputJsonValue,
      },
    });

    // outbox (chat → main), atomic with the ledger
    if (blocked) {
      await recordOutbox(tx, {
        eventType: CHAT_TO_MAIN_EVENTS.messageBlocked,
        aggregateType: "message",
        aggregateId: payload.assistantMessageId,
        payload: { sessionId: session.id, userId: session.userId, policyCode: moderation.policyCode },
      });
      await recordOutbox(tx, {
        eventType: CHAT_TO_MAIN_EVENTS.safetyFlagged,
        aggregateType: "message",
        aggregateId: payload.assistantMessageId,
        payload: { sessionId: session.id, userId: session.userId, layer: "output", policyCode: moderation.policyCode },
      });
    } else {
      if (sourceTurn?.engagementSessionId && sourceTurn.characterContentVersionId) {
        // The model context is the actual snapshot used by this attempt. A
        // Release may move after the user turn but before the worker starts, so
        // emitting the earlier pointer would create false historical precision.
        const actualContentVersionId = context.persona.characterContentVersionId;
        const actualReleaseId = context.persona.characterReleaseId;
        if (actualContentVersionId) {
          await tx.message.update({
            where: { id: sourceTurn.id },
            data: {
              characterContentVersionId: actualContentVersionId,
              characterReleaseId: actualReleaseId,
            },
          });
          await recordOutbox(tx, {
            eventType: CHAT_TO_MAIN_EVENTS.exchangeCompletedV2,
            schemaVersion: 2,
            aggregateType: "exchange",
            aggregateId: sourceTurn.id,
            payload: {
              exchangeId: sourceTurn.id,
              userMessageId: sourceTurn.id,
              assistantMessageId: payload.assistantMessageId,
              selectedAssistantMessageId: payload.assistantMessageId,
              assistantAttemptNo: payload.attempt,
              isRegeneration: payload.attempt > 1,
              sessionId: session.id,
              engagementSessionId: sourceTurn.engagementSessionId,
              userId: session.userId,
              characterId: session.characterId,
              characterContentVersionId: actualContentVersionId,
              characterReleaseId: actualReleaseId,
              entryExposureId: session.entryExposureId,
              journeyId: session.entryJourneyId,
              placementId: session.entryPlacementId,
            },
          });
        }
      }
      await recordOutbox(tx, {
        eventType: CHAT_TO_MAIN_EVENTS.messageCompleted,
        aggregateType: "message",
        aggregateId: payload.assistantMessageId,
        payload: { sessionId: session.id, userId: session.userId, characterId: session.characterId, model, tokenCount },
      });
      await recordOutbox(tx, {
        eventType: CHAT_TO_MAIN_EVENTS.usageIncremented,
        aggregateType: "user",
        aggregateId: session.userId,
        payload: { sessionId: session.id, delta: 1 },
      });

      // toolPlan re-derives the discriminated plan from imageToolCall so the outbox
      // construction below branches on plan.tool (extended by the edit_last_image arm).
      const toolPlan: AgentToolCallPlan | null = imageToolCall ? planFromToolCall(imageToolCall) : null;
      if (toolPlan) {
        const built = await buildImageRequestFromPlan(toolPlan, tx, session.id);
        const attachmentId = createId("att");
        await tx.messageAttachment.create({
          data: {
            id: attachmentId,
            sessionId: session.id,
            messageId: payload.assistantMessageId,
            kind: "generated_image",
            status: "requesting",
            promptHint: built.promptHint,
            metadata: {
              trigger: toolCallTrigger,
              toolName: built.toolName,
              ...(toolCallIdentity ? { toolCallIdentity } : {}),
              sourceUserMessageId: payload.userMessageId,
              assistantCaption: built.assistantCaption,
              orientation: built.controls.orientation,
              outputCount: built.controls.outputCount,
              ...(context.persona.characterReleaseId
                ? { characterReleaseId: context.persona.characterReleaseId }
                : {}),
              // P5 Task 2: carried so a later confirm/retry (service.ts confirmImageAttachment,
              // which re-emits from this metadata) still targets the same source photo.
              ...(built.controls.sourceImageAssetId ? { editSourceAssetId: built.controls.sourceImageAssetId } : {}),
            } as Prisma.InputJsonValue,
          },
        });
        const imagePayload: ChatImageRequestedPayload & Record<string, unknown> = {
          version: 1,
          kind: "chat.image.requested",
          requestId: createId("chat_img_req"),
          attachmentId,
          sessionId: session.id,
          exchangeId: payload.userMessageId,
          messageId: payload.assistantMessageId,
          userId: session.userId,
          characterId: session.characterId,
          characterReleaseId: context.persona.characterReleaseId ?? undefined,
          promptHint: built.promptHint,
          conversationContext: buildConversationContext(context, content),
          controls: built.controls,
          // Visual passport at request time. Read fresh from persona (not stored on the
          // attachment) so a retry after re-buildContext always carries the CURRENT
          // active profile rather than a value captured earlier in this turn.
          visualProfileId: context.persona.visualProfileId ?? undefined,
          visualProfileVersion: context.persona.visualProfileVersion ?? undefined,
        };
        await recordOutbox(tx, {
          eventType: CHAT_TO_MAIN_EVENTS.imageRequested,
          aggregateType: "message_attachment",
          aggregateId: attachmentId,
          payload: imagePayload,
        });
      }
    }
    if (traceEntry) {
      await recordIntent({
        kind: "trace_append",
        sessionId: session.id,
        entry: traceEntry,
      });
    }
    return "finalized";
    },
  );
}

async function failAssistant(
  prisma: ChatPrismaClient,
  assistantMessageId: string,
): Promise<boolean> {
  const failed = await prisma.message.updateMany({
    where: { id: assistantMessageId, status: { in: ["pending", "generating"] } },
    data: { status: "failed" },
  });
  return failed.count > 0;
}

function hasWorkerRetryRemaining(
  jobAttempt: GenerateHooks["jobAttempt"],
): boolean {
  return jobAttempt === undefined ||
    jobAttempt.attemptsMade + 1 < jobAttempt.maxAttempts;
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
function digestWorkspaceKey(userId: string, characterId: string): string {
  return createHash("sha256")
    .update(`${userId}\0${characterId}`)
    .digest("hex");
}
function clamp(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
function chunk(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [""];
}
// Converts a validated agent tool call plan into the wire shape generate.ts streams/logs.
function toolCallFromPlan(plan: AgentToolCallPlan): ImageAgentToolCall {
  switch (plan.tool) {
    case GENERATE_IMAGE_ASYNC_TOOL:
      return { name: plan.tool, arguments: plan.args };
    case EDIT_LAST_IMAGE_TOOL:
      return { name: plan.tool, arguments: plan.args };
    default: {
      const exhaustive: never = plan;
      throw new Error(`unhandled agent tool plan: ${JSON.stringify(exhaustive)}`);
    }
  }
}

// Inverse of toolCallFromPlan: re-derives the discriminated plan from a resolved
// ImageAgentToolCall (name+arguments already correlated per tool, since it was built by
// toolCallFromPlan or by the FC/planner validation paths). Kept as an explicit switch
// (rather than `{ tool: toolCall.name, args: toolCall.arguments }`) because TS can't
// correlate a union's discriminant with its payload across two independently-typed
// property accesses.
function planFromToolCall(toolCall: ImageAgentToolCall): AgentToolCallPlan {
  switch (toolCall.name) {
    case GENERATE_IMAGE_ASYNC_TOOL:
      return { tool: toolCall.name, args: toolCall.arguments };
    case EDIT_LAST_IMAGE_TOOL:
      return { tool: toolCall.name, args: toolCall.arguments };
    default: {
      const exhaustive: never = toolCall;
      throw new Error(`unhandled agent tool call: ${String(exhaustive)}`);
    }
  }
}

interface ImageRequestFromPlan {
  promptHint: string;
  assistantCaption: string | null;
  controls: { orientation: string; outputCount: number; sourceImageAssetId?: string };
  // The tool this request actually ended up as — distinct from plan.tool when
  // edit_last_image degrades to a fresh generate (no source photo). Recorded on the
  // attachment as metadata.toolName so the trail reflects what actually happened,
  // never a stale "edit_last_image" tag on what is, in fact, a plain generate.
  toolName: typeof GENERATE_IMAGE_ASYNC_TOOL | typeof EDIT_LAST_IMAGE_TOOL;
}

// Shapes the attachment/outbox payload fields per plan.tool. The edit_last_image arm
// looks up the session's most recent completed photo (behavior contract point 1) and,
// when found, carries its mediaAssetId as the img2img source (point 2). No source photo
// degrades to generate_image_async semantics rather than erroring (point 3) — sending a
// fresh image beats failing the turn.
async function buildImageRequestFromPlan(
  plan: AgentToolCallPlan,
  tx: Prisma.TransactionClient,
  sessionId: string,
): Promise<ImageRequestFromPlan> {
  switch (plan.tool) {
    case GENERATE_IMAGE_ASYNC_TOOL:
      return {
        promptHint: plan.args.prompt,
        assistantCaption: plan.args.caption ?? null,
        controls: { orientation: plan.args.orientation, outputCount: plan.args.outputCount },
        toolName: GENERATE_IMAGE_ASYNC_TOOL,
      };
    case EDIT_LAST_IMAGE_TOOL: {
      const source = await tx.messageAttachment.findFirst({
        where: { sessionId, kind: "generated_image", status: "completed", mediaAssetId: { not: null } },
        orderBy: { createdAt: "desc" },
      });
      if (!source?.mediaAssetId) {
        logger.warn(
          { sessionId },
          "edit_last_image: no completed source photo in session; falling back to generate_image_async semantics",
        );
        return {
          promptHint: plan.args.instruction,
          assistantCaption: plan.args.caption ?? null,
          controls: { orientation: "4:5", outputCount: 1 },
          toolName: GENERATE_IMAGE_ASYNC_TOOL,
        };
      }
      return {
        promptHint: plan.args.instruction,
        assistantCaption: plan.args.caption ?? null,
        controls: { orientation: "4:5", outputCount: 1, sourceImageAssetId: source.mediaAssetId },
        toolName: EDIT_LAST_IMAGE_TOOL,
      };
    }
    default: {
      const exhaustive: never = plan;
      throw new Error(`unhandled agent tool plan: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function buildConversationContext(context: BuiltContext, assistantContent: string): string {
  return clamp(
    [
      ...context.recentMessages.map((message) => `${message.role}: ${message.content}`),
      `assistant: ${assistantContent}`,
    ].join("\n"),
    2_000,
  );
}
function startOfUtcDay(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
function startOfNextUtcDay(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}
