import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import type { AgentRegistry } from "@deepseek-ai/dsh-agent";
import {
  LlmAdapter,
  MessageId,
  ToolCallId,
  freezeMessage,
  type AssistantMessage,
  type LlmFailure,
  type StreamChunk,
  type TokenUsage,
  type ToolResultMessage,
  type UserMessage,
} from "@deepseek-ai/dsh-llm";
import { Session, SessionId, SessionSeq, type SessionEvent, type TurnEndReason } from "@deepseek-ai/dsh-session";
import { type PostToolDecision, type ToolDefinition } from "@deepseek-ai/dsh-tools";
import { type CompanionReadiness } from "@idream/shared/chat/companion-runtime";
import {
  companionEventSchema,
  companionToolReservationSchema,
  companionToolResultSchema,
  type CompanionCommitAck,
  type CompanionEvent,
  type CompanionInvocation,
  type CompanionModelRequestEvidence,
  type CompanionTerminalCandidate,
  type CompanionToolCall,
  type CompanionToolResult,
  type PreparedTurnMessage,
  type PreparedTurnProfile,
} from "./contracts";
import {
  acceptableRequiredImageLeadIn,
  evaluateTerminalCandidate,
  type TerminalValidationCode,
} from "./terminal-candidate";
import {
  applyCompanionComposition,
  createCompanionCompositionPlan,
  resolvedCompanionIgrepConfig,
} from "./composition";
import { renderResidentProfile } from "./resident-profile";
import { selectRecallNotes } from "./recall-notes";
import { readSupportedProfileLines } from "./profile-evidence";
import type {
  AttemptWorkspace,
  AttemptWorkspaceStore,
  WorkspacePurgeRequest,
} from "./workspace";
import {
  observeIgrepWake,
  originalIgrepMemoryHits,
  recallIgrepMemory,
  reprojectIgrepMemory,
  type IgrepPluginModule,
  type RunJsonCommand,
} from "./igrep";
import type {
  CompanionWorkspaceRebuildPromotion,
  CompanionWorkspaceRebuildSource,
} from "./rebuild-source";
import { assertNotFenced, withDrainFence, type FenceScope } from "../fence.js";
import { stableJson } from "../stable-json";
import { imageAcknowledgement } from "../image-acknowledgement";
type EventPayload = CompanionEvent extends infer Event
  ? Event extends CompanionEvent
    ? Omit<Event, "invocationId" | "attemptId" | "sequence" | "occurredAt">
    : never
  : never;

export interface CompanionEngineOptions {
  instance?: CompanionReadiness["instance"];
  workspaces: AttemptWorkspaceStore;
  plugin(): Promise<IgrepPluginModule>;
  adapter(profile: PreparedTurnProfile, requiredToolName: CompanionToolCall["name"] | undefined, requestPolicy: {
    maxInputTokens: number;
    replayMessageIds: readonly string[];
    observeRequest(evidence: CompanionModelRequestEvidence): void;
    samplingTemperature?: number;
  }): LlmAdapter;
  igrepCommand: string;
  /**
   * SPEC: 覆盖 igrep 子进程的执行方式。生产留空走真实 igrep。
   * INTENT: 这里曾经是 observeWake / recallMemory 两个函数级钩子 —— 测试替掉整个
   *   wake / recall 协议，于是解析、note 截断和证据计数在 engine 测试里从没被跑
   *   过。换成 igrep 自己的 RunJsonCommand 之后，注入点落在真实的进程边界上。
   */
  runIgrep?: RunJsonCommand;
  igrepLlm: { url: string; model: string };
  memoryBuilder?: {
    build(
      workspace: string,
      request: CompanionWorkspaceRebuildSource,
      signal?: AbortSignal,
      transcriptsRoot?: string,
    ): Promise<{ sessions: number; messages: number }>;
  };
  maxSteps?: number;
  maxConcurrentAgents?: { normal: number; private: number };
}

export interface CompanionRuntimePort {
  emit(event: CompanionEvent): Promise<void> | void;
  executeTool(call: CompanionToolCall): Promise<CompanionToolResult>;
  commit(candidate: CompanionTerminalCandidate, signal?: AbortSignal): Promise<CompanionCommitAck>;
}

/** Resource pressure defers the admitted attempt; it is not a product failure. */
export class CompanionCapacityError extends Error {
  constructor(readonly pool: "normal" | "private") {
    super(`${pool} companion agent pool is at capacity`);
    this.name = "CompanionCapacityError";
  }
}

// SPEC: signed Gate-E probes use one high-entropy marker family. Persist only
// a match count, never the marker or memory_search result bytes.
function auditRecallEvidenceMatches(value: unknown): number {
  const matches = JSON.stringify(value).match(/\bidreamrecall_[a-f0-9]{32}\b/giu) ?? [];
  // The shared evidence wire is deliberately bounded: Gate E needs proof of
  // at least one result-bound marker, never an unbounded marker inventory.
  return Math.min(8, new Set(matches.map((match) => match.toLowerCase())).size);
}

// SPEC: the official plugin's memory guidance is written for a coding agent
// ("prior work, decisions, todos"; "verify with memory_search"). Registering
// the same section name in the agent scope shadows it, so the companion reads
// recall guidance in its own register without forking the plugin.
// `{{igrep_memory_profile}}` keeps the plugin's variable name; the agent-scoped
// value supplies the wake result this turn actually awaited. The plugin wake
// hook is disabled: Chat owns the read, failure handling and observation.
// 2026-10-04: cut from fourteen lines to four. The removed half was audit-probe
// guidance about source timezones and relative dates; it read as assistant
// procedure in a companion prompt, and the model never once called
// memory_search in 195 recorded turns because recall is already pushed.
const COMPANION_MEMORY_GUIDANCE = [
  "Memory: you remember what they have shared with you across conversations.",
  "Use it the way a close companion would, in passing, without announcing that you looked anything up.",
  "If they ask about something specific you cannot see here, call memory_search before answering; if nothing turns up, say you don't recall rather than inventing it.",
  "Quote their names, numbers and dates exactly as they gave them.",
].join(" ") + "\n\n{{igrep_memory_profile}}";

const MAX_RECALL_NOTES = 6;
const PRE_RECALL_TIMEOUT_MS = 10_000;

function shouldPreRecall(query: string): boolean {
  const text = query.trim();
  if (!text) return false;
  if (/(?:remember|recall|earlier|before|last time|记得|还记得|上次|之前|曾经)/iu.test(text)) {
    return true;
  }
  const hanCharacters = text.match(/\p{Script=Han}/gu)?.length ?? 0;
  return hanCharacters >= 2 || text.length >= 8;
}

function renderRecallContext(notes: readonly string[]): string | undefined {
  if (notes.length === 0) return undefined;
  return [
    "Moments from earlier conversations that may matter right now:",
    ...notes.slice(0, MAX_RECALL_NOTES).map((note) => `- ${note}`),
  ].join("\n");
}

// SPEC: when the user asks what the Character remembers and the memory
// search finds nothing, that absence is stated as data before the model
// speaks.
// INTENT: the rule "do not claim to remember facts absent from the context"
// did not hold on the local model: two fresh sessions on 2026-10-04 answered
// "do you remember my name / my job / my pet" with invented names and then
// insisted "you told me, and I kept it". The same model does follow a
// concrete data line in the turn context, so the empty result is written
// there instead of relying on a prohibition in the system prompt.
function asksAboutMemory(text: string): boolean {
  return /\b(?:remember|recall|forgot|forgotten)\b|what(?:'s| is) my (?:name|job|work)|who am i|do you know (?:me|my)|记得|还记得|忘了|忘记|我叫什么|我是谁|知道我/iu.test(text);
}

const EMPTY_RECALL_CONTEXT = [
  "Moments from earlier conversations that may matter right now:",
  // Measured 2026-10-04, 5 samples per arm: without this line the model
  // guessed a sister's name in 2 of 5 replies; with it, 0 of 10. "On record"
  // and "session" wording leaked into one reply, so it stays in plain words.
  "- You have no memory of what they are asking about. Say so in your own way and let them tell you; do not guess a name or detail.",
].join("\n");

// Factual questions benefit from the model profile's structured temperature;
// ordinary roleplay keeps the configured expressive sampling. This classifier
// is deliberately narrow so a generic conversational turn never silently
// changes personality or cadence.
function needsFactualSampling(text: string): boolean {
  return /\b(?:what\s+(?:have|did)\s+i|what\s+did\s+you|exact(?:\s+full)?\s+(?:label|name|identifier|code)|copy\s+it\s+verbatim|verbatim|identifier|code\s+word|recall)\b|(?:做了什么|我做过什么|完整标签|原样|逐字|标识符|暗号)/iu.test(text);
}

async function timed<T>(run: () => Promise<T>): Promise<
  { ok: true; value: T; durationMs: number } | { ok: false; error: unknown; durationMs: number }
> {
  const startedAt = Date.now();
  try {
    const value = await run();
    return { ok: true, value, durationMs: Math.max(0, Date.now() - startedAt) };
  } catch (error) {
    return { ok: false, error, durationMs: Math.max(0, Date.now() - startedAt) };
  }
}

function wireUsage(usage?: TokenUsage) {
  if (!usage) return null;
  return {
    promptTokens: usage.inputTokens
      + (usage.cacheReadTokens ?? 0)
      + (usage.cacheWriteTokens ?? 0),
    completionTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens ?? 0,
  };
}

function assistantText(message: AssistantMessage): string {
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === "text") parts.push(block.text);
  }
  return parts.join("");
}

function wireAttribution(finish: StreamChunk & { type: "finish" }) {
  const response = finish.replayState?.response;
  if (!response || typeof response !== "object" || Array.isArray(response)) return undefined;
  const record = response as Record<string, unknown>;
  const requestId = typeof record.id === "string" && record.id.trim() ? record.id : undefined;
  const actualProvider = typeof record.provider === "string" && record.provider.trim()
    ? record.provider
    : undefined;
  if (!requestId && !actualProvider) return undefined;
  return {
    ...(requestId ? { requestId } : {}),
    ...(actualProvider ? { actualProvider } : {}),
  };
}

// SPEC: 失败日志里能出现的原因线索，全部是分类，不含任何自由文本。
// INVARIANT: 绝不写 error.message / turnFailure.message —— provider 的响应体会
//   原样出现在里面，那是用户内容。同一条不变量在 wire 上已经守着了
//   （见 engine.test.ts 的 PRIVATE_PROVIDER_BODY_SENTINEL 断言），stderr 是同
//   一类外泄面，规则一致。
//   拿得到的线索：哪个类型的异常、provider 的 code/status、igrep 哪一段、preflight
//   码。要看完整报文去 Sentry，不要靠日志。
function describeInvocationCause(error: unknown): string {
  if (error instanceof Error) return error.name || "Error";
  if (error === null) return "null";
  return typeof error;
}

function invocationFailure(input: {
  terminalCommitted: boolean;
  phase: "composition" | "workspace" | "agent";
  turnFailure?: LlmFailure;
  igrepFailure?: "wake" | "search" | "memory";
  preflightCode?: string;
  terminalValidationCode?:
    | "unexecuted_tool_payload"
    | "required_image_reply_language_mismatch"
    | "required_image_reply_exposed_process"
    | "required_image_tool_missing"
    | "required_image_tool_mismatch";
}) {
  if (input.preflightCode) {
    return {
      code: input.preflightCode,
      message: "companion preflight failed",
      retryable: false,
    };
  }
  if (input.terminalValidationCode) {
    return {
      code: input.terminalValidationCode,
      message: "companion terminal candidate was not executable",
      retryable: true,
    };
  }
  if (input.turnFailure?.code === "PROVIDER_HTTP_ERROR") {
    const status = input.turnFailure.status;
    const validStatus = Number.isInteger(status) && status! >= 100 && status! <= 599;
    return {
      code: validStatus ? `provider_http_${status}` : "provider_http_error",
      message: "companion provider request failed",
      retryable: status === 429 || (typeof status === "number" && status >= 500),
    };
  }
  if (input.turnFailure?.code === "INPUT_BUDGET_EXCEEDED") {
    return {
      code: "input_budget_exceeded",
      message: "fixed companion input exceeds its budget",
      retryable: false,
    };
  }
  const providerCodes: Record<string, string> = {
    MODEL_FIRST_TOKEN_TIMEOUT: "provider_first_token_timeout",
    MODEL_IDLE_TIMEOUT: "provider_idle_timeout",
    PROVIDER_STREAM_LIMIT: "provider_stream_limit",
    EMPTY_RESPONSE: "provider_empty_response",
    INVALID_RESPONSE: "provider_invalid_response",
    INVALID_ROUTE: "provider_invalid_route",
    TRANSPORT: "provider_unavailable",
  };
  const providerCode = input.turnFailure?.code
    ? providerCodes[input.turnFailure.code]
    : undefined;
  if (providerCode) {
    return {
      code: providerCode,
      message: "companion provider response failed",
      retryable: providerCode === "provider_empty_response"
        || providerCode === "provider_first_token_timeout"
        || providerCode === "provider_idle_timeout"
        || providerCode === "provider_unavailable",
    };
  }
  if (input.igrepFailure) {
    return {
      code: `igrep_${input.igrepFailure}_failed`,
      message: "companion memory tool failed",
      retryable: true,
    };
  }
  return {
    code: input.phase === "workspace" ? "workspace_prepare_failed" : "invocation_failed",
    message: input.phase === "workspace"
      ? "companion workspace preparation failed"
      : "companion invocation failed",
    retryable: input.phase === "workspace",
  };
}

function seedMessage(
  message: PreparedTurnMessage,
  profile: PreparedTurnProfile,
  form: "replay" | "snapshot" | "recall" = "replay",
) {
  if (message.role === "assistant") {
    return freezeMessage({
      id: MessageId(message.id),
      role: "assistant" as const,
      source: {
        kind: "model" as const,
        provider: profile.provider,
        model: profile.model,
        ...(message.speaker ? { speaker: message.speaker } : {}),
      },
      content: [
        ...(message.content ? [{ type: "text" as const, text: message.content }] : []),
        ...(message.tool_calls ?? []).map((call) => ({
          type: "tool-call" as const,
          id: ToolCallId(call.id),
          name: call.function.name,
          arguments: call.function.arguments,
        })),
      ],
    });
  }
  if (message.role === "tool") {
    return freezeMessage({
      id: MessageId(message.id),
      role: "tool" as const,
      source: { kind: "tool" as const, callId: ToolCallId(message.tool_call_id) },
      toolCallId: ToolCallId(message.tool_call_id),
      content: [{ type: "text" as const, text: message.content }],
      isError: false,
    });
  }
  return freezeMessage({
    id: MessageId(message.id),
    role: "user" as const,
    source: { kind: "idream" as const, context: form },
    content: [{ type: "text" as const, text: message.content }],
  });
}

/**
 * SPEC: the seed is history plus every per-turn context message, in prompt
 * order; only the current user message enters through `followup` with
 * `source.kind = "user"`. Plugin-sourced state, saved preferences and recall
 * notes are therefore invisible to igrep ingest.
 */
export function buildReplaySeed(
  invocation: CompanionInvocation,
  recallContext?: string,
): readonly SessionEvent[] {
  const replay: PreparedTurnMessage[] = invocation.preparedTurn.messages.filter(
    (message) => message.role !== "system" && message.sourceKind !== "current_user",
  );
  if (recallContext) {
    replay.push({
      id: `recall:${invocation.attemptId}`,
      sourceKind: "plugin",
      role: "user",
      content: recallContext,
    });
  }
  if (replay.length === 0) return [];
  const seed = Session.create(SessionId(`seed:${invocation.attemptId}`));
  let turn = 0;
  let step = 0;
  let openTurn = false;
  let openStep = false;
  let assistantInStep = false;
  const pendingCalls = new Set<string>();
  const closeStep = () => {
    if (!openStep) return;
    if (pendingCalls.size > 0) throw new Error("prepared replay contains dangling tool calls");
    seed.append("step/end", { turn, step });
    openStep = false;
    assistantInStep = false;
  };
  const closeTurn = () => {
    if (!openTurn) return;
    closeStep();
    seed.append("turn/end", { turn, reason: { kind: "completed" } });
    openTurn = false;
  };
  const open = () => {
    if (!openTurn) {
      turn += 1;
      step = 0;
      seed.append("turn/start", { turn });
      openTurn = true;
    }
    if (!openStep) {
      step += 1;
      seed.append("step/start", { turn, step });
      openStep = true;
    }
  };

  for (const item of replay) {
    if (item.role === "user") {
      closeTurn();
      open();
      seed.append("user/message", seedMessage(
        item,
        invocation.preparedTurn.profile,
        item.sourceKind === "plugin"
          ? (item.id.startsWith("state:") || item.id.startsWith("preferences:") ? "snapshot" : item.id.startsWith("recall:") ? "recall" : "replay")
          : "replay",
      ) as UserMessage, {
        surfaceOp: "append",
      });
      continue;
    }
    if (item.role === "assistant") {
      if (assistantInStep) closeStep();
      open();
      const message = seedMessage(item, invocation.preparedTurn.profile) as AssistantMessage;
      // Replayed history has no provider stream of its own to embed.
      seed.append("assistant/message", { turn, step, message, stream: [] }, {
        surfaceOp: "append",
      });
      assistantInStep = true;
      for (const call of item.tool_calls ?? []) {
        pendingCalls.add(call.id);
        seed.append("tool/call", {
          turn,
          step,
          callId: ToolCallId(call.id),
          name: call.function.name,
          arguments: call.function.arguments,
        });
      }
      if (pendingCalls.size === 0) closeTurn();
      continue;
    }
    if (item.role !== "tool") throw new Error("system messages cannot enter replay seed");
    if (!openStep || !pendingCalls.delete(item.tool_call_id)) {
      throw new Error(`prepared replay tool result ${item.tool_call_id} has no matching call`);
    }
    seed.append("tool/result", {
      turn,
      step,
      message: seedMessage(item, invocation.preparedTurn.profile) as ToolResultMessage,
    }, {
      surfaceOp: "append",
      sourceEventSeqs: [],
    });
    if (pendingCalls.size === 0) closeStep();
  }
  closeTurn();
  return Array.from({ length: seed.seq }, (_, seq) => seed.eventAt(SessionSeq(seq))!);
}

class ToolBridge {
  lastResult?: CompanionToolResult;
  private readonly entries = new Map<string, {
    name: CompanionToolCall["name"];
    startedAt: number;
    reservation: ReturnType<typeof companionToolReservationSchema.parse>;
    pending: Promise<CompanionToolResult>;
  }>();

  constructor(
    private readonly executeTool: CompanionRuntimePort["executeTool"],
    private readonly event: (event: EventPayload) => void,
  ) {}

  get callCount(): number {
    return this.entries.size;
  }

  get reservations() {
    return [...this.entries.values()].map((entry) => entry.reservation);
  }

  async execute(call: CompanionToolCall, signal: AbortSignal): Promise<CompanionToolResult> {
    const key = `${call.attemptId}\0${call.callId}`;
    let entry = this.entries.get(key);
    if (!entry) {
      const startedAt = Date.now();
      entry = {
        name: call.name,
        startedAt,
        reservation: companionToolReservationSchema.parse({
          attemptId: call.attemptId,
          callId: call.callId,
          name: call.name,
          effectScope: call.effectScope,
          intent: call.intent,
          argumentsDigest: createHash("sha256")
            .update(stableJson(call.arguments))
            .digest("hex"),
        }),
        pending: Promise.resolve(this.executeTool(call)).then((result) => {
          const parsed = companionToolResultSchema.parse(result);
          if (
            parsed.attemptId !== call.attemptId ||
            parsed.callId !== call.callId ||
            parsed.name !== call.name
          ) {
            throw new Error("tool result identity does not match its call");
          }
          return parsed;
        }),
      };
      this.entries.set(key, entry);
      this.event({ type: "tool_started", callId: call.callId, name: call.name });
    } else if (entry.name !== call.name) {
      return companionToolResultSchema.parse({
        attemptId: call.attemptId,
        callId: call.callId,
        name: entry.name,
        outcome: "unknown",
        error: {
          code: "ambiguous_tool_result",
          message: "one tool identity was reused with a different name",
          retryable: false,
        },
      });
    }
    let result: CompanionToolResult;
    try {
      result = await Promise.race([
        entry.pending,
        new Promise<never>((_resolve, reject) => {
          const abort = () => reject(signal.reason ?? new Error("tool call aborted"));
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        }),
      ]);
    } catch (error) {
      // A timeout/cancel after durable intent cannot prove that the external
      // effect failed. Publish an unknown terminal observation so Chat can
      // reconcile by attemptId + callId without treating silence as success.
      this.event({
        type: "tool_finished",
        callId: call.callId,
        name: call.name,
        outcome: "unknown",
        durationMs: Math.max(0, Date.now() - entry.startedAt),
      });
      throw error;
    }
    this.event({
      type: "tool_finished",
      callId: call.callId,
      name: call.name,
      outcome: result.outcome,
      durationMs: Math.max(0, Date.now() - entry.startedAt),
    });
    this.lastResult = result;
    return result;
  }
}

class ActiveInvocation {
  readonly cancellation = new AbortController();
  agentCancel?: (reason: "user" | "timeout" | "shutdown" | "transport") => void;
  cancelReason?: "user" | "timeout" | "shutdown" | "transport";
  /** Set once the DSH agent is disposed. */
  agentDisposed = false;

  constructor(readonly invocation: CompanionInvocation) {}

  cancel(reason: "user" | "timeout" | "shutdown" | "transport"): void {
    if (this.cancelReason) return;
    this.cancelReason = reason;
    this.cancellation.abort(new Error(`invocation cancelled: ${reason}`));
    this.agentCancel?.(reason);
  }

}

/** Exercise the same direct ports used by live invocations. */
export async function probeCompanionBridges(invocation: CompanionInvocation): Promise<void> {
  const events: EventPayload[] = [];
  const bridge = new ToolBridge(async (call) => ({
    attemptId: call.attemptId,
    callId: call.callId,
    name: call.name,
    outcome: "succeeded",
    output: { status: "readiness" },
  }), (event) => events.push(event));
  const controller = new AbortController();
  const call: CompanionToolCall = {
    attemptId: invocation.attemptId,
    callId: "readiness-tool-call",
    name: "generate_image_async",
    effectScope: "attempt",
    intent: { requestedNudity: "unspecified" },
    arguments: { prompt: "readiness", subject: "companion" },
  };
  if ((await bridge.execute(call, controller.signal)).outcome !== "succeeded") {
    throw new Error("tool bridge readiness probe did not round-trip");
  }
  const ack: CompanionCommitAck = {
    attemptId: invocation.attemptId,
    accepted: true,
    status: "committed",
    terminalMessageId: "readiness-terminal",
    committedAt: new Date().toISOString(),
  };
  const accepted = await Promise.resolve(ack);
  if (!accepted.accepted || accepted.terminalMessageId !== ack.terminalMessageId) {
    throw new Error("commit bridge readiness probe did not round-trip");
  }
}

export class CompanionEngine {
  private readonly active = new Map<string, ActiveInvocation>();
  private maintenanceTail = Promise.resolve();
  private closing = false;

  private readonly instance: CompanionReadiness["instance"];

  constructor(private readonly options: CompanionEngineOptions) {
    this.instance = options.instance ?? {
      id: randomUUID(),
      startedAt: new Date().toISOString(),
    };
  }

  async run(
    invocation: CompanionInvocation,
    port: CompanionRuntimePort,
    signal?: AbortSignal,
  ): Promise<void> {
    // The fence read is the only await before the admission bookkeeping below,
    // which stays synchronous so two concurrent runs cannot claim one id.
    await assertNotFenced([
      { scope: "user", userId: invocation.userId },
      {
        scope: "relationship",
        userId: invocation.userId,
        characterId: invocation.characterId,
      },
    ]);
    if (this.closing) throw new Error("Agent runtime is shutting down");
    if (this.active.has(invocation.invocationId)) throw new Error("invocation id is already active");
    const pool = invocation.memoryMode === "private" ? "private" : "normal";
    const limit = this.options.maxConcurrentAgents?.[pool] ?? Number.POSITIVE_INFINITY;
    // SPEC: the pool bounds live DSH agents, not post-agent cleanup.
    const activeInPool = [...this.active.values()].filter(({ invocation: current, agentDisposed }) =>
      !agentDisposed && (current.memoryMode === "private" ? "private" : "normal") === pool).length;
    if (activeInPool >= limit) {
      throw new CompanionCapacityError(pool);
    }
    const active = new ActiveInvocation(invocation);
    this.active.set(invocation.invocationId, active);
    let workspace: AttemptWorkspace | undefined;
    let sequence = 0;
    let terminalCommitted = false;
    let handle: Awaited<ReturnType<AgentRegistry["create"]>> | undefined;
    let ctx: Context | undefined;
    let deadlineTimer: NodeJS.Timeout | undefined;
    let failurePhase: "composition" | "workspace" | "agent" = "composition";
    let turnFailure: LlmFailure | undefined;
    let igrepFailure: "wake" | "search" | "memory" | undefined;
    let preflightCode: string | undefined;
    let terminalValidationCode: TerminalValidationCode | undefined;
    let eventTail = Promise.resolve();
    const event = (payload: EventPayload): Promise<void> => {
      const value = companionEventSchema.parse({
        ...payload,
        invocationId: invocation.invocationId,
        attemptId: invocation.attemptId,
        sequence: ++sequence,
        occurredAt: new Date().toISOString(),
      });
      eventTail = eventTail.then(() => port.emit(value));
      return eventTail;
    };
    const onAbort = () => active.cancel("transport");
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const deadlineMs = Date.parse(invocation.deadlineAt) - Date.now();
      if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
        await event({ type: "cancelled", reason: "timeout" });
        return;
      }
      deadlineTimer = setTimeout(() => active.cancel("timeout"), deadlineMs);
      const plugin = await this.options.plugin();
      if (plugin.name !== "igrep" || typeof plugin.apply !== "function") {
        preflightCode = "igrep_plugin_invalid";
        throw new Error("DSH_IGREP_PLUGIN_URL did not load the official igrep module namespace");
      }
      const mode = invocation.memoryMode === "private" ? "private" : "normal";
      const normalizedIgrepConfig = resolvedCompanionIgrepConfig(
        plugin,
        mode,
        this.options.igrepCommand,
      );
      const compositionPlan = createCompanionCompositionPlan(
        mode,
        normalizedIgrepConfig,
        {
          maxSteps: this.options.maxSteps ?? 8,
          igrepLlm: this.options.igrepLlm,
        },
      );
      if (compositionPlan.digest !== invocation.expectedProfileDigest) {
        preflightCode = "profile_digest_mismatch";
        throw new Error("expected profile digest does not match the active companion composition");
      }
      ctx = new Context();
      await applyCompanionComposition(ctx, { plugin, plan: compositionPlan });
      event({ type: "started", instance: this.instance, profileDigest: compositionPlan.digest });
      failurePhase = "workspace";
      workspace = await this.options.workspaces.prepare(invocation, active.cancellation.signal);
      if (mode === "normal") {
        // The attempt owns this copy; the zero-model writer restores physical
        // witnesses without maintaining profiles or changing product history.
        await reprojectIgrepMemory(this.options.igrepCommand, workspace.path, active.cancellation.signal, this.options.runIgrep);
      }
      failurePhase = "agent";
      const current = invocation.preparedTurn.messages.find((message) => message.sourceKind === "current_user");
      if (!current || current.role !== "user") throw new Error("current user message is missing");
      const memoryWorkspacePath = workspace.path;
      const igrepStartedAt = new Map<string, number>();
      ctx.on("tools/pre-execute", async (execution, next) => {
        if (execution.name === "memory_search") {
          igrepStartedAt.set(String(execution.callId), Date.now());
        }
        return next();
      }, { prepend: true });
      ctx.on("tools/post-execute", async (execution, result, next) => {
        let decision: PostToolDecision = await next();
        const operation = execution.name === "memory_search" ? "memory" : null;
        if (operation) {
          const startedAt = igrepStartedAt.get(String(execution.callId)) ?? Date.now();
          igrepStartedAt.delete(String(execution.callId));
          let resultCount: number | undefined;
          let evidenceMatches = 0;
          if (!result.isError && decision.kind === "accept") {
            try {
              const candidate = decision.value ?? result.value;
              if (decision.content !== undefined || !candidate || typeof candidate !== "object" || Array.isArray(candidate)
                || !Array.isArray(candidate.results) || (candidate.warnings !== undefined && (!Array.isArray(candidate.warnings) || candidate.warnings.length > 0))) {
                throw new Error("igrep memory-search returned unverifiable evidence");
              }
              // The official plugin has already enforced its scope binding and
              // source witnesses. Replace only the facts, through DSH's value
              // replacement seam, so schema validation/rendering remain official.
              const originals = await originalIgrepMemoryHits(memoryWorkspacePath, candidate.results, execution.signal);
              const results = candidate.results.map((hit, index) => {
                if (!hit || typeof hit !== "object" || Array.isArray(hit)) throw new Error("igrep memory-search returned unverifiable evidence");
                return { ...hit, snippet: originals[index]!.snippet };
              });
              decision = { kind: "accept", value: { ...candidate, results },
                ...(decision.additionalContexts ? { additionalContexts: decision.additionalContexts } : {}) };
              resultCount = results.length;
              evidenceMatches = auditRecallEvidenceMatches(results);
            } catch {
              decision = { kind: "block", feedback: [{ type: "text", text: "igrep memory-search returned unverifiable evidence" }] };
            }
          }
          if (resultCount === undefined) igrepFailure = operation;
          event({
            type: "igrep_observation",
            operation,
            outcome: resultCount === undefined
              ? "failure"
              : resultCount === 0
                ? "empty"
                : "hit",
            ...(resultCount === undefined ? {} : { resultCount }),
            ...(evidenceMatches > 0 ? { evidenceMatches } : {}),
            durationMs: Math.max(0, Date.now() - startedAt),
          });
        }
        return decision;
      }, { prepend: true });
      const modelRequests: CompanionModelRequestEvidence[] = [];
      const adapter = this.options.adapter(
        invocation.preparedTurn.profile,
        invocation.preparedTurn.requiredAction?.name,
        {
          maxInputTokens: invocation.preparedTurn.budget.maxInputTokens,
          replayMessageIds: invocation.preparedTurn.messages.filter(message => message.sourceKind === "replay").map(message => message.id),
          observeRequest: evidence => { modelRequests.push(evidence); },
          ...(needsFactualSampling(current.content)
            ? { samplingTemperature: Math.min(invocation.preparedTurn.profile.sampling.temperature, 0.2) }
            : {}),
        },
      );
      ctx.llm.registerAdapter([invocation.preparedTurn.profile.provider], adapter);

      let latestAssistant: AssistantMessage | undefined;
      const totalUsage = { promptTokens: 0, completionTokens: 0, reasoningTokens: 0 };
      let usageComplete = true;
      let latestFinish: StreamChunk & { type: "finish" } | undefined;
      let providerAttribution: ReturnType<typeof wireAttribution>;
      let acknowledgement: ReturnType<typeof imageAcknowledgement> | undefined;
      let turnEnd: TurnEndReason | undefined;
      let stepCount = 0;
      let currentStepText = "";
      // 必需图片动作没有第二次模型调用，所以工具那一步的台词是角色唯一说过的话。
      // 通用撤回规则照旧执行，这里只在撤回前留一份给短路使用。
      let retractedPreToolText = "";
      const seenSessionEventSeqs = new Set<number>();
      const bridge = new ToolBridge(port.executeTool, (payload) => {
        void event(payload);

      });

      // DSH explicitly supports short-circuiting llm/stream. Keep its tool-result
      // and stopping lifecycle, but never ask a caption model to reinterpret an
      // accepted Main action. No result or failed/unknown result cannot confirm.
      //
      // SPEC: 终态正文 = 工具调用之前那句经校验的角色台词；没有合格台词时才用确定性回执。
      // INTENT: 产品契约要求角色回一句人话、完成状态由附件承担（附件卡本身显示生成中/完成）。
      //   台词后再硬接一句系统回执会让角色出戏，所以二者只取其一。整段丢弃模型输出会让
      //   「今晚做什么？顺便发张照片」只换来一句系统回执，角色在整段等待里不在场；而且
      //   模型一旦真的开口，缓冲下来的流式文本会和终态文本不一致，让整轮失败。
      //   台词来自工具结果出现之前，所以它不可能重新解释一个已被接受的 Main 动作；
      //   校验不过就丢掉它，回落到只有回执 —— 也就是改动前的行为。这里不新增模型调用。
      ctx.on("llm/stream", async function* (options, next) {
        const action = invocation.preparedTurn.requiredAction;
        if (!action || bridge.callCount === 0) {
          yield* next();
          return;
        }
        options.signal?.throwIfAborted();
        // SPEC: a product rejection from Main (another photo still in flight,
        // a bad request, no credit) is a known outcome, not a broken run. The
        // model sees it as the tool's error result and answers in character;
        // the failed attachment card carries the product fact.
        // INTENT: decided 2026-10-04. Four of five `invocation_failed` Turns
        // in 14 days were `rate_limited` rejections; each ended as "Reply
        // unavailable" with the Character silent. An `unknown` outcome (no
        // acknowledgement at all) still cannot be spoken over.
        if (bridge.callCount === 1 && bridge.lastResult?.outcome === "failed") {
          yield* next();
          return;
        }
        if (bridge.callCount !== 1 || bridge.lastResult?.outcome !== "succeeded") {
          throw new Error("required image action has no successful Main acknowledgement");
        }
        acknowledgement = imageAcknowledgement(current.content, action.replyLocale);
        const leadIn = acceptableRequiredImageLeadIn(
          currentStepText || retractedPreToolText,
          current.content,
          invocation.preparedTurn.tools,
        );
        // 缓冲的引子会作为终态正文的一部分重新流出，这里先清空，避免重复计入。
        currentStepText = "";
        // 台词原本是给回执引路的，结尾冒号在独立成句后会悬空。
        const text = leadIn?.replace(/\s*[:：]\s*$/u, "…") || acknowledgement.content;
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "text-delta", index: 0, text };
        yield { type: "block-end", index: 0, block: { type: "text", text } };
        // This acknowledgement never calls the adapter. Its known zero cost
        // must not make a measured tool step look unmeasured.
        yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 } };
        yield { type: "finish", reason: { kind: "stop" } };
      }, { prepend: true });

      // Live chunks are transient Agent frames; the durable assistant/message
      // that embeds the same stream is appended before the attempt's end frame.
      ctx.on("agent/assistant-stream", ({ frame }) => {
        if (frame.type !== "chunk") return;
        const chunk = frame.chunk;
        if (chunk.type === "text-delta" && chunk.text) {
          currentStepText += chunk.text;
          // Required image replies are short and have deterministic language /
          // process-exposure checks. Buffer them until terminal validation so
          // invalid prose never leaks into user-visible SSE as provisional text.
          if (!invocation.preparedTurn.requiredAction) {
            event({ type: "text_delta", delta: chunk.text });
          }
        }
        if (chunk.type === "finish") {
          latestFinish = chunk;
          providerAttribution = wireAttribution(chunk) ?? providerAttribution;
        }
      });

      ctx.on("session/event", (_session, sessionEvent) => {
        // Cordis can surface the same durable Session event through more than
        // one publication path when plugins observe the log. User-visible SSE
        // is keyed by the Session seq, so one durable event is emitted once.
        if (seenSessionEventSeqs.has(sessionEvent.seq)) return;
        seenSessionEventSeqs.add(sessionEvent.seq);
        if (sessionEvent.type === "assistant/message") {
          latestAssistant = sessionEvent.data.message;
          // DSH's completion anchor carries usage for one model request. A
          // tool round trip adds another request; Main records the whole Turn.
          const usage = wireUsage(sessionEvent.data.usage);
          // A later measured step cannot turn an earlier unknown cost into zero.
          if (!usage) usageComplete = false;
          else {
            totalUsage.promptTokens += usage.promptTokens;
            totalUsage.completionTokens += usage.completionTokens;
            totalUsage.reasoningTokens += usage.reasoningTokens;
            event({ type: "usage", usage });
            if (usage.reasoningTokens > 0) {
              event({ type: "reasoning_usage", reasoningTokens: usage.reasoningTokens });
            }
          }
        } else if (sessionEvent.type === "turn/end") {
          turnEnd = sessionEvent.data.reason;
          if (turnEnd.kind === "error") turnFailure = turnEnd.error;
        }
      });

      let residentProfile = "";
      let supportedProfileLines: ReadonlySet<string> = new Set();
      let recallContext: string | undefined;
      if (mode === "normal") {
        const workspacePath = workspace.path;
        const signal = active.cancellation.signal;
        const recallQuery = current.content.trim();
        // Wake (resident profile) and pre-recall (episodic notes for this
        // message) are independent igrep processes; run them side by side so
        // the turn pays for the slower one, not the sum.
        const [wake, recall] = await Promise.all([
          timed(() => observeIgrepWake(
            this.options.igrepCommand,
            workspacePath,
            signal,
            this.options.runIgrep,
          )),
          shouldPreRecall(recallQuery)
            ? timed(() => recallIgrepMemory(
                this.options.igrepCommand,
                workspacePath,
                recallQuery,
                // Fast recall is sub-second when healthy (p90 1.8 s measured);
                // past this the reply goes out without it rather than waiting
                // on a loaded maintenance model.
                { signal: AbortSignal.any([signal, AbortSignal.timeout(PRE_RECALL_TIMEOUT_MS)]) },
                this.options.runIgrep,
              ))
            : Promise.resolve(null),
        ]);
        if (!wake.ok) {
          igrepFailure = "wake";
          event({ type: "igrep_observation", operation: "wake", outcome: "failure", durationMs: wake.durationMs });
          throw wake.error;
        }
        event({
          type: "igrep_observation",
          operation: "wake",
          outcome: wake.value.outcome,
          resultCount: wake.value.resultCount,
          durationMs: wake.durationMs,
        });
        residentProfile = wake.value.profile;
        supportedProfileLines = await readSupportedProfileLines(join(workspacePath, ".igrep"));
        if (recall?.ok) {
          const evidenceMatches = auditRecallEvidenceMatches(recall.value.results);
          event({
            type: "igrep_observation",
            operation: "memory",
            outcome: recall.value.outcome,
            resultCount: recall.value.resultCount,
            ...(evidenceMatches > 0 ? { evidenceMatches } : {}),
            durationMs: recall.durationMs,
          });
          const transcript = invocation.preparedTurn.messages
            .filter((message) => message.sourceKind === "replay" || message.sourceKind === "current_user")
            .map((message) => message.content);
          recallContext = renderRecallContext(selectRecallNotes(recall.value.notes, transcript, MAX_RECALL_NOTES))
            ?? (asksAboutMemory(recallQuery) ? EMPTY_RECALL_CONTEXT : undefined);
        } else if (recall) {
          // SPEC: a failed or slow pre-recall degrades to a reply without
          // recalled moments. The failure is recorded in the Turn's igrep
          // evidence (memory.failures) and in the log; the reply still happens.
          // INTENT: decided 2026-10-04. This used to fail the whole Turn so a
          // memory-enabled reply could never silently be memory-blind; in
          // practice the two failures in 14 days were both the 30 s timeout
          // under model-server load, and the user got "Reply unavailable"
          // instead of an answer. The resident profile from wake still
          // reaches the model, and the next Turn recalls again.
          event({ type: "igrep_observation", operation: "memory", outcome: "failure", durationMs: recall.durationMs });
          process.stderr.write(`${JSON.stringify({
            level: "warn", component: "chat", event: "companion_recall_degraded",
            attemptId: invocation.attemptId, durationMs: recall.durationMs, errorType: describeInvocationCause(recall.error),
          })}\n`);
        }
      }
      handle = await ctx.agents.create({
        sessionId: SessionId(invocation.attemptId),
        meta: { cwd: workspace.path },
        seed: buildReplaySeed(invocation, recallContext),
        signal: active.cancellation.signal,
        agentOptions: {
          provider: invocation.preparedTurn.profile.provider,
          model: invocation.preparedTurn.profile.model,
          maxTokens: invocation.preparedTurn.profile.maxOutputTokens,
        },
        setup: async (agentCtx) => {
          // The official memory switch also registers memory_record. Main owns
          // durable memory through committed-Turn projection; this attempt may
          // only read it. DSH restrictions cover both schemas and dispatch, and
          // leave the explicitly authorized scope-local image tools below intact.
          agentCtx.tools.restrict({
            allow: mode === "normal"
              ? ctx!.tools.schemas().filter(tool => tool.name === "memory_search").map(tool => tool.name)
              : [],
          });
          invocation.preparedTurn.messages
            .filter((message) => message.role === "system")
            .forEach((message, index) => {
              agentCtx.systemPrompt.section({
                name: `idream:system:${index}`,
                order: -50 + index,
                text: message.content,
              });
            });
          if (mode === "normal") {
            agentCtx.systemPrompt.section({
              name: "tool:memory_search",
              order: 122,
              text: COMPANION_MEMORY_GUIDANCE,
            });
            agentCtx.systemPrompt.variable(
              "igrep_memory_profile",
              () => renderResidentProfile(residentProfile, supportedProfileLines),
            );
          }

          for (const tool of invocation.preparedTurn.tools) {
            const definition: ToolDefinition = {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
              timeoutMs: deadlineMs,
              output: {
                schema: {
                  type: "object",
                  additionalProperties: false,
                  properties: { payload: { type: "string" } },
                  required: ["payload"],
                },
                render: (_args, value) => [{
                  type: "text",
                  text: String((value as { payload: string }).payload),
                }],
              },
              async execute(args, execution) {
                const requiredAction = invocation.preparedTurn.requiredAction;
                if (!requiredAction || requiredAction.name !== tool.name) {
                  throw new Error("image tool requires an authorized user image action");
                }
                if (requiredAction && bridge.callCount > 0) {
                  throw new Error("required image action may execute only once");
                }
                const call = {
                  attemptId: invocation.attemptId,
                  callId: String(execution.callId),
                  name: tool.name,
                  effectScope: "turn_action",
                  intent: {
                    requestedNudity: requiredAction.requestedNudity,
                  },
                  arguments: args,
                } as CompanionToolCall;
                const result = await bridge.execute(call, execution.signal);
                if (result.outcome !== "succeeded") {
                  // INVARIANT: Chat owns the effect outcome, while DSH owns the
                  // think-act-observe loop. A failed/unknown Chat result must
                  // enter that loop as a tool error instead of a successful
                  // JSON value or the next step may claim an effect happened.
                  // A product rejection is phrased for the next model step,
                  // which answers the user in character; the raw code stays
                  // for the log and the attachment card.
                  throw new Error(result.outcome === "failed"
                    ? `The photo could not be started this time (${result.error.code}). Answer them in character in one or two short sentences: it will have to wait. Do not mention tools, systems, errors or this message.`
                    : `${result.error.code}: ${result.error.message}`);
                }
                return { payload: JSON.stringify(result) };
              },
            };
            agentCtx.tools.register(definition);
          }

          agentCtx.on("agent/pre-step", async (payload, next) => {
            stepCount += 1;
            if (payload.step > (this.options.maxSteps ?? 8)) {
              throw new Error("invocation exceeded its DSH step budget");
            }
            // SPEC: text emitted before a tool call is provisional. A new DSH
            // step retracts it so Chat never confuses execution prose with the
            // final assistant answer while still streaming real provider text.
            if (payload.step > 1 && currentStepText) {
              retractedPreToolText = currentStepText;
              currentStepText = "";
              event({ type: "text_reset" });
            }
            // Retract provisional text before rejecting the next step. An
            // unverifiable lookup cannot become a successful remembered answer.
            if (igrepFailure) throw new Error("companion memory evidence is unavailable");
            return next();
          }, { prepend: true });

          agentCtx.on("agent/turn-stopping", async () => {
            const requiredAction = invocation.preparedTurn.requiredAction;
            const decision = evaluateTerminalCandidate({
              attemptId: invocation.attemptId,
              assistantContent: latestAssistant ? assistantText(latestAssistant) : undefined,
              finishReasonKind: latestFinish?.reason.kind,
              currentUserText: current.content,
              requiredAction,
              tools: invocation.preparedTurn.tools,
              toolCalls: bridge.callCount,
              reservations: bridge.reservations,
              profile: invocation.preparedTurn.profile,
              usage: usageComplete ? { ...totalUsage } : null,
              steps: stepCount,
              completedAt: new Date().toISOString(),
              modelRequests,
              ...(acknowledgement ? { acknowledgement: {
                version: acknowledgement.version,
                locale: acknowledgement.locale,
              } } : {}),
              ...(providerAttribution ? { attribution: providerAttribution } : {}),
            });
            if (!decision.accepted) {
              if (decision.code) terminalValidationCode = decision.code;
              // An unexecuted tool payload already reached the stream as
              // provisional text; retract it before the attempt fails.
              if (decision.code === "unexecuted_tool_payload" && currentStepText) {
                currentStepText = "";
                event({ type: "text_reset" });
              }
              throw new Error(decision.message);
            }
            const candidate = decision.candidate;
            const content = candidate.content;
            // Some adapters only expose the assembled assistant message. Keep a
            // terminal fallback, but never duplicate text already streamed.
            if (!currentStepText) {
              currentStepText = content;
              event({ type: "text_delta", delta: content });
            } else if (currentStepText !== content) {
              throw new Error("streamed assistant text differs from terminal message");
            } else if (requiredAction) {
              event({ type: "text_delta", delta: content });
            }
            await event({ type: "terminal_candidate", candidate });
            const ack = await port.commit(candidate, active.cancellation.signal);
            if (ack.attemptId !== invocation.attemptId) {
              throw new Error("commit ack attempt id mismatch");
            }
            if (!ack.accepted) throw new Error(`commit rejected: ${ack.error.code}`);
            terminalCommitted = true;
          }, { prepend: true });
        },
      });
      const agent = handle.agent;
      active.agentCancel = (reason) => {
        agent.cancel(reason === "user" ? { kind: "user" } : { kind: "hook", reason });
      };
      if (active.cancelReason) active.agentCancel(active.cancelReason);
      agent.followup(freezeMessage({
        id: MessageId(current.id),
        role: "user",
        source: { kind: "user" },
        content: [{ type: "text", text: current.content }],
      }));
      await agent.whenIdle();

      await handle.dispose();
      handle = undefined;
      active.agentDisposed = true;
      await workspace.discard();
      workspace = undefined;
      if (active.cancelReason) {
        await event({ type: "cancelled", reason: active.cancelReason });
        return;
      }
      if (!terminalCommitted) {
        const reason = turnEnd?.kind === "error" ? turnEnd.error : undefined;
        throw new Error(reason?.message ?? "turn ended without an accepted commit");
      }
      await eventTail;
    } catch (error) {
      if (active.cancelReason) {
        await event({ type: "cancelled", reason: active.cancelReason });
      } else {
        const failure = invocationFailure({
          terminalCommitted,
          phase: failurePhase,
          ...(turnFailure ? { turnFailure } : {}),
          ...(igrepFailure ? { igrepFailure } : {}),
          ...(preflightCode ? { preflightCode } : {}),
          ...(terminalValidationCode ? { terminalValidationCode } : {}),
        });
        // SPEC: 失败日志要能定位到哪一段坏了，但只用分类，不用自由文本。
        // INTENT: 这行过去只有 "invocation_failed" 一个词 —— 线上整轮聊天失败、
        //   用户看到一个空气泡，运维却分不清是模型、工具还是工作区出的问题。
        //   补上异常类型与各段的 code 就够定位；报文本身见 describeInvocationCause。
        process.stderr.write(`${JSON.stringify({
          level: "error",
          component: "chat",
          event: "companion_invocation_failed",
          invocationId: invocation.invocationId,
          attemptId: invocation.attemptId,
          phase: failurePhase,
          code: failure.code,
          retryable: failure.retryable,
          errorType: describeInvocationCause(error),
          ...(turnFailure
            ? {
                providerCode: turnFailure.code,
                ...(turnFailure.status !== undefined
                  ? { providerStatus: turnFailure.status }
                  : {}),
              }
            : {}),
          ...(igrepFailure ? { igrepFailure } : {}),
          ...(preflightCode ? { preflightCode } : {}),
        })}\n`);
        await event({
          type: "failed",
          error: failure,
        });
      }
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      signal?.removeEventListener("abort", onAbort);
      if (handle) await handle.dispose().catch(() => undefined);
      if (ctx) await ctx.fiber.dispose().catch(() => undefined);
      if (workspace) {
        await workspace.discard().catch(() => undefined);
      }
      this.active.delete(invocation.invocationId);
    }
  }

  cancel(
    invocationId: string,
    reason: "user" | "timeout" | "shutdown" | "transport",
  ): boolean {
    const active = this.active.get(invocationId);
    if (!active) return false;
    active.cancel(reason);
    return true;
  }

  async purge(request: WorkspacePurgeRequest): Promise<number> {
    const scope: FenceScope = request.scope === "user"
      ? { scope: "user", userId: request.userId }
      : {
          scope: "relationship",
          userId: request.userId,
          characterId: request.characterId,
        };
    // The drain fence rejects new invocations for exactly this scope while the
    // bytes are being removed; the store writes the durable fence when the
    // purge is permanent.
    return withDrainFence(scope, () => this.withMaintenance(async () => {
      const matches = () => [...this.active.values()].filter(({ invocation }) =>
        invocation.userId === request.userId
        && (request.scope === "user" || invocation.characterId === request.characterId));
      for (const active of matches()) active.cancel("user");
      while (matches().length > 0) await new Promise((resolve) => setTimeout(resolve, 10));
      return this.options.workspaces.purge(request);
    }));
  }

  async prepareRebuild(
    request: CompanionWorkspaceRebuildSource,
    signal?: AbortSignal,
  ): Promise<{ rebuildId: string; sessions: number; messages: number }> {
    if (!this.options.memoryBuilder) throw new Error("igrep workspace build is not configured");
    if (!request.fence) throw new Error("relationship rebuild prepare requires a fence");
    // INVARIANT: Main already isolates destructive mutations and cancels exact
    // affected attempts. A candidate rebuild must never cancel a newer turn.
    return this.options.workspaces.prepareRelationshipRebuild(
      request,
      request.fence,
      { seed: request.mode === "project" ? "canonical" : "empty" },
      (workspace, transcriptsRoot) => this.options.memoryBuilder!.build(workspace, request, signal, transcriptsRoot),
      signal,
    );
  }

  async promoteRebuild(
    request: CompanionWorkspaceRebuildPromotion,
    signal?: AbortSignal,
  ): Promise<{ sessions: number; messages: number }> {
    signal?.throwIfAborted();
    // Attempt workspaces are immutable copies. The canonical pointer may
    // advance underneath a normal turn; private turns never read it.
    return this.options.workspaces.promoteRelationshipRebuild(request, signal);
  }

  async discardRebuild(request: CompanionWorkspaceRebuildPromotion): Promise<void> {
    await this.options.workspaces.discardRelationshipRebuild(request);
  }

  /** Maintenance is rare; one process-wide queue makes purge/rebuild ordering explicit. */
  private async withMaintenance<T>(run: () => Promise<T>): Promise<T> {
    const previous = this.maintenanceTail;
    const mine = Promise.withResolvers<void>();
    this.maintenanceTail = previous.then(() => mine.promise);
    await previous;
    try {
      return await run();
    } finally {
      mine.resolve();
    }
  }

  async shutdown(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    for (const active of this.active.values()) active.cancel("shutdown");
    while (this.active.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await this.maintenanceTail;
  }
}
