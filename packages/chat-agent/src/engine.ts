import { Context } from "@deepseek-ai/cordis";
import type { AgentRegistry } from "@deepseek-ai/dsh-agent";
import {
  CallId,
  LlmAdapter,
  MessageId,
  freezeMessage,
  type AssistantMessage,
  type StreamChunk,
  type TokenUsage,
  type ToolResultMessage,
  type UserMessage,
} from "@deepseek-ai/dsh-llm";
import { Session, SessionId, type SessionEvent, type TurnEndReason } from "@deepseek-ai/dsh-session";
import { type JsonValue, type ToolDefinition } from "@deepseek-ai/dsh-tools";
import {
  companionEventSchema,
  companionToolResultSchema,
  type CompanionCommitAck,
  type CompanionEvent,
  type CompanionInvocation,
  type CompanionLegacyMemoryImport,
  type CompanionReadiness,
  type CompanionRuntimeRequest,
  type CompanionRuntimeResponse,
  type CompanionTerminalCandidate,
  type CompanionToolCall,
  type CompanionToolResult,
  type CompanionWorkspaceRebuild,
  type PreparedTurnMessage,
  type PreparedTurnProfile,
} from "@idream/shared/chat/companion-runtime";
import type { InvocationService } from "./server";
import {
  applyCompanionComposition,
  createCompanionCompositionPlan,
  resolvedCompanionIgrepConfig,
} from "./composition";
import type {
  AttemptWorkspace,
  AttemptWorkspaceStore,
  LegacyRecallParityEvidence,
  WorkspacePurgeRequest,
} from "./workspace";
import {
  legacyRecallProbeSetChecksum,
  verifyLegacyMemoryImport,
  type IgrepPluginModule,
} from "./igrep";
import { createSidecarInstanceIdentity } from "./sidecar-instance";

type ControlFrame = Exclude<CompanionRuntimeRequest, { type: "run" }>;
type EventPayload = CompanionEvent extends infer Event
  ? Event extends CompanionEvent
    ? Omit<Event, "invocationId" | "attemptId" | "sequence" | "occurredAt">
    : never
  : never;

export interface CompanionEngineOptions {
  instance?: CompanionReadiness["instance"];
  workspaces: AttemptWorkspaceStore;
  plugin(): Promise<IgrepPluginModule>;
  adapter(profile: PreparedTurnProfile): LlmAdapter;
  igrepCommand: string;
  igrepLlm: { url: string; model: string };
  rebuilder?: {
    rebuild(
      workspace: string,
      request: CompanionWorkspaceRebuild,
    ): Promise<{ sessions: number; messages: number }>;
  };
  legacyImporter?: {
    readonly version: string;
    import(
      workspace: string,
      request: CompanionLegacyMemoryImport,
      signal?: AbortSignal,
    ): Promise<{
      entries: number;
      written: number;
      igrepVersion: string;
      recallParity: LegacyRecallParityEvidence;
    }>;
  };
  maxSteps?: number;
  maxConcurrentAgents?: { normal: number; private: number };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  return Promise.withResolvers<T>();
}

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

function wireUsage(usage?: TokenUsage) {
  return {
    promptTokens: (usage?.inputTokens ?? 0)
      + (usage?.cacheReadTokens ?? 0)
      + (usage?.cacheWriteTokens ?? 0),
    completionTokens: usage?.outputTokens ?? 0,
    reasoningTokens: usage?.reasoningTokens ?? 0,
  };
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

function seedMessage(message: PreparedTurnMessage, profile: PreparedTurnProfile) {
  if (message.role === "assistant") {
    return freezeMessage({
      id: MessageId(message.id),
      role: "assistant" as const,
      source: { kind: "model" as const, provider: profile.provider, model: profile.model },
      content: [
        ...(message.content ? [{ type: "text" as const, text: message.content }] : []),
        ...(message.tool_calls ?? []).map((call) => ({
          type: "tool-call" as const,
          id: CallId(call.id),
          name: call.function.name,
          arguments: call.function.arguments,
        })),
      ],
    });
  }
  if (message.role === "tool") {
    return freezeMessage({
      id: MessageId(message.id),
      role: "user" as const,
      source: { kind: "tool" as const, callId: CallId(message.tool_call_id) },
      content: [{
        type: "tool-result" as const,
        toolCallId: CallId(message.tool_call_id),
        content: [{ type: "text" as const, text: message.content }],
        isError: false,
      }],
    });
  }
  return freezeMessage({
    id: MessageId(message.id),
    role: "user" as const,
    source: { kind: "plugin" as const, plugin: "idream", form: "replay" } as never,
    content: [{ type: "text" as const, text: message.content }],
  });
}

export function buildReplaySeed(invocation: CompanionInvocation): readonly SessionEvent[] {
  const replay = invocation.preparedTurn.messages.filter(
    (message) => message.role !== "system" && message.sourceKind !== "current_user",
  );
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
      seed.append("user/message", seedMessage(item, invocation.preparedTurn.profile) as UserMessage, {
        surfaceOp: "append",
      });
      continue;
    }
    if (item.role === "assistant") {
      if (assistantInStep) closeStep();
      open();
      const message = seedMessage(item, invocation.preparedTurn.profile) as AssistantMessage;
      seed.append("assistant/message", { turn, step, message }, {
        surfaceOp: "append",
        sourceEventSeqs: [],
      });
      assistantInStep = true;
      for (const call of item.tool_calls ?? []) {
        pendingCalls.add(call.id);
        seed.append("tool/call", {
          turn,
          step,
          callId: CallId(call.id),
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
  return seed.events;
}

class ToolBridge {
  private readonly entries = new Map<string, {
    name: CompanionToolCall["name"];
    startedAt: number;
    result?: CompanionToolResult;
    canonical?: string;
    waiting: Deferred<CompanionToolResult>;
  }>();

  constructor(
    private readonly invocation: CompanionInvocation,
    private readonly emit: (frame: CompanionRuntimeResponse) => void,
    private readonly event: (event: EventPayload) => void,
  ) {}

  get callCount(): number {
    return this.entries.size;
  }

  async execute(call: CompanionToolCall, signal: AbortSignal): Promise<CompanionToolResult> {
    const key = `${call.attemptId}\0${call.callId}`;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { name: call.name, startedAt: Date.now(), waiting: deferred() };
      this.entries.set(key, entry);
      this.emit({ protocolVersion: 1, type: "tool_call", invocationId: this.invocation.invocationId, call });
      this.event({ type: "tool_started", callId: call.callId, name: call.name });
    } else if (entry.name !== call.name) {
      return this.ambiguous(call, entry);
    }
    if (entry.result) return entry.result;
    const aborted = deferred<never>();
    const onAbort = () => aborted.reject(signal.reason ?? new Error("tool call aborted"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    try {
      const result = await Promise.race([entry.waiting.promise, aborted.promise]);
      this.event({
        type: "tool_finished",
        callId: call.callId,
        name: call.name,
        outcome: result.outcome,
        durationMs: Math.max(0, Date.now() - entry.startedAt),
      });
      return result;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  accept(result: CompanionToolResult): void {
    const parsed = companionToolResultSchema.parse(result);
    const key = `${parsed.attemptId}\0${parsed.callId}`;
    const entry = this.entries.get(key);
    if (!entry) throw new Error("tool result does not match an active tool call");
    const canonical = stableJson(parsed);
    if (entry.name !== parsed.name || (entry.canonical !== undefined && entry.canonical !== canonical)) {
      this.ambiguous(parsed, entry);
      return;
    }
    if (entry.result) return;
    entry.result = parsed;
    entry.canonical = canonical;
    entry.waiting.resolve(parsed);
  }

  private ambiguous(
    identity: Pick<CompanionToolResult, "attemptId" | "callId" | "name">,
    entry: { name: CompanionToolCall["name"]; result?: CompanionToolResult; canonical?: string; waiting: Deferred<CompanionToolResult> },
  ): CompanionToolResult {
    const unknown = companionToolResultSchema.parse({
      attemptId: identity.attemptId,
      callId: identity.callId,
      name: entry.name,
      outcome: "unknown",
      error: {
        code: "ambiguous_tool_result",
        message: "conflicting results were supplied for one attemptId/callId",
        retryable: false,
      },
    });
    entry.result = unknown;
    entry.canonical = stableJson(unknown);
    entry.waiting.resolve(unknown);
    return unknown;
  }
}

class ActiveInvocation {
  readonly commit = deferred<CompanionCommitAck>();
  readonly cancellation = new AbortController();
  agentCancel?: (reason: "user" | "timeout" | "shutdown") => void;
  cancelReason?: "user" | "timeout" | "shutdown";
  toolBridge?: ToolBridge;
  commitAwaiting = false;
  commitCanonical?: string;

  constructor(readonly invocation: CompanionInvocation) {}

  cancel(reason: "user" | "timeout" | "shutdown"): void {
    if (this.cancelReason) return;
    this.cancelReason = reason;
    this.cancellation.abort(new Error(`invocation cancelled: ${reason}`));
    this.agentCancel?.(reason);
  }

  acceptCommit(ack: CompanionCommitAck): void {
    if (!this.commitAwaiting) throw new Error("invocation is not awaiting a commit ack");
    if (ack.attemptId !== this.invocation.attemptId) throw new Error("commit ack attempt id mismatch");
    const canonical = stableJson(ack);
    if (this.commitCanonical !== undefined && this.commitCanonical !== canonical) {
      throw new Error("conflicting commit acks were supplied for one attempt");
    }
    if (this.commitCanonical !== undefined) return;
    this.commitCanonical = canonical;
    this.commit.resolve(ack);
  }
}

/** Exercise the same bridge state machines used by live invocations. */
export async function probeCompanionBridges(invocation: CompanionInvocation): Promise<void> {
  const emitted: CompanionRuntimeResponse[] = [];
  const events: EventPayload[] = [];
  const bridge = new ToolBridge(invocation, (frame) => emitted.push(frame), (event) => events.push(event));
  const controller = new AbortController();
  const call: CompanionToolCall = {
    attemptId: invocation.attemptId,
    callId: "readiness-tool-call",
    name: "generate_image_async",
    arguments: { prompt: "readiness" },
  };
  const pendingTool = bridge.execute(call, controller.signal);
  bridge.accept({
    attemptId: invocation.attemptId,
    callId: call.callId,
    name: call.name,
    outcome: "succeeded",
    output: { status: "readiness" },
  });
  if ((await pendingTool).outcome !== "succeeded" || !emitted.some((frame) => frame.type === "tool_call")) {
    throw new Error("tool bridge readiness probe did not round-trip");
  }

  const active = new ActiveInvocation(invocation);
  active.commitAwaiting = true;
  const ack: CompanionCommitAck = {
    attemptId: invocation.attemptId,
    accepted: true,
    status: "committed",
    terminalMessageId: "readiness-terminal",
    committedAt: new Date().toISOString(),
  };
  active.acceptCommit(ack);
  const accepted = await active.commit.promise;
  if (!accepted.accepted || accepted.terminalMessageId !== ack.terminalMessageId) {
    throw new Error("commit bridge readiness probe did not round-trip");
  }
}

export class CompanionEngine implements InvocationService {
  private readonly active = new Map<string, ActiveInvocation>();
  private readonly purgingUsers = new Map<string, number>();
  private readonly purgingRelationships = new Map<string, number>();
  private maintenanceTail = Promise.resolve();
  private closing = false;

  private readonly instance: CompanionReadiness["instance"];

  constructor(private readonly options: CompanionEngineOptions) {
    this.instance = options.instance ?? createSidecarInstanceIdentity();
  }

  async run(invocation: CompanionInvocation, emit: (frame: CompanionRuntimeResponse) => void): Promise<void> {
    if (this.closing) throw new Error("sidecar is shutting down");
    if (this.isPurging(invocation)) throw new Error("invocation workspace is being purged");
    if (this.active.has(invocation.invocationId)) throw new Error("invocation id is already active");
    const pool = invocation.memoryMode === "private" ? "private" : "normal";
    const limit = this.options.maxConcurrentAgents?.[pool] ?? Number.POSITIVE_INFINITY;
    const activeInPool = [...this.active.values()].filter(({ invocation: current }) =>
      (current.memoryMode === "private" ? "private" : "normal") === pool).length;
    if (activeInPool >= limit) {
      throw new Error(`${pool} companion agent pool is at capacity`);
    }
    const active = new ActiveInvocation(invocation);
    this.active.set(invocation.invocationId, active);
    let workspace: AttemptWorkspace | undefined;
    let sequence = 0;
    let terminalCommitted = false;
    let handle: Awaited<ReturnType<AgentRegistry["create"]>> | undefined;
    let ctx: Context | undefined;
    let deadlineTimer: NodeJS.Timeout | undefined;
    let sessionCreated = false;
    const event = (payload: EventPayload) => {
      const value = companionEventSchema.parse({
        ...payload,
        invocationId: invocation.invocationId,
        attemptId: invocation.attemptId,
        sequence: ++sequence,
        occurredAt: new Date().toISOString(),
      });
      emit({ protocolVersion: 1, type: "event", invocationId: invocation.invocationId, event: value });
    };

    try {
      const deadlineMs = Date.parse(invocation.deadlineAt) - Date.now();
      if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
        event({ type: "cancelled", reason: "timeout" });
        return;
      }
      deadlineTimer = setTimeout(() => active.cancel("timeout"), deadlineMs);
      const plugin = await this.options.plugin();
      if (plugin.name !== "igrep" || typeof plugin.apply !== "function") {
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
        throw new Error("expected profile digest does not match the active companion composition");
      }
      ctx = new Context();
      await applyCompanionComposition(ctx, { plugin, plan: compositionPlan });
      workspace = await this.options.workspaces.prepare(invocation);
      const igrepStartedAt = new Map<string, number>();
      ctx.on("tools/pre-execute", async (execution, next) => {
        if (execution.name === "igrep_search" || execution.name === "memory_search") {
          igrepStartedAt.set(String(execution.callId), Date.now());
        }
        return next();
      }, { prepend: true });
      ctx.on("tools/post-execute", async (execution, result, next) => {
        const operation = execution.name === "igrep_search"
          ? "search"
          : execution.name === "memory_search"
            ? "memory"
            : null;
        if (operation) {
          const startedAt = igrepStartedAt.get(String(execution.callId)) ?? Date.now();
          igrepStartedAt.delete(String(execution.callId));
          const value = !result.isError && result.value && typeof result.value === "object"
            && !Array.isArray(result.value)
            ? result.value as Record<string, unknown>
            : null;
          const resultCount = Array.isArray(value?.results) ? value.results.length : undefined;
          event({
            type: "igrep_observation",
            operation,
            outcome: result.isError || resultCount === undefined
              ? "failure"
              : resultCount === 0
                ? "empty"
                : "hit",
            ...(result.isError || resultCount === undefined ? {} : { resultCount }),
            durationMs: Math.max(0, Date.now() - startedAt),
          });
        }
        return next();
      }, { prepend: true });
      const adapter = this.options.adapter(invocation.preparedTurn.profile);
      ctx.llm.registerAdapter([invocation.preparedTurn.profile.provider], adapter);

      let latestAssistant: AssistantMessage | undefined;
      let latestUsage: TokenUsage | undefined;
      let latestFinish: StreamChunk & { type: "finish" } | undefined;
      let turnEnd: TurnEndReason | undefined;
      let stepCount = 0;
      let emittedText = "";
      const seenSessionEventSeqs = new Set<number>();
      const bridge = new ToolBridge(invocation, emit, event);
      active.toolBridge = bridge;

      ctx.on("session/event", (_session, sessionEvent) => {
        // Cordis can surface the same durable Session event through more than
        // one publication path when plugins observe the log. User-visible SSE
        // is keyed by the Session seq, so one durable event is emitted once.
        if (seenSessionEventSeqs.has(sessionEvent.seq)) return;
        seenSessionEventSeqs.add(sessionEvent.seq);
        if (sessionEvent.type === "assistant/chunk") {
          const chunk = sessionEvent.data.chunk;
          if (chunk.type === "text-delta" && chunk.text) {
            emittedText += chunk.text;
            event({ type: "text_delta", delta: chunk.text });
          }
          if (chunk.type === "finish") latestFinish = chunk;
        } else if (sessionEvent.type === "assistant/message") {
          latestAssistant = sessionEvent.data.message;
          latestUsage = sessionEvent.data.usage;
          const usage = wireUsage(latestUsage);
          event({ type: "usage", usage });
          if (usage.reasoningTokens > 0) {
            event({ type: "reasoning_usage", reasoningTokens: usage.reasoningTokens });
          }
        } else if (sessionEvent.type === "turn/end") {
          turnEnd = sessionEvent.data.reason;
        }
      });

      handle = await ctx.agents.create({
        sessionId: SessionId(invocation.attemptId),
        meta: { cwd: workspace.path },
        seed: buildReplaySeed(invocation),
        signal: active.cancellation.signal,
        agentOptions: {
          provider: invocation.preparedTurn.profile.provider,
          model: invocation.preparedTurn.profile.model,
          maxTokens: invocation.preparedTurn.profile.maxOutputTokens,
        },
        setup: async (agentCtx) => {
          invocation.preparedTurn.messages
            .filter((message) => message.role === "system")
            .forEach((message, index) => {
              agentCtx.systemPrompt.section({
                name: `idream:system:${index}`,
                order: -50 + index,
                text: message.content,
              });
            });

          for (const tool of invocation.preparedTurn.tools) {
            const definition: ToolDefinition = {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
              timeoutMs: invocation.preparedTurn.profile.timeout.completionMs,
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
                const call = {
                  attemptId: invocation.attemptId,
                  callId: String(execution.callId),
                  name: tool.name,
                  arguments: args,
                } as CompanionToolCall;
                const result = await bridge.execute(call, execution.signal);
                return { payload: JSON.stringify(result) } satisfies JsonValue;
              },
            };
            agentCtx.tools.register(definition);
          }

          agentCtx.on("agent/pre-step", async (payload, next) => {
            stepCount += 1;
            if (payload.step > (this.options.maxSteps ?? 8)) {
              throw new Error("invocation exceeded its DSH step budget");
            }
            return next();
          }, { prepend: true });

          agentCtx.on("agent/turn-stopping", async ({ signal }) => {
            if (!latestAssistant || !latestFinish) throw new Error("turn stopped without a terminal assistant candidate");
            // INVARIANT: Chat commits the exact bytes already delivered over
            // SSE. DSH tool loops may emit visible prose in more than one step,
            // while latestAssistant contains only the final step.
            const content = emittedText;
            if (!content) throw new Error("terminal assistant candidate is empty");
            if (latestFinish.reason.kind !== "stop" && latestFinish.reason.kind !== "max-tokens") {
              throw new Error(`non-terminal finish reason ${latestFinish.reason.kind}`);
            }
            const attribution = wireAttribution(latestFinish);
            const candidate: CompanionTerminalCandidate = {
              attemptId: invocation.attemptId,
              content,
              finishReason: latestFinish.reason.kind === "max-tokens" ? "length" : "stop",
              provider: invocation.preparedTurn.profile.provider,
              model: invocation.preparedTurn.profile.model,
              usage: wireUsage(latestUsage),
              execution: { steps: stepCount, toolCalls: bridge.callCount },
              completedAt: new Date().toISOString(),
              ...(attribution ? { attribution } : {}),
            };
            active.commitAwaiting = true;
            event({ type: "terminal_candidate", candidate });
            emit({ protocolVersion: 1, type: "commit", invocationId: invocation.invocationId, candidate });
            const aborted = deferred<never>();
            const onAbort = () => aborted.reject(signal.reason ?? new Error("commit wait aborted"));
            if (signal.aborted) onAbort();
            else signal.addEventListener("abort", onAbort, { once: true });
            try {
              const ack = await Promise.race([active.commit.promise, aborted.promise]);
              if (!ack.accepted) throw new Error(`commit rejected: ${ack.error.code}`);
              terminalCommitted = true;
            } finally {
              active.commitAwaiting = false;
              signal.removeEventListener("abort", onAbort);
            }
          }, { prepend: true });
        },
      });
      sessionCreated = true;
      const agent = handle.agent;
      active.agentCancel = (reason) => {
        agent.cancel(reason === "user" ? { kind: "user" } : { kind: "hook", reason });
      };
      if (active.cancelReason) active.agentCancel(active.cancelReason);
      event({ type: "started", instance: this.instance, profileDigest: compositionPlan.digest });
      const current = invocation.preparedTurn.messages.find((message) => message.sourceKind === "current_user");
      if (!current || current.role !== "user") throw new Error("current user message is missing");
      agent.followup(freezeMessage({
        id: MessageId(current.id),
        role: "user",
        source: { kind: "user" },
        content: [{ type: "text", text: current.content }],
      }));
      await agent.whenIdle();

      await handle.dispose();
      handle = undefined;
      if (!terminalCommitted) {
        await workspace.settleAndDiscard();
        workspace = undefined;
      }
      if (active.cancelReason) {
        event({ type: "cancelled", reason: active.cancelReason });
        return;
      }
      if (!terminalCommitted) {
        const reason = turnEnd?.kind === "error" ? turnEnd.error : undefined;
        throw new Error(reason?.message ?? "turn ended without an accepted commit");
      }
      if (!workspace) throw new Error("accepted turn lost its attempt workspace");
      await workspace.commit();
      workspace = undefined;
    } catch (error) {
      if (active.cancelReason) {
        event({ type: "cancelled", reason: active.cancelReason });
      } else {
        event({
          type: "failed",
          error: {
            code: terminalCommitted ? "memory_commit_failed" : "invocation_failed",
            message: error instanceof Error ? error.message : String(error),
            retryable: false,
          },
        });
      }
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (handle) await handle.dispose().catch(() => undefined);
      if (ctx) await ctx.fiber.dispose().catch(() => undefined);
      if (workspace) {
        await (sessionCreated ? workspace.settleAndDiscard() : workspace.discard())
          .catch(() => undefined);
      }
      this.active.delete(invocation.invocationId);
    }
  }

  async accept(frame: ControlFrame): Promise<void> {
    const active = this.active.get(frame.invocationId);
    if (!active) throw new Error("invocation is not active");
    if (frame.type === "cancel") {
      active.cancel(frame.reason);
      return;
    }
    if (frame.type === "commit_ack") {
      active.acceptCommit(frame.ack);
      return;
    }
    if (frame.result.attemptId !== active.invocation.attemptId) {
      throw new Error("tool result attempt id mismatch");
    }
    if (!active.toolBridge) throw new Error("invocation is not awaiting a tool result");
    active.toolBridge.accept(frame.result);
  }

  async purge(request: WorkspacePurgeRequest): Promise<number> {
    const userKey = request.userId;
    const relationshipKey = request.scope === "relationship"
      ? `${request.userId}\0${request.characterId}`
      : undefined;
    if (request.scope === "user") this.addFence(this.purgingUsers, userKey);
    else this.addFence(this.purgingRelationships, relationshipKey!);
    try {
      return await this.withMaintenance(async () => {
        const matches = () => [...this.active.values()].filter(({ invocation }) =>
          invocation.userId === request.userId
          && (request.scope === "user" || invocation.characterId === request.characterId));
        for (const active of matches()) active.cancel("user");
        while (matches().length > 0) await new Promise((resolve) => setTimeout(resolve, 10));
        return this.options.workspaces.purge(request);
      });
    } finally {
      if (request.scope === "user") this.removeFence(this.purgingUsers, userKey);
      else this.removeFence(this.purgingRelationships, relationshipKey!);
    }
  }

  async rebuild(
    request: CompanionWorkspaceRebuild,
  ): Promise<{ sessions: number; messages: number }> {
    if (!this.options.rebuilder) throw new Error("igrep workspace rebuild is not configured");
    const relationshipKey = `${request.userId}\0${request.characterId}`;
    if (this.hasFence(this.purgingUsers, request.userId)
      || this.hasFence(this.purgingRelationships, relationshipKey)) {
      throw new Error("invocation workspace is already being rebuilt or purged");
    }
    this.addFence(this.purgingRelationships, relationshipKey);
    try {
      return await this.withMaintenance(async () => {
        const matches = () => [...this.active.values()].filter(({ invocation }) =>
          invocation.userId === request.userId
          && invocation.characterId === request.characterId);
        for (const active of matches()) active.cancel("user");
        while (matches().length > 0) await new Promise((resolve) => setTimeout(resolve, 10));
        return this.options.workspaces.rebuildRelationship(
          request,
          (workspace) => this.options.rebuilder!.rebuild(workspace, request),
        );
      });
    } finally {
      this.removeFence(this.purgingRelationships, relationshipKey);
    }
  }

  async importLegacyMemory(request: CompanionLegacyMemoryImport, signal?: AbortSignal): Promise<{
    skipped: boolean;
    entries: number;
    written: number;
    checksum: string;
    igrepVersion: string;
    status: "cutover_ready";
    recallParity: LegacyRecallParityEvidence;
    completedAt: string;
  }> {
    if (!this.options.legacyImporter) {
      throw new Error("igrep legacy memory import is not configured");
    }
    const parsed = verifyLegacyMemoryImport(request);
    const relationshipKey = `${parsed.userId}\0${parsed.characterId}`;
    if (this.hasFence(this.purgingUsers, parsed.userId)
      || this.hasFence(this.purgingRelationships, relationshipKey)) {
      throw new Error("invocation workspace is already being rebuilt or purged");
    }
    this.addFence(this.purgingRelationships, relationshipKey);
    try {
      return await this.withMaintenance(async () => {
        const matches = () => [...this.active.values()].filter(({ invocation }) =>
          invocation.userId === parsed.userId
          && invocation.characterId === parsed.characterId);
        for (const active of matches()) active.cancel("user");
        while (matches().length > 0) await new Promise((resolve) => setTimeout(resolve, 10));
        const marker = {
          checksum: parsed.checksum,
          igrepVersion: this.options.legacyImporter!.version,
          probeSetChecksum: legacyRecallProbeSetChecksum(parsed),
        };
        const imported = await this.options.workspaces.importLegacyMemory(
          parsed,
          marker,
          async (workspace) => {
            const result = await this.options.legacyImporter!.import(workspace, parsed, signal);
            if (signal?.aborted) {
              throw signal.reason instanceof Error
                ? signal.reason
                : new Error("legacy memory import aborted");
            }
            return result;
          },
          signal,
        );
        if (imported.skipped) {
          return {
            skipped: true,
            entries: parsed.entries.length,
            written: 0,
            checksum: parsed.checksum,
            igrepVersion: imported.marker.igrepVersion,
            status: imported.marker.status,
            recallParity: imported.marker.recallParity,
            completedAt: imported.marker.completedAt,
          };
        }
        if (imported.result.igrepVersion !== marker.igrepVersion) {
          throw new Error("igrep legacy memory import version drifted");
        }
        return {
          skipped: false,
          entries: imported.result.entries,
          written: imported.result.written,
          checksum: parsed.checksum,
          igrepVersion: imported.result.igrepVersion,
          status: imported.marker.status,
          recallParity: imported.marker.recallParity,
          completedAt: imported.marker.completedAt,
        };
      });
    } finally {
      this.removeFence(this.purgingRelationships, relationshipKey);
    }
  }

  private isPurging(invocation: CompanionInvocation): boolean {
    return this.hasFence(this.purgingUsers, invocation.userId)
      || this.hasFence(
        this.purgingRelationships,
        `${invocation.userId}\0${invocation.characterId}`,
      );
  }

  private addFence(fences: Map<string, number>, key: string): void {
    fences.set(key, (fences.get(key) ?? 0) + 1);
  }

  private removeFence(fences: Map<string, number>, key: string): void {
    const count = fences.get(key) ?? 0;
    if (count <= 1) fences.delete(key);
    else fences.set(key, count - 1);
  }

  private hasFence(fences: Map<string, number>, key: string): boolean {
    return (fences.get(key) ?? 0) > 0;
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
