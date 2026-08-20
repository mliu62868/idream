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
import { noMemoryAuthorityReply } from "@idream/shared";
import { runtimeReadiness } from "./runtime-readiness.js";
import { env } from "./env.js";
import {
  pinCompanionRuntimeForAttempt,
  type CompanionAttemptRuntime,
} from "./companion-runtime-selection.js";
import {
  DshCompanionRuntime,
  type CompanionRuntime,
} from "./companion-runtime.js";
import { verifiedCompanionProfileDigest } from "./companion-sidecar-readiness.js";
import {
  recordCompanionOperationalEvent,
  type CompanionOperationalTelemetry,
} from "./companion-rollout-telemetry.js";
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
  // INTENT: DB integration tests exercise the complete Chat terminal protocol
  // without starting a second model authority or making a paid sidecar call.
  runtimeFactory?: (input: { baseUrl: string; token: string }) => CompanionRuntime;
}

interface PrimaryAttemptTelemetry extends CompanionOperationalTelemetry {
  schemaVersion: 1;
  runtime: "dsh";
  startedAt: string;
  firstTokenMs?: number;
  totalMs?: number;
  terminalStatus?: "sent" | "blocked" | "failed" | "cancelled";
  truncated?: boolean;
  provider?: string;
  model?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    reasoningTokens?: number;
  };
  steps?: number;
  toolCalls?: number;
  retryCount: number;
  sseTerminal?: "done" | "error";
  memory?: {
    outcome: string;
    settleLagMs?: number;
  };
  error?: {
    category: string;
    code: string;
  };
}

export type GenerateWorkerJob = Pick<
  ChatJob<GeneratePayload>,
  "payload" | "attemptsMade" | "maxAttempts"
>;

/**
 * INVARIANT: the first durable attempt claim publishes one route/profile truth
 * on Message and its exact unselected MessageVersion, or publishes neither.
 */
export async function claimGenerateAttemptAuthority(input: {
  prisma: ChatPrismaClient;
  payload: GeneratePayload;
  runtimeTrace: Prisma.InputJsonValue;
  model: string | null;
  expectedMessageStatus: "pending" | "generating";
}): Promise<boolean> {
  return input.prisma.$transaction((tx) => claimGenerateAttemptAuthorityTx({
    tx,
    payload: input.payload,
    runtimeTrace: input.runtimeTrace,
    model: input.model,
    expectedMessageStatus: input.expectedMessageStatus,
  }));
}

export async function claimGenerateAttemptAuthorityTx(input: {
  tx: Prisma.TransactionClient;
  payload: GeneratePayload;
  runtimeTrace: Prisma.InputJsonValue;
  model: string | null;
  expectedMessageStatus: "pending" | "generating";
}): Promise<boolean> {
  const messageClaim = await input.tx.message.updateMany({
    where: {
      id: input.payload.assistantMessageId,
      status: input.expectedMessageStatus,
      attempt: input.payload.attempt,
      deletedAt: null,
    },
    data: {
      status: "generating",
      runtimeTrace: input.runtimeTrace,
      updatedAt: new Date(),
    },
  });
  if (messageClaim.count === 0) return false;
  if (messageClaim.count !== 1) {
    throw new Error("attempt message claim CAS affected an unexpected row count");
  }

  const versionId = `mv:${input.payload.assistantMessageId}:${input.payload.attempt}`;
  await input.tx.messageVersion.upsert({
    where: { id: versionId },
    create: {
      id: versionId,
      messageId: input.payload.assistantMessageId,
      content: "",
      model: input.model,
      selected: false,
      attempt: input.payload.attempt,
      runtimeTrace: input.runtimeTrace,
    },
    update: {
      ...(input.model === null ? {} : { model: input.model }),
      runtimeTrace: input.runtimeTrace,
    },
  });
  const versionClaim = await input.tx.messageVersion.updateMany({
    where: {
      id: versionId,
      messageId: input.payload.assistantMessageId,
      attempt: input.payload.attempt,
      selected: false,
    },
    data: { runtimeTrace: input.runtimeTrace },
  });
  if (versionClaim.count !== 1) {
    throw new Error("attempt MessageVersion claim version CAS failed");
  }
  return true;
}

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
  const current = await prisma.message.findUnique({
    where: { id: payload.assistantMessageId },
    select: { status: true, attempt: true, runtimeTrace: true },
  });
  if (
    !current ||
    current.attempt !== payload.attempt ||
    !["pending", "generating"].includes(current.status)
  ) return false;
  const currentTrace = jsonObject(current.runtimeTrace);
  const admittedTelemetry = jsonObject(currentTrace?.primaryTelemetry);
  if (!currentTrace || !admittedTelemetry) {
    const terminalizedWithoutTrace = await failAssistant(prisma, payload.assistantMessageId);
    if (!terminalizedWithoutTrace) return false;
    await appendStreamEvent(streamKey(payload.assistantMessageId), {
      type: "error",
      attempt: payload.attempt,
      code: "generation_retries_exhausted",
      retryable: false,
    }).catch(() => {});
    return true;
  }
  const startedAt = typeof admittedTelemetry.startedAt === "string"
    ? Date.parse(admittedTelemetry.startedAt)
    : Number.NaN;
  const terminalTelemetry = {
    ...admittedTelemetry,
    ...(Number.isFinite(startedAt) ? { totalMs: Math.max(0, Date.now() - startedAt) } : {}),
    terminalStatus: "failed",
    truncated: admittedTelemetry.truncated === true,
    sseTerminal: "error",
    memory: jsonObject(admittedTelemetry.memory) ?? { outcome: "not_started" },
    error: { category: "worker", code: "generation_retries_exhausted" },
  };
  const runtimeTrace = JSON.parse(JSON.stringify({
    ...currentTrace,
    primaryTelemetry: terminalTelemetry,
  })) as Prisma.InputJsonValue;
  const terminalized = await prisma.$transaction(async (tx) => {
    const updated = await tx.message.updateMany({
      where: {
        id: payload.assistantMessageId,
        status: { in: ["pending", "generating"] },
        attempt: payload.attempt,
      },
      data: { status: "failed", runtimeTrace },
    });
    if (updated.count === 0) return false;
    await tx.messageVersion.upsert({
      where: { id: `mv:${payload.assistantMessageId}:${payload.attempt}` },
      create: {
        id: `mv:${payload.assistantMessageId}:${payload.attempt}`,
        messageId: payload.assistantMessageId,
        content: "",
        selected: false,
        attempt: payload.attempt,
        runtimeTrace,
      },
      update: { runtimeTrace },
    });
    return true;
  });
  if (!terminalized) return false;
  await appendStreamEvent(streamKey(payload.assistantMessageId), {
    type: "error",
    attempt: payload.attempt,
    code: "generation_retries_exhausted",
    retryable: false,
  }).catch(() => {});
  return true;
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
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
  const storedRuntimeTrace =
    assistant.runtimeTrace &&
    typeof assistant.runtimeTrace === "object" &&
    !Array.isArray(assistant.runtimeTrace)
      ? assistant.runtimeTrace as Record<string, unknown>
      : null;
  // INVARIANT: edit/regenerate create a new durable attempt on the same
  // assistant row. Only that exact attempt may reuse a route/profile pin.
  const priorRuntimeTrace = storedRuntimeTrace?.attempt === payload.attempt
    ? storedRuntimeTrace
    : null;
  const companionRuntimeConfig = env.COMPANION_RUNTIME_CONFIG;
  const attemptRuntime = pinCompanionRuntimeForAttempt({
    config: companionRuntimeConfig,
    memoryAuthority: turnMemoryEnabled ? "enabled" : "disabled",
    priorPin: priorRuntimeTrace?.companionRuntime,
  });
  const priorRuntimePin = jsonObject(priorRuntimeTrace?.companionRuntime);
  const dshProfileDigest = priorRuntimeTrace
      ? typeof priorRuntimePin?.profileDigest === "string" &&
          /^[a-f0-9]{64}$/.test(priorRuntimePin.profileDigest)
        ? priorRuntimePin.profileDigest
        : (() => {
            throw new Error("existing DSH attempt is missing its durable profile digest pin");
          })()
      : verifiedCompanionProfileDigest(
          attemptRuntime.sidecarUrl,
          attemptRuntime.private ? "private" : "normal",
        );
  const priorPrimaryTelemetry = jsonObject(priorRuntimeTrace?.primaryTelemetry);
  const priorPrimaryStartedAt =
    priorPrimaryTelemetry?.schemaVersion === 1 &&
    priorPrimaryTelemetry.runtime === attemptRuntime.runtime &&
    typeof priorPrimaryTelemetry.startedAt === "string"
      ? Date.parse(priorPrimaryTelemetry.startedAt)
      : Number.NaN;
  // INVARIANT: BullMQ retries are transport retries of one durable attempt.
  // Gate R latency therefore keeps the first admission clock, not the latest
  // worker invocation clock.
  const primaryStartedAt = Number.isFinite(priorPrimaryStartedAt)
    ? priorPrimaryStartedAt
    : Date.now();
  const primaryTelemetryBase: PrimaryAttemptTelemetry = {
    schemaVersion: 1,
    runtime: attemptRuntime.runtime,
    startedAt: new Date(primaryStartedAt).toISOString(),
    retryCount: hooks.jobAttempt?.attemptsMade ?? 0,
  };
  const companionRuntimePin = {
    runtime: attemptRuntime.runtime,
    memoryBackend: attemptRuntime.memoryBackend,
    profile: attemptRuntime.profile,
    private: attemptRuntime.private,
    sidecarUrl: attemptRuntime.sidecarUrl,
    deadlineMs: attemptRuntime.deadlineMs,
    ...(dshProfileDigest ? { profileDigest: dshProfileDigest } : {}),
  };
  const admissionRuntimeTrace = JSON.parse(JSON.stringify(
    priorRuntimeTrace ?? {
      schemaVersion: 1,
      attempt: payload.attempt,
      assistantMessageId: payload.assistantMessageId,
      userMessageId: payload.userMessageId,
      companionRuntime: companionRuntimePin,
      companionWorkspace: { cleanupRequired: true },
      primaryTelemetry: primaryTelemetryBase,
    },
  )) as Prisma.InputJsonValue;

  const claimed = await claimGenerateAttemptAuthority({
    prisma,
    payload,
    runtimeTrace: admissionRuntimeTrace,
    model: assistant.model,
    expectedMessageStatus: priorRuntimeTrace ? "generating" : "pending",
  });
  if (!claimed) return { status: "skipped" };
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
    });
    const context = preparedTurnRuntime(prepared);
    const authoritativeNoMemoryReply = turnMemoryEnabled
      ? null
      : noMemoryAuthorityReply(sourceTurn.content);
    await hooks.afterContextBuilt?.(context);

    const runtimeTraceFacts: Record<string, unknown> = {
      schemaVersion: 1,
      attempt: payload.attempt,
      assistantMessageId: payload.assistantMessageId,
      userMessageId: payload.userMessageId,
      profile: prepared.profile,
      trace: prepared.trace,
      budget: prepared.budget,
      companionRuntime: companionRuntimePin,
      companionWorkspace: { cleanupRequired: true },
      ...(priorRuntimeTrace?.companionTool
        ? { companionTool: priorRuntimeTrace.companionTool }
        : {}),
      ...(priorRuntimeTrace?.companionToolEffect
        ? { companionToolEffect: priorRuntimeTrace.companionToolEffect }
        : {}),
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
      scene: context.scene,
      outputAuthority: authoritativeNoMemoryReply ? "no_memory_boundary" : "model",
      primaryTelemetry: {
        ...primaryTelemetryBase,
        provider: prepared.profile.provider,
        model: prepared.model,
      } satisfies PrimaryAttemptTelemetry,
    };
    const runtimeTrace = JSON.parse(
      JSON.stringify(runtimeTraceFacts),
    ) as Prisma.InputJsonValue;
    const preparedTracePersisted = await persistAttemptRuntimeTraceCas({
      prisma,
      payload,
      expectedMessageStatus: "generating",
      trace: runtimeTrace,
      stage: "prepared_turn",
      versionModel: prepared.model,
    });
    if (preparedTracePersisted !== "updated") {
      throw new Error("prepared turn runtime trace did not persist atomically");
    }

    await appendStreamEvent(key, { type: "start", attempt: payload.attempt });
    if (!dshProfileDigest) {
      throw new Error("DSH attempt is missing its readiness-verified profile digest");
    }
    return processDshCompanionTurn({
      prisma,
      projectorPrisma,
      payload,
      session,
      prepared,
      context,
      runtimeTraceFacts,
      attemptRuntime,
      profileDigest: dshProfileDigest,
      sidecarToken: companionRuntimeConfig.sidecarToken,
      runtimeFactory: hooks.runtimeFactory,
      heartbeat,
      key,
      jobAttempt: hooks.jobAttempt,
      authoritativePolicyReply: authoritativeNoMemoryReply,
    });
  } finally {
    clearInterval(heartbeatTimer);
  }
}

async function persistTerminalRuntimeTrace(input: {
  prisma: ChatPrismaClient;
  payload: GeneratePayload;
  messageStatus: "generating" | "sent" | "blocked" | "failed";
  runtimeTraceFacts: Record<string, unknown>;
  truncated: boolean;
}): Promise<void> {
  const trace = JSON.parse(JSON.stringify({
    ...input.runtimeTraceFacts,
    ...(input.truncated ? { truncated: true } : {}),
  })) as Prisma.InputJsonValue;
  await persistAttemptRuntimeTraceCas({
    prisma: input.prisma,
    payload: input.payload,
    expectedMessageStatus: input.messageStatus,
    trace,
    stage: "primary_terminal",
  });
}

async function persistFailedRuntimeTrace(input: {
  prisma: ChatPrismaClient;
  payload: GeneratePayload;
  runtimeTraceFacts: Record<string, unknown>;
}): Promise<void> {
  const trace = JSON.parse(JSON.stringify(input.runtimeTraceFacts)) as Prisma.InputJsonValue;
  await persistAttemptRuntimeTraceCas({
    prisma: input.prisma,
    payload: input.payload,
    expectedMessageStatus: ["generating", "failed"],
    trace,
    stage: "primary_failure",
  });
}

type AttemptRuntimeTraceStage =
  | "prepared_turn"
  | "tool_reservation"
  | "primary_terminal"
  | "primary_failure"
  | "dsh_memory_settlement";

/**
 * INVARIANT: Message and MessageVersion expose one attempt trace or neither.
 * This write never owns the message terminal state. If it fails after finalize,
 * the durable terminal fact remains; the prior trace plus structured warning are
 * the retry/reconciliation signal.
 */
export async function persistAttemptRuntimeTraceCas(input: {
  prisma: ChatPrismaClient;
  payload: GeneratePayload;
  expectedMessageStatus: string | readonly string[];
  trace: Prisma.InputJsonValue;
  stage: AttemptRuntimeTraceStage;
  versionModel?: string;
}): Promise<"updated" | "stale" | "failed"> {
  try {
    return await input.prisma.$transaction(async (tx) => {
      const updated = await tx.message.updateMany({
        where: {
          id: input.payload.assistantMessageId,
          status: typeof input.expectedMessageStatus === "string"
            ? input.expectedMessageStatus
            : { in: [...input.expectedMessageStatus] },
          attempt: input.payload.attempt,
        },
        data: { runtimeTrace: input.trace },
      });
      if (updated.count === 0) return "stale" as const;
      const versionUpdated = await tx.messageVersion.updateMany({
        where: {
          id: `mv:${input.payload.assistantMessageId}:${input.payload.attempt}`,
          messageId: input.payload.assistantMessageId,
          attempt: input.payload.attempt,
        },
        data: {
          runtimeTrace: input.trace,
          ...(input.versionModel ? { model: input.versionModel } : {}),
        },
      });
      if (versionUpdated.count !== 1) {
        throw new Error("attempt runtime trace version CAS failed");
      }
      return "updated" as const;
    });
  } catch (error) {
    logger.warn(
      {
        err: error,
        assistantMessageId: input.payload.assistantMessageId,
        attempt: input.payload.attempt,
        stage: input.stage,
        code: "attempt_runtime_trace_persistence_failed",
        retryable: true,
      },
      "attempt runtime trace transaction failed",
    );
    return "failed";
  }
}

function digestText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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
  profileDigest: string;
  sidecarToken: string;
  runtimeFactory?: GenerateHooks["runtimeFactory"];
  heartbeat(force?: boolean): Promise<void>;
  key: string;
  jobAttempt: GenerateHooks["jobAttempt"];
  authoritativePolicyReply: string | null;
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
  const primaryTelemetry = runtimeTraceFacts.primaryTelemetry as PrimaryAttemptTelemetry;
  const primaryStartedAt = Date.parse(primaryTelemetry.startedAt);
  const attemptId = `${payload.assistantMessageId}:${payload.attempt}`;
  const invocationId = `inv:${attemptId}`;
  // INVARIANT: BullMQ retries are transports for one durable attempt, so they
  // share its original wall-clock budget instead of minting a new deadline.
  const absoluteDeadlineAt = primaryStartedAt + attemptRuntime.deadlineMs;
  const invocation: CompanionInvocation = {
    invocationId,
    attemptId,
    sessionId: payload.sessionId,
    userId: session.userId,
    characterId: session.characterId,
    // INVARIANT: policy-owned replies still execute through DSH, but cannot
    // reserve a product side effect that the fixed terminal reply would hide.
    preparedTurn: input.authoritativePolicyReply
      ? { ...toPreparedTurnWire(prepared), tools: [] }
      : toPreparedTurnWire(prepared),
    memoryMode: attemptRuntime.private ? "private" : "normal",
    expectedProfileDigest: input.profileDigest,
    deadlineAt: new Date(absoluteDeadlineAt).toISOString(),
  };
  const runtime = (input.runtimeFactory ?? ((config) => new DshCompanionRuntime(config)))({
    baseUrl: attemptRuntime.sidecarUrl,
    token: input.sidecarToken,
  });
  const providerChunks: string[] = [];
  const deliveredChunks: string[] = [];
  let sequence = 0;
  let usage: { promptTokens: number; completionTokens: number } | null = null;
  let reasoningTokens = 0;
  let imageToolCall: ImageAgentToolCall | null = null;
  let imageToolRequest: ImageRequestFromCall | null = null;
  let toolIdentity: { attemptId: string; callId: string } | null = null;
  let toolReservationUncertain = false;
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
  let primaryFirstTokenMs: number | undefined;

  const emitDelta = async (delta: string): Promise<void> => {
    await heartbeat();
    primaryFirstTokenMs ??= Math.max(0, Date.now() - primaryStartedAt);
    sequence += 1;
    deliveredChunks.push(delta);
    await appendStreamEvent(key, {
      type: "delta",
      attempt: payload.attempt,
      seq: sequence,
      delta,
    });
  };

  const observeProviderDelta = async (delta: string): Promise<void> => {
    providerChunks.push(delta);
    if (input.authoritativePolicyReply) {
      await heartbeat();
      return;
    }
    await emitDelta(delta);
  };

  const executeTool = async (
    call: CompanionToolCall,
  ): Promise<CompanionToolResult> => {
    if (input.authoritativePolicyReply) {
      return {
        attemptId: call.attemptId,
        callId: call.callId,
        name: call.name,
        outcome: "failed",
        error: {
          code: "policy_owned_turn_has_no_tools",
          message: "Chat policy owns this terminal reply and exposes no product tools",
          retryable: false,
        },
      };
    }
    const parsedCall = findAgentTool(call.name)?.parseCall(call.arguments) ?? null;
    const fingerprint = stableJson({
      attemptId: call.attemptId,
      name: call.name,
      arguments: parsedCall?.arguments ?? call.arguments,
    });
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
    if (toolReservationUncertain) {
      return {
        attemptId: call.attemptId,
        callId: call.callId,
        name: call.name,
        outcome: "unknown",
        error: {
          code: "tool_reservation_authority_lost",
          message: "Chat cannot prove whether the prior tool reservation committed",
          retryable: false,
        },
      };
    }
    if (durableToolReservation.success) {
      const reserved = durableToolReservation.data;
      if (reserved.attemptId !== call.attemptId) {
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
      const replayed = findAgentTool(reserved.name)?.parseCall(reserved.arguments);
      if (!replayed) {
        throw new Error("durable companion tool reservation failed Chat schema validation");
      }
      const effectPin = parseImageToolEffectPin(
        runtimeTraceFacts.companionToolEffect,
        reserved,
      );
      const replayedRequest = effectPin
        ? imageRequestFromEffectPin(replayed, effectPin)
        : null;
      if (!replayedRequest) {
        throw new Error("durable companion tool effect pin failed Chat schema validation");
      }
      const reservedFingerprint = stableJson({
        attemptId: reserved.attemptId,
        name: reserved.name,
        arguments: replayed.arguments,
      });
      if (reservedFingerprint !== fingerprint) {
        return {
          attemptId: call.attemptId,
          callId: call.callId,
          name: call.name,
          outcome: "unknown",
          error: {
            code: reserved.callId === call.callId
              ? "tool_identity_conflict"
              : "tool_limit_reached",
            message: reserved.callId === call.callId
              ? "the durable callId reservation has different arguments"
              : "this attempt already has a different durable image-tool reservation",
            retryable: false,
          },
        };
      }
      imageToolCall = replayed;
      imageToolRequest = replayedRequest;
      toolIdentity = { attemptId: reserved.attemptId, callId: reserved.callId };
      const result: CompanionToolResult = {
        attemptId: call.attemptId,
        callId: call.callId,
        name: call.name,
        outcome: "succeeded",
        output: {
          status: "accepted_for_terminal_commit",
          effectId: `${reserved.attemptId}:${reserved.callId}`,
        },
      };
      toolResults.set(call.callId, { fingerprint, result });
      toolResults.set(reserved.callId, {
        fingerprint: reservedFingerprint,
        result: { ...result, callId: reserved.callId },
      });
      return result;
    }
    const parsed = parsedCall;
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
      const resolvedRequest = await buildImageRequestFromCall(parsed, prisma, session.id);
      const reservation = {
        attemptId: call.attemptId,
        callId: call.callId,
        name: parsed.name,
        arguments: parsed.arguments,
      };
      const trace = JSON.parse(JSON.stringify({
        ...runtimeTraceFacts,
        companionTool: reservation,
        companionToolEffect: imageToolEffectPin(reservation, resolvedRequest),
      })) as Prisma.InputJsonValue;
      const reserved = await persistAttemptRuntimeTraceCas({
        prisma,
        payload,
        expectedMessageStatus: "generating",
        trace,
        stage: "tool_reservation",
      });
      if (reserved !== "updated") {
        toolReservationUncertain = true;
        result = {
          attemptId: call.attemptId,
          callId: call.callId,
          name: call.name,
          outcome: "unknown",
          error: {
            code: "tool_reservation_authority_lost",
            message: "Chat lost attempt authority before the tool intent became durable",
            retryable: false,
          },
        };
      } else {
        imageToolCall = parsed;
        imageToolRequest = resolvedRequest;
        toolIdentity = { attemptId: call.attemptId, callId: call.callId };
        // SPEC: execution here is a durable reservation. The only external
        // image effect is created later inside Chat's terminal CAS transaction.
        runtimeTraceFacts.companionTool = reservation;
        runtimeTraceFacts.companionToolEffect = imageToolEffectPin(
          reservation,
          resolvedRequest,
        );
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
      }
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
    if (candidate.content !== providerChunks.join("")) {
      commitAck = rejectedCommit(
        attemptId,
        "stream_candidate_mismatch",
        "terminal candidate differs from the provider text observed by Chat",
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
    // INTENT: Chat owns the no-memory promise boundary. Delay delivery until
    // DSH proposes a traceable candidate, then transform it at the commit port
    // so the user sees one stable truth without a native/runtime bypass.
    const content = input.authoritativePolicyReply ?? candidate.content;
    if (input.authoritativePolicyReply) {
      for (const delta of chunk(content, 96)) await emitDelta(delta);
    }
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
    const terminalAt = Date.now();
    // INVARIANT: persist the exact content-free bridge result so audits bind
    // the committed tool effect to this attempt instead of inferring success
    // from the earlier reservation identity.
    const committedToolResult = toolIdentity
      ? toolResults.get(toolIdentity.callId)?.result
      : undefined;
    const terminalTelemetry: PrimaryAttemptTelemetry = {
      ...primaryTelemetry,
      ...(primaryFirstTokenMs === undefined ? {} : { firstTokenMs: primaryFirstTokenMs }),
      totalMs: Math.max(0, terminalAt - primaryStartedAt),
      terminalStatus: blocked ? "blocked" : "sent",
      truncated: false,
      provider: candidate.provider,
      model: candidate.model,
      usage: candidate.usage,
      steps: candidate.execution.steps,
      toolCalls: candidate.execution.toolCalls,
      memory: {
        outcome: blocked
          ? "discarded_blocked"
          : attemptRuntime.private
            ? "disabled"
            : "pending",
      },
    };
    const terminalTrace: Record<string, unknown> = {
      ...runtimeTraceFacts,
      primaryTelemetry: terminalTelemetry,
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
        ...(input.authoritativePolicyReply
          ? {
              policyOutput: {
                authority: "chat",
                code: "no_memory_future_recall",
                transform: "replace_terminal_candidate",
                providerCandidateDigest: digestText(candidate.content),
                deliveredContentDigest: digestText(content),
                providerFinishReason: candidate.finishReason,
              },
            }
          : {}),
        ...(toolIdentity ? { toolIdentity } : {}),
        ...(committedToolResult ? { toolResult: committedToolResult } : {}),
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
      imageToolRequest,
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
  let runErrorTaxonomy: PrimaryAttemptTelemetry["error"] | null = null;
  let sidecarRetryable: boolean | undefined;
  const deadlineSignal = AbortSignal.timeout(
    Math.max(1, absoluteDeadlineAt - Date.now()),
  );
  try {
    await runtime.run(invocation, {
      async emit(event: CompanionEvent) {
        switch (event.type) {
          case "started":
            if (event.profileDigest !== input.profileDigest) {
              runErrorTaxonomy = {
                category: "runtime",
                code: "dsh_profile_digest_mismatch",
              };
              throw new Error("started profile digest differs from the pinned companion composition");
            }
            recordCompanionOperationalEvent(primaryTelemetry, event);
            return;
          case "igrep_observation":
            recordCompanionOperationalEvent(primaryTelemetry, event);
            return;
          case "text_delta":
            await observeProviderDelta(event.delta);
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
            sidecarRetryable = event.error.retryable;
            runErrorTaxonomy = {
              category: "runtime",
              code: event.error.code,
            };
            throw new Error(`${event.error.code}: ${event.error.message}`);
          case "cancelled":
            runErrorTaxonomy = event.reason === "timeout"
              ? { category: "deadline", code: "dsh_deadline_exceeded" }
              : {
                  category: "cancel",
                  code: `dsh_cancelled_${event.reason}`,
                };
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
      runErrorTaxonomy = {
        category: "deadline",
        code: "dsh_deadline_exceeded",
      };
      await runtime.cancel(invocationId, "timeout").catch(() => {});
    } else {
      runErrorTaxonomy ??= { category: "runtime", code: "dsh_runtime_error" };
    }
  }

  // Once the user has seen text, a
  // transport/runtime failure may not erase it from the Chat ledger. This is a
  // Chat-authored truncated terminal, never an accepted sidecar commit, so the
  // isolated igrep attempt is still discarded.
  const observedCandidate = announcedCandidate as CompanionTerminalCandidate | null;
  const observedUsage = usage as { promptTokens: number; completionTokens: number } | null;
  if (
    runError &&
    terminalStatus === null &&
    deliveredChunks.join("").trim() &&
    observedCandidate === null &&
    commitAck === null
  ) {
    const content = deliveredChunks.join("");
    const moderation = await providers.moderation.check({
      targetType: "text",
      content,
    });
    const blocked = moderation.status === "blocked";
    const partialUsage = observedUsage ?? {
      promptTokens: prepared.budget.usedInputTokens,
      completionTokens: estimateTokens(content),
    };
    const truncatedAt = new Date().toISOString();
    const truncatedTelemetry: PrimaryAttemptTelemetry = {
      ...primaryTelemetry,
      ...(primaryFirstTokenMs === undefined ? {} : { firstTokenMs: primaryFirstTokenMs }),
      totalMs: Math.max(0, Date.now() - primaryStartedAt),
      terminalStatus: blocked ? "blocked" : "sent",
      truncated: true,
      provider: prepared.profile.provider,
      model: prepared.model,
      usage: { ...partialUsage, reasoningTokens },
      toolCalls: toolResults.size,
      memory: { outcome: "discarded_truncated", settleLagMs: 0 },
      ...(runErrorTaxonomy ? { error: runErrorTaxonomy } : {}),
    };
    const truncatedTrace: Record<string, unknown> = {
      ...runtimeTraceFacts,
      truncated: true,
      primaryTelemetry: truncatedTelemetry,
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
      imageToolRequest,
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
      const settledAt = Date.now();
      const settledTelemetry = {
        ...(settledTrace.primaryTelemetry as PrimaryAttemptTelemetry),
        memory: {
          outcome: memoryIngestOutcome,
          settleLagMs: Math.max(
            0,
            settledAt - (
              primaryStartedAt +
              ((settledTrace.primaryTelemetry as PrimaryAttemptTelemetry).totalMs ?? 0)
            ),
          ),
        },
      } satisfies PrimaryAttemptTelemetry;
      const finalTraceFacts: Record<string, unknown> = {
        ...settledTrace,
        primaryTelemetry: settledTelemetry,
        companion: {
          ...companion,
          memoryIngestOutcome,
          memoryIngestSettledAt: new Date(settledAt).toISOString(),
          reasoningTokens,
        },
      };
      const finalTrace = JSON.parse(JSON.stringify(finalTraceFacts)) as Prisma.InputJsonValue;
      await persistAttemptRuntimeTraceCas({
        prisma,
        payload,
        expectedMessageStatus: terminalStatus,
        trace: finalTrace,
        stage: "dsh_memory_settlement",
      });
      committedTrace = finalTraceFacts;
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
    } else {
      // Output moderation is Chat-local terminal policy. The provider returned
      // a complete attributable candidate, so blocked delivery disproves any
      // in-progress provider failure streak just as a sent reply does.
      runtimeReadiness.recordTurnSuccess();
    }
    await appendStreamEvent(key, {
      type: "done",
      attempt: payload.attempt,
      usage: committedUsage ?? usage ?? {
        promptTokens: prepared.budget.usedInputTokens,
        completionTokens: estimateTokens(deliveredChunks.join("")),
      },
    });
    const deliveredTrace = committedTrace as Record<string, unknown> | null;
    if (deliveredTrace) {
      const deliveredTelemetry = deliveredTrace.primaryTelemetry as PrimaryAttemptTelemetry;
      deliveredTelemetry.sseTerminal = "done";
      await persistTerminalRuntimeTrace({
        prisma,
        payload,
        messageStatus: terminalStatus,
        runtimeTraceFacts: deliveredTrace,
        truncated: deliveredTelemetry.truncated === true,
      });
    }
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

  if (terminalStatus === "skipped") {
    if (observedCandidate) runtimeReadiness.recordTurnSuccess();
    return { status: "skipped" };
  }
  const rejectionError = settledAck && !settledAck.accepted
    ? settledAck.error.code
    : null;
  const error = rejectionError
    ? {
        category: rejectionError === "terminal_cas_conflict" || rejectionError === "context_changed"
          ? "cas"
          : rejectionError === "provider_output_limit"
            ? "provider"
            : "runtime",
        code: rejectionError,
      }
    : runErrorTaxonomy ?? { category: "runtime", code: "dsh_terminal_missing" };
  const deterministicFailure = rejectionError !== null
    || error.code === "dsh_profile_digest_mismatch";
  const terminalCancellation = error.category === "deadline" || error.category === "cancel";
  const retryable = !deterministicFailure
    && !terminalCancellation
    && sidecarRetryable !== false
    && hasWorkerRetryRemaining(input.jobAttempt);
  const failureTelemetry: PrimaryAttemptTelemetry = {
    ...primaryTelemetry,
    ...(primaryFirstTokenMs === undefined ? {} : { firstTokenMs: primaryFirstTokenMs }),
    totalMs: Math.max(0, Date.now() - primaryStartedAt),
    terminalStatus: error.category === "cancel" ? "cancelled" : "failed",
    truncated: false,
    provider: prepared.profile.provider,
    model: prepared.model,
    ...(observedUsage ? { usage: { ...observedUsage, reasoningTokens } } : {}),
    steps: observedCandidate?.execution.steps ?? 0,
    toolCalls: toolResults.size,
    memory: { outcome: "not_started" },
    error,
  };
  const failureTrace = {
    ...runtimeTraceFacts,
    primaryTelemetry: failureTelemetry,
  };
  await persistFailedRuntimeTrace({ prisma, payload, runtimeTraceFacts: failureTrace });
  const completeCandidateLostLocalCas = observedCandidate !== null
    && (rejectionError === "context_changed" || rejectionError === "terminal_cas_conflict");
  if (error.code === "dsh_profile_digest_mismatch") {
    // Exact composition identity is an admission invariant, not a noisy turn
    // failure. One mismatch proves this process is serving stale authority.
    runtimeReadiness.invalidate(
      runError ?? new Error("DSH started with a different profile digest"),
    );
  } else if (completeCandidateLostLocalCas) {
    // CAS loss is local concurrency evidence, not provider health evidence.
    runtimeReadiness.recordTurnSuccess();
  } else if (
    rejectionError !== "provider_output_limit" &&
    error.category !== "cancel"
  ) {
    // Protocol/identity divergence, deadline and transport failures must remain
    // health evidence even when retry policy correctly terminalizes the attempt.
    runtimeReadiness.recordTurnFailure(
      runError ?? new Error("DSH returned without a terminal commit"),
    );
  }
  if (!retryable) await failAssistant(prisma, payload.assistantMessageId);
  await appendStreamEvent(key, {
    type: "error",
    attempt: payload.attempt,
    code: rejectionError ?? runErrorTaxonomy?.code ?? "provider_failed",
    retryable,
  });
  failureTelemetry.sseTerminal = "error";
  await persistFailedRuntimeTrace({ prisma, payload, runtimeTraceFacts: failureTrace });
  if (!retryable) return { status: "failed" };
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
  imageToolRequest?: ImageRequestFromCall | null;
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
  const { prisma, payload, session, content, model, usage, moderation, blocked, context, imageToolCall, imageToolRequest = null, toolCallTrigger, toolCallIdentity, traceEntry, projectorPrisma, runtimeTrace } = input;

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

      await tx.chatSession.update({
        where: { id: session.id },
        data: { lastMessageAt: new Date() },
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

      if (imageToolCall) {
        if (!imageToolRequest) {
          throw new Error("image tool terminal is missing its durable effect pin");
        }
        const built = imageToolRequest;
        if (built.controls.sourceImageAssetId) {
          const pinnedSource = await tx.messageAttachment.findFirst({
            where: {
              sessionId: session.id,
              kind: "generated_image",
              status: "completed",
              mediaAssetId: built.controls.sourceImageAssetId,
            },
          });
          if (pinnedSource?.mediaAssetId !== built.controls.sourceImageAssetId) {
            return "stale";
          }
        }
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
interface ImageRequestFromCall {
  promptHint: string;
  assistantCaption: string | null;
  controls: { orientation: string; outputCount: number; sourceImageAssetId?: string };
  // The tool this request actually ended up as — distinct from call.name when
  // edit_last_image degrades to a fresh generate (no source photo). Recorded on the
  // attachment as metadata.toolName so the trail reflects what actually happened,
  // never a stale "edit_last_image" tag on what is, in fact, a plain generate.
  toolName: typeof GENERATE_IMAGE_ASYNC_TOOL | typeof EDIT_LAST_IMAGE_TOOL;
}

interface ImageToolEffectPin {
  attemptId: string;
  callId: string;
  toolName: typeof GENERATE_IMAGE_ASYNC_TOOL | typeof EDIT_LAST_IMAGE_TOOL;
  sourceImageAssetId: string | null;
}

function imageToolEffectPin(
  reservation: Pick<CompanionToolCall, "attemptId" | "callId">,
  request: ImageRequestFromCall,
): ImageToolEffectPin {
  return {
    attemptId: reservation.attemptId,
    callId: reservation.callId,
    toolName: request.toolName,
    sourceImageAssetId: request.controls.sourceImageAssetId ?? null,
  };
}

function parseImageToolEffectPin(
  value: unknown,
  reservation: Pick<CompanionToolCall, "attemptId" | "callId">,
): ImageToolEffectPin | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const pin = value as Record<string, unknown>;
  if (
    pin.attemptId !== reservation.attemptId ||
    pin.callId !== reservation.callId ||
    (pin.toolName !== GENERATE_IMAGE_ASYNC_TOOL && pin.toolName !== EDIT_LAST_IMAGE_TOOL) ||
    (pin.sourceImageAssetId !== null && typeof pin.sourceImageAssetId !== "string")
  ) {
    return null;
  }
  return pin as unknown as ImageToolEffectPin;
}

function imageRequestFromEffectPin(
  call: ImageAgentToolCall,
  pin: ImageToolEffectPin,
): ImageRequestFromCall | null {
  if (call.name === GENERATE_IMAGE_ASYNC_TOOL) {
    if (pin.toolName !== GENERATE_IMAGE_ASYNC_TOOL || pin.sourceImageAssetId !== null) return null;
    return {
      promptHint: call.arguments.prompt,
      assistantCaption: call.arguments.caption ?? null,
      controls: {
        orientation: call.arguments.orientation,
        outputCount: call.arguments.outputCount,
      },
      toolName: GENERATE_IMAGE_ASYNC_TOOL,
    };
  }
  if (pin.toolName === GENERATE_IMAGE_ASYNC_TOOL && pin.sourceImageAssetId === null) {
    return {
      promptHint: call.arguments.instruction,
      assistantCaption: call.arguments.caption ?? null,
      controls: { orientation: "4:5", outputCount: 1 },
      toolName: GENERATE_IMAGE_ASYNC_TOOL,
    };
  }
  if (pin.toolName !== EDIT_LAST_IMAGE_TOOL || !pin.sourceImageAssetId) return null;
  return {
    promptHint: call.arguments.instruction,
    assistantCaption: call.arguments.caption ?? null,
    controls: {
      orientation: "4:5",
      outputCount: 1,
      sourceImageAssetId: pin.sourceImageAssetId,
    },
    toolName: EDIT_LAST_IMAGE_TOOL,
  };
}

type MessageAttachmentReader =
  | Pick<Prisma.TransactionClient, "messageAttachment">
  | Pick<ChatPrismaClient, "messageAttachment">;

// Shapes the attachment/outbox payload fields per DSH tool call. The edit_last_image arm
// looks up the session's most recent completed photo (behavior contract point 1) and,
// when found, carries its mediaAssetId as the img2img source (point 2). No source photo
// degrades to generate_image_async semantics rather than erroring (point 3) — sending a
// fresh image beats failing the turn.
async function buildImageRequestFromCall(
  call: ImageAgentToolCall,
  tx: MessageAttachmentReader,
  sessionId: string,
): Promise<ImageRequestFromCall> {
  switch (call.name) {
    case GENERATE_IMAGE_ASYNC_TOOL:
      return {
        promptHint: call.arguments.prompt,
        assistantCaption: call.arguments.caption ?? null,
        controls: {
          orientation: call.arguments.orientation,
          outputCount: call.arguments.outputCount,
        },
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
          promptHint: call.arguments.instruction,
          assistantCaption: call.arguments.caption ?? null,
          controls: { orientation: "4:5", outputCount: 1 },
          toolName: GENERATE_IMAGE_ASYNC_TOOL,
        };
      }
      return {
        promptHint: call.arguments.instruction,
        assistantCaption: call.arguments.caption ?? null,
        controls: { orientation: "4:5", outputCount: 1, sourceImageAssetId: source.mediaAssetId },
        toolName: EDIT_LAST_IMAGE_TOOL,
      };
    }
    default: {
      const exhaustive: never = call;
      throw new Error(`unhandled agent tool call: ${JSON.stringify(exhaustive)}`);
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
