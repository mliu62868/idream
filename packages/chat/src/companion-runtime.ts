import {
  COMPANION_RUNTIME_PROTOCOL_VERSION,
  companionMemoryCutoverSidecarProofSchema,
  companionRuntimeResponseSchema,
  companionWorkspaceRebuildBudget,
  companionWorkspaceRebuildSchema,
  decodeCompanionNdjsonFrame,
  encodeCompanionWorkspaceRebuildFrame,
  encodeCompanionNdjsonFrame,
  type CompanionCommitAck,
  type CompanionEvent,
  type CompanionInvocation,
  type CompanionMemoryCutoverSidecarProof,
  type CompanionTerminalCandidate,
  type CompanionToolCall,
  type CompanionToolResult,
  type CompanionWorkspaceRebuild,
} from "@idream/shared/chat/companion-runtime";
import { z } from "zod";

const companionWorkspaceRebuildResponseSchema = z.object({
  ok: z.literal(true),
  rebuilt: z.object({
    sessions: z.number().int().nonnegative(),
    messages: z.number().int().nonnegative(),
  }).strict(),
}).strict();

const companionMemoryCutoverProofResponseSchema = z.object({
  ok: z.literal(true),
  proof: companionMemoryCutoverSidecarProofSchema.nullable(),
}).strict();
export interface CompanionRuntimePort {
  emit(event: CompanionEvent): Promise<void> | void;
  executeTool(call: CompanionToolCall): Promise<CompanionToolResult>;
  commit(candidate: CompanionTerminalCandidate): Promise<CompanionCommitAck>;
}

export interface CompanionRuntime {
  run(
    invocation: CompanionInvocation,
    port: CompanionRuntimePort,
    signal?: AbortSignal,
  ): Promise<void>;
  cancel(
    invocationId: string,
    reason: "user" | "timeout" | "shutdown" | "transport",
  ): Promise<void>;
}

const activeDshInvocations = new Map<
  string,
  { runtime: DshCompanionRuntime; invocationId: string }
>();
const COMPANION_CONTROL_TIMEOUT_MS = 10_000;

export async function cancelActiveCompanionInvocations(
  reason: "user" | "timeout" | "shutdown",
): Promise<void> {
  await Promise.allSettled(
    [...activeDshInvocations.values()].map(({ runtime, invocationId }) =>
      runtime.cancel(invocationId, reason),
    ),
  );
}

export type CompanionWorkspacePurgeTarget =
  | { scope: "user"; userId: string }
  | { scope: "relationship"; userId: string; characterId: string };

export async function purgeCompanionWorkspace(input: {
  baseUrl: string;
  token: string;
  target: CompanionWorkspacePurgeTarget;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<{ purged: number }> {
  const response = await (input.fetchImpl ?? fetch)(
    `${input.baseUrl.replace(/\/$/, "")}/v1/workspaces/purge`,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${input.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(input.target),
      signal: AbortSignal.timeout(input.timeoutMs ?? COMPANION_CONTROL_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    throw new Error(`companion workspace purge failed with HTTP ${response.status}`);
  }
  const value = await response.json();
  if (
    !value ||
    typeof value !== "object" ||
    (value as Record<string, unknown>).ok !== true ||
    !Number.isSafeInteger((value as Record<string, unknown>).purged) ||
    Number((value as Record<string, unknown>).purged) < 0
  ) {
    throw new Error("companion workspace purge returned an invalid response");
  }
  return { purged: Number((value as Record<string, unknown>).purged) };
}

export async function rebuildCompanionWorkspace(input: {
  baseUrl: string;
  token: string;
  request: CompanionWorkspaceRebuild;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<{ sessions: number; messages: number }> {
  const request = companionWorkspaceRebuildSchema.parse(input.request);
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${input.token}`,
      "content-type": "application/x-ndjson",
    },
    body: companionWorkspaceRebuildBody(request),
    duplex: "half",
    signal: AbortSignal.timeout(
      input.timeoutMs ?? companionWorkspaceRebuildBudget(request).totalTimeoutMs,
    ),
  };
  const response = await (input.fetchImpl ?? fetch)(
    `${input.baseUrl.replace(/\/$/, "")}/v1/workspaces/rebuild`,
    init,
  );
  if (!response.ok) {
    throw new Error(`companion workspace rebuild failed with HTTP ${response.status}`);
  }
  return companionWorkspaceRebuildResponseSchema.parse(await response.json()).rebuilt;
}

function companionWorkspaceRebuildBody(
  request: CompanionWorkspaceRebuild,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = -1;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index === -1) {
        index = 0;
        controller.enqueue(encoder.encode(encodeCompanionWorkspaceRebuildFrame({
          protocolVersion: COMPANION_RUNTIME_PROTOCOL_VERSION,
          type: "start",
          scope: "relationship",
          userId: request.userId,
          characterId: request.characterId,
          messageCount: request.messages.length,
        })));
        return;
      }
      const message = request.messages[index];
      if (message) {
        index += 1;
        controller.enqueue(encoder.encode(encodeCompanionWorkspaceRebuildFrame({
          protocolVersion: COMPANION_RUNTIME_PROTOCOL_VERSION,
          type: "message",
          message,
        })));
        return;
      }
      if (index === request.messages.length) {
        index += 1;
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

export async function readCompanionMemoryCutoverProof(input: {
  baseUrl: string;
  token: string;
  userId: string;
  characterId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<CompanionMemoryCutoverSidecarProof | null> {
  const response = await (input.fetchImpl ?? fetch)(
    `${input.baseUrl.replace(/\/$/, "")}/v1/workspaces/memory-cutover-proof`,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${input.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        scope: "relationship",
        userId: input.userId,
        characterId: input.characterId,
      }),
      signal: AbortSignal.timeout(input.timeoutMs ?? COMPANION_CONTROL_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    throw new Error(`companion memory cutover proof failed with HTTP ${response.status}`);
  }
  return companionMemoryCutoverProofResponseSchema.parse(await response.json()).proof;
}
export class DshCompanionRuntime implements CompanionRuntime {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(input: {
    baseUrl: string;
    token: string;
    fetchImpl?: typeof fetch;
  }) {
    this.baseUrl = input.baseUrl.replace(/\/$/, "");
    this.token = input.token;
    this.fetchImpl = input.fetchImpl ?? fetch;
  }

  async run(
    invocation: CompanionInvocation,
    port: CompanionRuntimePort,
    signal?: AbortSignal,
  ): Promise<void> {
    if (activeDshInvocations.has(invocation.invocationId)) {
      throw new Error("companion invocation is already active");
    }
    activeDshInvocations.set(invocation.invocationId, {
      runtime: this,
      invocationId: invocation.invocationId,
    });
    try {
      const request = encodeCompanionNdjsonFrame({
      protocolVersion: COMPANION_RUNTIME_PROTOCOL_VERSION,
      type: "run",
      invocation,
    });
      const response = await this.fetchImpl(`${this.baseUrl}/v1/invocations`, {
      method: "POST",
      headers: this.headers("application/x-ndjson"),
      body: request,
      signal,
    });
      if (!response.ok || !response.body) {
        throw new Error(`companion sidecar run failed with HTTP ${response.status}`);
      }

      let lastSequence = 0;
      for await (const line of responseLines(response.body)) {
        const decoded = decodeCompanionNdjsonFrame(`${line}\n`);
        const frame = companionRuntimeResponseSchema.parse(decoded);
        if (frame.invocationId !== invocation.invocationId) {
          throw new Error("companion response invocation identity mismatch");
        }
        if (frame.type === "event") {
          if (frame.event.attemptId !== invocation.attemptId) {
            throw new Error("companion event attempt identity mismatch");
          }
          if (frame.event.sequence <= lastSequence) {
            throw new Error("companion event sequence must be strictly increasing");
          }
          lastSequence = frame.event.sequence;
          await port.emit(frame.event);
          continue;
        }
        if (frame.type === "tool_call") {
          if (frame.call.attemptId !== invocation.attemptId) {
            throw new Error("companion tool call attempt identity mismatch");
          }
          const result = await port.executeTool(frame.call);
          await this.control(invocation.invocationId, "tool-result", {
            protocolVersion: COMPANION_RUNTIME_PROTOCOL_VERSION,
            type: "tool_result",
            invocationId: invocation.invocationId,
            result,
          });
          continue;
        }
        if (frame.candidate.attemptId !== invocation.attemptId) {
          throw new Error("companion terminal candidate attempt identity mismatch");
        }
        const ack = await port.commit(frame.candidate);
        await this.control(invocation.invocationId, "commit", {
          protocolVersion: COMPANION_RUNTIME_PROTOCOL_VERSION,
          type: "commit_ack",
          invocationId: invocation.invocationId,
          ack,
        });
      }
    } finally {
      const active = activeDshInvocations.get(invocation.invocationId);
      if (active?.runtime === this) {
        activeDshInvocations.delete(invocation.invocationId);
      }
    }
  }

  async cancel(
    invocationId: string,
    reason: "user" | "timeout" | "shutdown" | "transport",
  ): Promise<void> {
    await this.control(invocationId, "cancel", {
      protocolVersion: COMPANION_RUNTIME_PROTOCOL_VERSION,
      type: "cancel",
      invocationId,
      reason,
    });
  }

  private async control(
    invocationId: string,
    action: "tool-result" | "commit" | "cancel",
    frame: Parameters<typeof encodeCompanionNdjsonFrame>[0],
  ): Promise<void> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/v1/invocations/${encodeURIComponent(invocationId)}/${action}`,
      {
        method: "POST",
        headers: this.headers("application/x-ndjson"),
        body: encodeCompanionNdjsonFrame(frame),
        signal: AbortSignal.timeout(COMPANION_CONTROL_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      throw new Error(
        `companion sidecar ${action} failed with HTTP ${response.status}`,
      );
    }
  }

  private headers(contentType?: string): Record<string, string> {
    return {
      accept: "application/x-ndjson, application/json",
      authorization: `Bearer ${this.token}`,
      ...(contentType ? { "content-type": contentType } : {}),
    };
  }
}

async function* responseLines(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let completed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/, "");
        pending = pending.slice(newline + 1);
        if (line) yield line;
        newline = pending.indexOf("\n");
      }
      if (done) break;
    }
    if (pending.trim()) {
      throw new Error("companion sidecar returned a partial NDJSON frame");
    }
    completed = true;
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
