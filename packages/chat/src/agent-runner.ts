import { createHash } from "node:crypto";
import { chatTerminalAckSchema, type ChatTerminalCommit, type ChatToolEffect } from "@idream/shared/contracts";
import { COMPANION_PRODUCT_PROMPT_VERSION } from "@idream/shared";
import type {
  CompanionCommitAck,
  CompanionEvent,
  CompanionInvocation,
  CompanionTerminalCandidate,
  CompanionToolCall,
  CompanionToolResult,
} from "./agent-runtime/contracts.js";
import type { CompanionRuntimePort } from "./agent-runtime/engine.js";
import {
  agentRuntimeProfileDigest,
  agentRuntimeVersions,
  runCompanion,
} from "./agent-runtime/runtime.js";
import {
  admitAgentRun,
  appendAgentRunEvent,
  completeAgentRun,
  listIncompleteAgentRuns,
  readAgentRunInput,
  readAgentRunCompletion,
  readAgentRunProposal,
  writeAgentRunProposal,
  type AgentRunInput,
  type AgentRunProposal,
  type AgentRunRecoveryCandidate,
} from "./agent-run-store.js";
import { env } from "./env.js";
import { fenceAttemptsThrough, isFenced } from "./fence.js";
import { logger } from "./logger.js";
import {
  prepareCompanionTurn,
} from "./prepared-turn.js";
import { sceneForReply } from "./scene.js";
import { appendStreamEvent, streamKey } from "./stream.js";
import { stableJson } from "./stable-json.js";

interface ActiveAgentRun {
  controller: AbortController;
  userId: string;
  done: Promise<void>;
}

type TerminalPromptAttribution = ChatTerminalCommit["terminalEvidence"]["prompt"];

const activeRuns = new Map<string, ActiveAgentRun>();

/** The HTTP adapter hands over one signed input; this module owns admission and execution order. */
export async function acceptAgentRun(
  input: AgentRunInput,
): Promise<{ duplicate: boolean; terminal: boolean; tombstoned?: true }> {
  const admitted = await admitAgentRun(input);
  if (!admitted.terminal && !admitted.tombstoned) {
    startAgentRun({
      turnId: input.snapshot.turnId,
      attempt: input.snapshot.attempt,
      userId: input.snapshot.userId,
    });
  }
  return admitted;
}

/** Startup recovery is an AgentRun lifecycle operation, not worker orchestration. */
export async function recoverIncompleteAgentRuns(): Promise<{
  recovered: number;
  failed: number;
}> {
  const scan = await listIncompleteAgentRuns();
  for (const failure of scan.failures) {
    logger.warn(failure, "skipping invalid AgentRun recovery evidence");
  }
  let recovered = 0;
  for (const run of scan.runs) {
    if (startAgentRun(run)) recovered += 1;
  }
  return { recovered, failed: scan.failures.length };
}

function startAgentRun(run: AgentRunRecoveryCandidate): boolean {
  const { turnId, attempt, userId } = run;
  const key = runKey(turnId, attempt);
  if (activeRuns.has(key)) return false;
  const controller = new AbortController();
  const active: ActiveAgentRun = {
    controller,
    userId,
    done: Promise.resolve(),
  };
  activeRuns.set(key, active);
  active.done = executeAgentRun(turnId, attempt, controller.signal)
    .catch((error) => logger.error({ err: error, turnId, attempt }, "AgentRun failed"))
    .finally(() => {
      if (activeRuns.get(key) === active) activeRuns.delete(key);
    });
  return true;
}

export async function cancelAgentRun(turnId: string, attempt: number): Promise<boolean> {
  await fenceAttemptsThrough(turnId, attempt);
  const key = runKey(turnId, attempt);
  const active = activeRuns.get(key);
  if (!active) return false;
  active.controller.abort(new Error("cancelled by Main"));
  return true;
}

/** Account erasure waits until no in-process run can recreate purged files. */
export async function cancelAgentRunsForUser(userId: string): Promise<number> {
  const matching = [...activeRuns.values()].filter((run) => run.userId === userId);
  for (const run of matching) run.controller.abort(new Error("account erased by Main"));
  await Promise.all(matching.map((run) => run.done));
  return matching.length;
}

async function executeAgentRun(turnId: string, attempt: number, signal: AbortSignal): Promise<void> {
  if (await isFenced({ scope: "attempt", turnId, attempt })) return;
  const input = await readAgentRunInput(turnId, attempt);
  if (!input) throw new Error("AgentRun input is missing");
  if (await readAgentRunCompletion(turnId, attempt)) return;
  const snapshot = input.snapshot;
  const attemptId = `${snapshot.assistantMessageId}:${snapshot.attempt}`;
  const key = streamKey(snapshot.assistantMessageId);
  const existingProposal = await readAgentRunProposal(turnId, attempt);
  if (existingProposal) {
    await appendAgentRunEvent(turnId, attempt, "recovery.terminal_proposal", {
      attemptId: existingProposal.attemptId,
      terminalDigest: sha256(JSON.stringify(existingProposal.terminal)),
    });
    const replay = await settleTerminalProposal(existingProposal, key, true);
    if (!replay.accepted) throw new Error(replay.error.message);
    await finalizeAcceptedProposal(existingProposal, replay);
    return;
  }
  // SPEC: 「这一轮已经提交」只由证据本身表示 —— Main 接受的 ack 和它对应的
  // proposal。这里原先还并列一个 committed 布尔量，于是同一个事实存了两份，还得
  // 多一条「committed 了却没有证据」的分支去描述一个构造上不可能的状态。
  let committedProposal: AgentRunProposal | null = null;
  let committedAck: Extract<CompanionCommitAck, { accepted: true }> | null = null;
  let runtimeFailure: Extract<CompanionEvent, { type: "failed" }>["error"] | undefined;
  let runtimeCancellation: Extract<CompanionEvent, { type: "cancelled" }>["reason"] | undefined;
  let promptAttribution: TerminalPromptAttribution = {
    productPromptVersion: COMPANION_PRODUCT_PROMPT_VERSION,
    preparedTurnVersion: null,
    systemPromptDigest: null,
    soulFingerprint: null,
  };
  try {
    await appendStreamEvent(key, { type: "start", attempt: snapshot.attempt });
    await appendAgentRunEvent(turnId, attempt, "admitted", {
      attemptId,
      sessionId: snapshot.sessionId,
      userMessageId: snapshot.userMessageId,
      assistantMessageId: snapshot.assistantMessageId,
    });
    const prepared = await prepareCompanionTurn({ snapshot, authority: input.authority });
    promptAttribution = {
      productPromptVersion: prepared.trace.productPromptVersion,
      preparedTurnVersion: prepared.version,
      systemPromptDigest: prepared.trace.systemPromptDigest,
      soulFingerprint: prepared.trace.soulFingerprint,
    };
    const memoryMode = snapshot.memoryEnabled ? "normal" : "private";
    const { context, ...executionTurn } = prepared;
    const wire = executionTurn;
    const profileDigest = await agentRuntimeProfileDigest(memoryMode);
    const runtimeVersions = await agentRuntimeVersions();
    let runtimeInstance: { id: string; startedAt: string } | undefined;
    const igrepObservations = emptyIgrepObservations();
    const invocation: CompanionInvocation = {
      invocationId: `inv:${attemptId}`,
      attemptId,
      sessionId: snapshot.sessionId,
      userId: snapshot.userId,
      characterId: snapshot.characterId,
      preparedTurn: wire,
      memoryMode,
      expectedProfileDigest: profileDigest,
      deadlineAt: new Date(Date.now() + env.AGENT_RUN_DEADLINE_MS).toISOString(),
    };
    let sequence = 0;
    const port: CompanionRuntimePort = {
      emit: async (event) => {
        const trace = agentRunTraceEvent(event);
        if (trace) await appendAgentRunEvent(turnId, attempt, trace.kind, trace.payload);
        if (event.type === "started") runtimeInstance = event.instance;
        if (event.type === "failed") runtimeFailure = event.error;
        if (event.type === "cancelled") runtimeCancellation = event.reason;
        if (event.type === "igrep_observation") {
          const metric = igrepObservations[event.operation];
          metric.calls += 1;
          if (event.outcome === "hit") metric.hits += 1;
          if (event.outcome === "failure") metric.failures += 1;
          metric.evidenceMatches += event.evidenceMatches ?? 0;
        }
        sequence = await projectStreamEvent(key, snapshot.attempt, sequence, event);
      },
      executeTool: (call) => executeMainTool(call, snapshot.turnId, snapshot.attempt),
      commit: async (candidate) => {
        const scene = sceneForReply({
          previous: context.scene,
          userText: snapshot.userContent,
          assistantText: candidate.content,
        });
        const terminal: ChatTerminalCommit = {
          version: 1,
          turnId: snapshot.turnId,
          sessionId: snapshot.sessionId,
          assistantMessageId: snapshot.assistantMessageId,
          attempt: snapshot.attempt,
          status: "sent",
          content: candidate.content,
          model: candidate.model,
          promptTokens: candidate.usage.promptTokens,
          completionTokens: candidate.usage.completionTokens,
          sceneVersion: scene.version,
          scene,
          terminalEvidence: terminalEvidence(
            candidate,
            profileDigest,
            runtimeVersions,
            memoryMode,
            runtimeInstance,
            igrepObservations,
            promptAttribution,
          ),
        };
        const proposal: AgentRunProposal = {
          schemaVersion: 1,
          attemptId,
          terminal,
          proposedAt: new Date().toISOString(),
        };
        await writeAgentRunProposal(turnId, attempt, proposal);
        const ack = await settleTerminalProposal(proposal, key, false);
        if (ack.accepted) {
          committedProposal = proposal;
          committedAck = ack;
        }
        return ack;
      },
    };
    await runCompanion(invocation, port, signal);
    if (!committedProposal || !committedAck) {
      throw new Error("DSH ended without a terminal commit");
    }
    // INVARIANT: local terminal is downstream of Main's durable ACK. A crash
    // before this write replays the exact immutable proposal without rerunning
    // the model or any tool effect.
    await finalizeAcceptedProposal(committedProposal, committedAck);
  } catch (error) {
    if (committedAck) throw error;
    if (await readAgentRunCompletion(turnId, attempt)) return;
    // Once a candidate is durable, recovery may only replay it. Replacing it
    // with a generic failure would destroy exact Main CAS identity.
    if (await readAgentRunProposal(turnId, attempt)) throw error;
    const cancellation = classifyAgentRunCancellation(signal.aborted, runtimeCancellation);
    const cancelled = cancellation.cancelled;
    const reason = error instanceof Error ? error.message : "AgentRun failed";
    const terminal: ChatTerminalCommit = {
      version: 1,
      turnId: snapshot.turnId,
      sessionId: snapshot.sessionId,
      assistantMessageId: snapshot.assistantMessageId,
      attempt: snapshot.attempt,
      status: cancelled ? "cancelled" : "failed",
      content: "",
      model: null,
      promptTokens: null,
      completionTokens: null,
      sceneVersion: snapshot.sceneVersion,
      scene: snapshot.scene,
      terminalEvidence: agentRunFailureEvidence({
        cancelled,
        prompt: promptAttribution,
        runtimeCancellation: cancellation.reason,
        runtimeFailure,
        reason,
      }),
    };
    const proposal: AgentRunProposal = {
      schemaVersion: 1,
      attemptId,
      terminal,
      proposedAt: new Date().toISOString(),
    };
    await writeAgentRunProposal(turnId, attempt, proposal);
    await appendAgentRunEvent(turnId, attempt, "agent.failed", {
      cancelled,
      failureCode: cancellation.failureCode ?? runtimeFailure?.code ?? "agent_run_failed",
      reasonDigest: sha256(reason),
    });
    const ack = await settleTerminalProposal(proposal, key, false);
    if (ack.accepted) await finalizeAcceptedProposal(proposal, ack);
    else return;
    if (!cancelled) throw error;
  }
}

async function settleTerminalProposal(
  proposal: AgentRunProposal,
  stream: string,
  recovery: boolean,
): Promise<CompanionCommitAck> {
  const terminal = proposal.terminal;
  const response = await postMain("/api/internal/chat/turns/terminal", terminal);
  if (!response.ok) {
    const reason = `Main terminal commit HTTP ${response.status}`;
    // Keep exact recovery bytes for transport/auth/rate-limit failures. Only
    // Main's permanent input/identity rejections can end proposal recovery.
    if (![400, 404, 409, 410, 422].includes(response.status)) throw new Error(reason);
    const rejected = rejectedCommit(proposal.attemptId, reason);
    await appendAgentRunEvent(terminal.turnId, terminal.attempt, "main.terminal_rejected", {
      status: response.status,
      recovery,
    });
    await appendStreamEvent(stream, {
      type: "error",
      attempt: terminal.attempt,
      code: "terminal_rejected",
    }).catch(() => undefined);
    await completeAgentRun(terminal.turnId, terminal.attempt, {
      attemptId: proposal.attemptId,
      outcome: terminal.status === "cancelled" ? "cancelled" : "failed",
      evidence: terminal.terminalEvidence,
      completedAt: new Date().toISOString(),
    });
    return rejected;
  }
  const parsed = chatTerminalAckSchema.safeParse(await response.json());
  if (!parsed.success || parsed.data.terminalMessageId !== terminal.assistantMessageId) {
    throw new Error("Main terminal commit returned an invalid acknowledgement");
  }
  const result = parsed.data;
  const ack: CompanionCommitAck = {
    attemptId: proposal.attemptId,
    accepted: true,
    status: result.duplicate ? "duplicate" : "committed",
    terminalMessageId: result.terminalMessageId,
    committedAt: result.committedAt,
  };
  await appendAgentRunEvent(terminal.turnId, terminal.attempt, "main.terminal_committed", {
    ...result,
    recovery,
  });
  if (terminal.status === "sent") {
    // INVARIANT: SSE done is downstream of Main's durable commit ACK. It is
    // at-least-once across the final local-file write crash window.
    await appendStreamEvent(stream, {
      type: "done",
      attempt: terminal.attempt,
      usage: {
        promptTokens: terminal.promptTokens ?? 0,
        completionTokens: terminal.completionTokens ?? 0,
      },
    });
  } else {
    await appendStreamEvent(stream, {
      type: "error",
      attempt: terminal.attempt,
      code: terminalFailureCode(terminal),
    }).catch(() => undefined);
  }
  return ack;
}

async function finalizeAcceptedProposal(
  proposal: AgentRunProposal,
  ack: Extract<CompanionCommitAck, { accepted: true }>,
): Promise<void> {
  const terminal = proposal.terminal;
  await completeAgentRun(terminal.turnId, terminal.attempt, {
    attemptId: proposal.attemptId,
    outcome: terminal.status === "sent"
      ? "committed"
      : terminal.status === "cancelled" ? "cancelled" : "failed",
    evidence: terminal.terminalEvidence,
    completedAt: ack.committedAt,
  });
}

async function executeMainTool(
  call: CompanionToolCall,
  turnId: string,
  attempt: number,
): Promise<CompanionToolResult> {
  const effect: ChatToolEffect = {
    version: 2,
    turnId,
    attempt,
    callId: call.callId,
    name: call.name,
    effectScope: call.effectScope,
    intent: call.intent,
    arguments: call.arguments,
  };
  await appendAgentRunEvent(turnId, attempt, "tool.requested", {
    attemptId: call.attemptId,
    callId: call.callId,
    name: call.name,
    argumentsDigest: sha256(stableJson(call.arguments)),
  });
  for (let ackAttempt = 1; ackAttempt <= 2; ackAttempt += 1) {
    try {
      const response = await postMain("/api/internal/chat/tool-effects", effect);
      const value = await response.json() as Record<string, unknown>;
      if (response.ok && value.accepted === true) {
        return {
          attemptId: call.attemptId,
          callId: call.callId,
          name: call.name,
          outcome: "succeeded",
          output: value as never,
        };
      }
      if (response.status >= 500) {
        await appendAgentRunEvent(turnId, attempt, "tool.ack_unknown", {
          attemptId: call.attemptId,
          callId: call.callId,
          name: call.name,
          ackAttempt,
          status: response.status,
        });
        if (ackAttempt < 2) continue;
        return {
          attemptId: call.attemptId,
          callId: call.callId,
          name: call.name,
          outcome: "unknown",
          error: {
            code: "main_tool_ack_unknown",
            message: "Main tool effect outcome is unknown",
            retryable: true,
          },
        };
      }
      const error = record(value.error);
      const topLevelCode = typeof value.error === "string" ? value.error : undefined;
      const topLevelMessage = typeof value.message === "string" ? value.message : undefined;
      return {
        attemptId: call.attemptId,
        callId: call.callId,
        name: call.name,
        outcome: "failed",
        error: {
          code: typeof error?.code === "string"
            ? error.code
            : topLevelCode ?? `main_http_${response.status}`,
          message: typeof error?.message === "string"
            ? error.message
            : topLevelMessage ?? "Main rejected the tool effect",
          retryable: error?.retryable === true || response.status >= 500,
        },
      };
    } catch (error) {
      await appendAgentRunEvent(turnId, attempt, "tool.ack_unknown", {
        attemptId: call.attemptId,
        callId: call.callId,
        name: call.name,
        ackAttempt,
        errorDigest: sha256(error instanceof Error ? error.message : String(error)),
      });
      if (ackAttempt < 2) continue;
      return {
        attemptId: call.attemptId,
        callId: call.callId,
        name: call.name,
        outcome: "unknown",
        error: {
          code: "main_tool_ack_unknown",
          message: "Main tool effect outcome is unknown",
          retryable: true,
        },
      };
    }
  }
  throw new Error("unreachable Main tool acknowledgement loop");
}

async function projectStreamEvent(
  key: string,
  attempt: number,
  sequence: number,
  event: CompanionEvent,
): Promise<number> {
  if (event.type === "text_delta") {
    const next = sequence + 1;
    await appendStreamEvent(key, { type: "delta", attempt, seq: next, delta: event.delta });
    return next;
  }
  if (event.type === "text_reset") {
    const next = sequence + 1;
    await appendStreamEvent(key, { type: "replace", attempt, seq: next, content: "" });
    return next;
  }
  return sequence;
}

/** Local AgentRun evidence is content-free; Redis alone carries live deltas. */
export function agentRunTraceEvent(
  event: CompanionEvent,
): { kind: string; payload: unknown } | null {
  switch (event.type) {
    case "started":
      return {
        kind: "dsh.started",
        payload: { instance: event.instance, profileDigest: event.profileDigest },
      };
    case "tool_started":
      return {
        kind: "dsh.tool_started",
        payload: { callId: event.callId, name: event.name },
      };
    case "tool_finished":
      return {
        kind: "dsh.tool_finished",
        payload: {
          callId: event.callId,
          name: event.name,
          outcome: event.outcome,
          durationMs: event.durationMs,
        },
      };
    case "igrep_observation":
      return {
        kind: "dsh.igrep_observation",
        payload: {
          operation: event.operation,
          outcome: event.outcome,
          resultCount: event.resultCount,
          evidenceMatches: event.evidenceMatches,
          durationMs: event.durationMs,
        },
      };
    case "failed":
      return { kind: "dsh.failed", payload: { error: event.error } };
    case "cancelled":
      return { kind: "dsh.cancelled", payload: { reason: event.reason } };
    case "text_delta":
    case "text_reset":
    case "reasoning_usage":
    case "usage":
    case "heartbeat":
    case "terminal_candidate":
      return null;
  }
}

function terminalEvidence(
  candidate: CompanionTerminalCandidate,
  profileDigest: string,
  versions: { igrepVersion: string; pluginVersion: string },
  memoryMode: "normal" | "private",
  runtimeInstance: { id: string; startedAt: string } | undefined,
  igrepObservations: IgrepObservations,
  prompt: TerminalPromptAttribution,
) {
  return {
    authority: "dsh_terminal_candidate",
    attemptId: candidate.attemptId,
    provider: candidate.provider,
    model: candidate.model,
    finishReason: candidate.finishReason,
    completedAt: candidate.completedAt,
    execution: candidate.execution,
    tools: candidate.tools,
    ...(candidate.acknowledgement ? { acknowledgement: candidate.acknowledgement } : {}),
    attribution: candidate.attribution ?? null,
    profileDigest,
    prompt: {
      ...prompt,
      systemPromptDigest: candidate.modelRequests?.at(-1)?.systemPromptDigest ?? prompt.systemPromptDigest,
    },
    preparedSystemPromptDigest: prompt.systemPromptDigest,
    ...(candidate.modelRequests ? { modelRequests: candidate.modelRequests } : {}),
    memoryMode,
    runtime: "embedded_dsh",
    runtimeInstance: runtimeInstance ?? null,
    igrepObservations,
    igrepVersion: versions.igrepVersion,
    pluginVersion: versions.pluginVersion,
    contentDigest: sha256(candidate.content),
  };
}

export function agentRunFailureEvidence(input: {
  cancelled: boolean;
  prompt: TerminalPromptAttribution;
  runtimeCancellation?: Extract<CompanionEvent, { type: "cancelled" }>["reason"];
  runtimeFailure?: Extract<CompanionEvent, { type: "failed" }>["error"];
  reason: string;
}) {
  const failureCode = input.cancelled
    ? input.runtimeCancellation === "timeout" ? "agent_run_deadline_timeout" : "reply_cancelled"
    : input.runtimeFailure?.code ?? "agent_run_failed";
  return {
    authority: "chat_agent_run",
    prompt: input.prompt,
    failureCode,
    ...(input.runtimeCancellation ? { cancellationReason: input.runtimeCancellation } : {}),
    failureDigest: sha256(input.reason),
  };
}

export function classifyAgentRunCancellation(
  signalAborted: boolean,
  runtimeReason?: Extract<CompanionEvent, { type: "cancelled" }>["reason"],
): {
  cancelled: boolean;
  reason?: Extract<CompanionEvent, { type: "cancelled" }>["reason"];
  failureCode?: "agent_run_deadline_timeout" | "reply_cancelled";
} {
  const reason = runtimeReason ?? (signalAborted ? "transport" : undefined);
  if (!reason) return { cancelled: false };
  return {
    cancelled: true,
    reason,
    failureCode: reason === "timeout" ? "agent_run_deadline_timeout" : "reply_cancelled",
  };
}

function terminalFailureCode(terminal: ChatTerminalCommit): string {
  if (terminal.status === "cancelled") return "reply_cancelled";
  const failureCode = terminal.terminalEvidence.failureCode;
  return typeof failureCode === "string" && failureCode ? failureCode : "agent_run_failed";
}

type IgrepMetric = {
  calls: number;
  hits: number;
  failures: number;
  evidenceMatches: number;
};

type IgrepObservations = Record<"wake" | "search" | "memory", IgrepMetric>;

function emptyIgrepObservations(): IgrepObservations {
  const metric = (): IgrepMetric => ({
    calls: 0,
    hits: 0,
    failures: 0,
    evidenceMatches: 0,
  });
  return { wake: metric(), search: metric(), memory: metric() };
}

function rejectedCommit(attemptId: string, message: string): CompanionCommitAck {
  return {
    attemptId,
    accepted: false,
    status: "rejected",
    error: { code: "main_commit_rejected", message },
  };
}

async function postMain(path: string, body: unknown): Promise<Response> {
  return fetch(`${env.MAIN_INTERNAL_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-token": env.INTERNAL_TOKEN,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
}

function runKey(turnId: string, attempt: number): string {
  return `${turnId}:${attempt}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
