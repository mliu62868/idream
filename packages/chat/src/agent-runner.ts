import { createHash } from "node:crypto";
import {
  REQUIRED_IMAGE_CAPTION_INSTRUCTION,
  requiredImageToolCallForUserRequest,
} from "@idream/shared/chat/image-action";
import type { ChatTerminalCommit, ChatToolEffect } from "@idream/shared/contracts";
import type {
  CompanionCommitAck,
  CompanionEvent,
  CompanionInvocation,
  CompanionTerminalCandidate,
  CompanionToolCall,
  CompanionToolResult,
} from "@idream/shared/chat/companion-runtime";
import {
  appendAgentRunEvent,
  fenceAgentRunAttempt,
  isAgentRunTombstoned,
  readAgentRunInput,
  readAgentRunProposal,
  readAgentRunTerminal,
  writeAgentRunProposal,
  writeAgentRunTerminal,
  type AgentRunProposal,
} from "./agent-run-store.js";
import { DshCompanionRuntime } from "./companion-runtime.js";
import { verifiedCompanionProfileDigest } from "./companion-sidecar-readiness.js";
import { selectCompanionRuntimeForAttempt } from "./companion-runtime-selection.js";
import { env } from "./env.js";
import { logger } from "./logger.js";
import {
  prepareCompanionTurn,
  preparedTurnRuntime,
  toPreparedTurnWire,
} from "./prepared-turn.js";
import { applySceneDelta, deriveSceneDelta } from "./scene.js";
import { appendStreamEvent, streamKey } from "./stream.js";

const activeRuns = new Map<string, AbortController>();

export function startAgentRun(turnId: string, attempt: number): boolean {
  const key = runKey(turnId, attempt);
  if (activeRuns.has(key)) return false;
  const controller = new AbortController();
  activeRuns.set(key, controller);
  void executeAgentRun(turnId, attempt, controller.signal)
    .catch((error) => logger.error({ err: error, turnId, attempt }, "AgentRun failed"))
    .finally(() => activeRuns.delete(key));
  return true;
}

export async function cancelAgentRun(turnId: string, attempt: number): Promise<boolean> {
  await fenceAgentRunAttempt(turnId, attempt);
  const key = runKey(turnId, attempt);
  const controller = activeRuns.get(key);
  if (!controller) return false;
  controller.abort(new Error("cancelled by Main"));
  return true;
}

async function executeAgentRun(turnId: string, attempt: number, signal: AbortSignal): Promise<void> {
  if (await isAgentRunTombstoned(turnId, attempt)) return;
  const input = await readAgentRunInput(turnId, attempt);
  if (!input) throw new Error("AgentRun input is missing");
  if (await readAgentRunTerminal(turnId, attempt)) return;
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
    await writeAcceptedTerminal(existingProposal, replay);
    return;
  }
  let committed = false;
  let committedProposal: AgentRunProposal | null = null;
  let committedAck: Extract<CompanionCommitAck, { accepted: true }> | null = null;
  let locallyTerminal = false;
  try {
    await appendStreamEvent(key, { type: "start", attempt: snapshot.attempt });
    await appendAgentRunEvent(turnId, attempt, "admitted", {
      attemptId,
      sessionId: snapshot.sessionId,
      userMessageId: snapshot.userMessageId,
      assistantMessageId: snapshot.assistantMessageId,
    });
    const prepared = await prepareCompanionTurn({ snapshot, authority: input.authority });
    const runtimeConfig = env.COMPANION_RUNTIME_CONFIG;
    const runtimePin = selectCompanionRuntimeForAttempt({
      config: runtimeConfig,
      memoryAuthority: snapshot.memoryEnabled ? "enabled" : "disabled",
    });
    const profileDigest = verifiedCompanionProfileDigest(
      runtimePin.sidecarUrl,
      runtimePin.private ? "private" : "normal",
    );
    let wire = toPreparedTurnWire(prepared);
    const requiredTool = requiredImageToolCallForUserRequest({
      userText: snapshot.userContent,
      characterName: prepared.characterName,
    });
    if (requiredTool) {
      const result = await executeMainTool({
        attemptId,
        callId: `required:${requiredTool.name}`,
        ...requiredTool,
      }, snapshot.turnId, snapshot.attempt);
      if (result.outcome !== "succeeded") {
        throw new Error(result.error.message);
      }
      wire = {
        ...wire,
        tools: [],
        messages: wire.messages.map((message, index) => index === 0
          ? { ...message, content: `${message.content}\n\n${REQUIRED_IMAGE_CAPTION_INSTRUCTION}` }
          : message),
      };
    }
    const invocation: CompanionInvocation = {
      invocationId: `inv:${attemptId}`,
      attemptId,
      sessionId: snapshot.sessionId,
      userId: snapshot.userId,
      characterId: snapshot.characterId,
      preparedTurn: wire,
      memoryMode: runtimePin.private ? "private" : "normal",
      expectedProfileDigest: profileDigest,
      deadlineAt: new Date(Date.now() + runtimePin.deadlineMs).toISOString(),
    };
    const runtime = new DshCompanionRuntime({
      baseUrl: runtimePin.sidecarUrl,
      token: runtimeConfig.sidecarToken,
    });
    let sequence = 0;
    await runtime.run(invocation, {
      emit: async (event) => {
        await appendAgentRunEvent(turnId, attempt, `dsh.${event.type}`, event);
        sequence = await projectStreamEvent(key, snapshot.attempt, sequence, event);
      },
      executeTool: (call) => executeMainTool(call, snapshot.turnId, snapshot.attempt),
      commit: async (candidate) => {
        const scene = applySceneDelta(
          preparedTurnRuntime(prepared).scene,
          deriveSceneDelta({ userText: snapshot.userContent, assistantText: candidate.content }),
        );
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
          terminalEvidence: terminalEvidence(candidate, profileDigest),
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
          committed = true;
          committedProposal = proposal;
          committedAck = ack;
        }
        else locallyTerminal = Boolean(await readAgentRunTerminal(turnId, attempt));
        return ack;
      },
    }, signal);
    if (!committed) throw new Error("DSH ended without a terminal commit");
    if (!committedProposal || !committedAck) {
      throw new Error("DSH committed without durable terminal evidence");
    }
    // INVARIANT: local terminal is downstream of the sidecar commit_ack. A
    // crash before this write leaves an incomplete run whose duplicate Main
    // ACK schedules a canonical memory rebuild.
    await writeAcceptedTerminal(committedProposal, committedAck);
  } catch (error) {
    if (committed || locallyTerminal) throw error;
    // Once a candidate is durable, recovery may only replay it. Replacing it
    // with a generic failure would destroy exact Main CAS identity.
    if (await readAgentRunProposal(turnId, attempt)) throw error;
    const cancelled = signal.aborted;
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
      terminalEvidence: {
        authority: "chat_agent_run",
        failureCode: cancelled ? "cancelled" : "agent_run_failed",
        failureDigest: sha256(reason),
      },
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
      reasonDigest: sha256(reason),
    });
    const ack = await settleTerminalProposal(proposal, key, false);
    if (ack.accepted) await writeAcceptedTerminal(proposal, ack);
    if (!ack.accepted) {
      if (await readAgentRunTerminal(turnId, attempt)) locallyTerminal = true;
      if (!locallyTerminal) throw error;
    }
    if (!cancelled) throw error;
  }
}

type MainTerminalAck = {
  accepted: true;
  duplicate: boolean;
  terminalMessageId: string;
  committedAt: string;
};

async function settleTerminalProposal(
  proposal: AgentRunProposal,
  stream: string,
  recovery: boolean,
): Promise<CompanionCommitAck> {
  const terminal = proposal.terminal;
  const response = await postMain("/api/internal/chat/turns/terminal", terminal);
  if (!response.ok) {
    const reason = `Main terminal commit HTTP ${response.status}`;
    if (response.status >= 500) throw new Error(reason);
    const rejected = rejectedCommit(proposal.attemptId, reason);
    await appendAgentRunEvent(terminal.turnId, terminal.attempt, "main.terminal_rejected", {
      status: response.status,
      recovery,
    });
    await appendStreamEvent(stream, {
      type: "error",
      attempt: terminal.attempt,
      code: "terminal_rejected",
      retryable: false,
    }).catch(() => undefined);
    await writeAgentRunTerminal(terminal.turnId, terminal.attempt, {
      schemaVersion: 1,
      attemptId: proposal.attemptId,
      outcome: terminal.status === "cancelled" ? "cancelled" : "failed",
      mainCommit: { accepted: false, status: response.status },
      evidence: terminal.terminalEvidence,
      completedAt: new Date().toISOString(),
    });
    return rejected;
  }
  const result = await response.json() as MainTerminalAck;
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
      code: terminal.status === "cancelled" ? "cancelled" : "agent_run_failed",
      retryable: terminal.status !== "cancelled",
    }).catch(() => undefined);
  }
  return ack;
}

async function writeAcceptedTerminal(
  proposal: AgentRunProposal,
  ack: Extract<CompanionCommitAck, { accepted: true }>,
): Promise<void> {
  const terminal = proposal.terminal;
  await writeAgentRunTerminal(terminal.turnId, terminal.attempt, {
    schemaVersion: 1,
    attemptId: proposal.attemptId,
    outcome: terminal.status === "sent"
      ? "committed"
      : terminal.status === "cancelled" ? "cancelled" : "failed",
    mainCommit: ack,
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
    version: 1,
    turnId,
    attempt,
    callId: call.callId,
    name: call.name,
    arguments: call.arguments,
  };
  await appendAgentRunEvent(turnId, attempt, "tool.requested", {
    attemptId: call.attemptId,
    callId: call.callId,
    name: call.name,
    argumentsDigest: sha256(stableJson(call.arguments)),
  });
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
  const error = record(value.error);
  const topLevelCode = typeof value.error === "string" ? value.error : undefined;
  const topLevelMessage = typeof value.message === "string" ? value.message : undefined;
  return {
    attemptId: call.attemptId,
    callId: call.callId,
    name: call.name,
    outcome: "failed",
    error: {
      code: typeof error?.code === "string" ? error.code : topLevelCode ?? `main_http_${response.status}`,
      message: typeof error?.message === "string"
        ? error.message
        : topLevelMessage ?? "Main rejected the tool effect",
      retryable: error?.retryable === true || response.status >= 500,
    },
  };
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

function terminalEvidence(candidate: CompanionTerminalCandidate, profileDigest: string) {
  return {
    authority: "dsh_terminal_candidate",
    attemptId: candidate.attemptId,
    provider: candidate.provider,
    model: candidate.model,
    finishReason: candidate.finishReason,
    completedAt: candidate.completedAt,
    execution: candidate.execution,
    attribution: candidate.attribution ?? null,
    profileDigest,
    contentDigest: sha256(candidate.content),
  };
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

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = record(value);
  if (object) {
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
