import {
  COMPANION_RUNTIME_PROTOCOL_VERSION,
  COMPANION_NDJSON_FRAME_MAX_BYTES,
  COMPANION_WORKSPACE_REBUILD_CONTENT_CHUNK_CHARS,
  companionMemoryCutoverSidecarProofSchema,
  companionRuntimeResponseSchema,
  companionWorkspaceRebuildBudget,
  companionWorkspaceRebuildMetrics,
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
  type CompanionWorkspaceRebuildPromotion,
} from "@idream/shared/chat/companion-runtime";
import { z } from "zod";

const companionWorkspaceRebuildResponseSchema = z.object({
  ok: z.literal(true),
  rebuilt: z.object({
    sessions: z.number().int().nonnegative(),
    messages: z.number().int().nonnegative(),
  }).strict(),
}).strict();

const companionWorkspaceRebuildPrepareResponseSchema = z.object({
  ok: z.literal(true),
  rebuilt: z.object({
    rebuildId: z.string().uuid(),
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
const COMPANION_RESPONSE_TOTAL_MAX_BYTES = 64 * 1_024 * 1_024;

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
  | {
      scope: "relationship";
      userId: string;
      characterId: string;
      /** Reset: the sidecar retires the workspace under this label instead of destroying it. */
      quarantine?: string;
    };

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

export async function prepareCompanionWorkspaceRebuild(input: {
  baseUrl: string;
  token: string;
  request: CompanionWorkspaceRebuild & { fence: NonNullable<CompanionWorkspaceRebuild["fence"]> };
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<{ rebuildId: string; sessions: number; messages: number }> {
  const response = await sendCompanionWorkspaceRebuild(
    input,
    "/v1/workspaces/rebuild/prepare",
  );
  return companionWorkspaceRebuildPrepareResponseSchema.parse(await response.json()).rebuilt;
}

async function sendCompanionWorkspaceRebuild(
  input: {
    baseUrl: string;
    token: string;
    request: CompanionWorkspaceRebuild;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  },
  path: string,
): Promise<Response> {
  // `buildCompanionWorkspaceRebuild` already owns canonical validation. Avoid
  // cloning a potentially multi-gigabyte array again at the transport seam;
  // the sidecar validates every streamed frame before staging it.
  const request = input.request;
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
      input.timeoutMs ?? companionWorkspaceRebuildBudget(
        companionWorkspaceRebuildMetrics(request),
      ).totalTimeoutMs,
    ),
  };
  const response = await (input.fetchImpl ?? fetch)(
    `${input.baseUrl.replace(/\/$/, "")}${path}`,
    init,
  );
  if (!response.ok) {
    // SPEC: rebuild errors are the sidecar's own structural messages (fence,
    // ingest/maintain verification, staging); they never embed transcript or
    // provider bytes, so surfacing them is the only way to diagnose a 400.
    throw new Error(
      `companion workspace rebuild failed with HTTP ${response.status}: ${await sidecarErrorSummary(response)}`,
    );
  }
  return response;
}

async function sidecarErrorSummary(response: Response): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: { code?: unknown; message?: unknown } } | null;
  const code = typeof body?.error?.code === "string" ? body.error.code : "unknown";
  const message = typeof body?.error?.message === "string" ? body.error.message.slice(0, 300) : "";
  return message ? `${code}: ${message}` : code;
}

export async function promoteCompanionWorkspaceRebuild(input: {
  baseUrl: string;
  token: string;
  request: CompanionWorkspaceRebuildPromotion;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<{ sessions: number; messages: number }> {
  const response = await (input.fetchImpl ?? fetch)(
    `${input.baseUrl.replace(/\/$/, "")}/v1/workspaces/rebuild/promote`,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${input.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(input.request),
      // Promotion runs while Chat owns the final short authority transaction.
      // It is intentionally limited to the sidecar's local pointer cutover;
      // ingest/maintenance belongs to prepare and must never reach this seam.
      signal: AbortSignal.timeout(input.timeoutMs ?? COMPANION_CONTROL_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    throw new Error(`companion workspace rebuild promotion failed with HTTP ${response.status}`);
  }
  return companionWorkspaceRebuildResponseSchema.parse(await response.json()).rebuilt;
}

export async function discardCompanionWorkspaceRebuild(input: {
  baseUrl: string;
  token: string;
  request: CompanionWorkspaceRebuildPromotion;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<void> {
  const response = await (input.fetchImpl ?? fetch)(
    `${input.baseUrl.replace(/\/$/, "")}/v1/workspaces/rebuild/discard`,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${input.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(input.request),
      signal: AbortSignal.timeout(input.timeoutMs ?? 60_000),
    },
  );
  if (!response.ok) {
    throw new Error(`companion workspace rebuild discard failed with HTTP ${response.status}`);
  }
  const value = await response.json();
  if (!value || typeof value !== "object" || (value as Record<string, unknown>).ok !== true) {
    throw new Error("companion workspace rebuild discard returned an invalid response");
  }
}

function companionWorkspaceRebuildBody(
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
  const encoder = new TextEncoder();
  let pending = "";
  let totalBytes = 0;
  let completed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > COMPANION_RESPONSE_TOTAL_MAX_BYTES) {
          throw new Error("companion_response_total_limit");
        }
      }
      pending += decoder.decode(value, { stream: !done });
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/, "");
        pending = pending.slice(newline + 1);
        if (encoder.encode(line).byteLength > COMPANION_NDJSON_FRAME_MAX_BYTES) {
          throw new Error("companion_response_frame_limit");
        }
        if (line) yield line;
        newline = pending.indexOf("\n");
      }
      if (encoder.encode(pending).byteLength > COMPANION_NDJSON_FRAME_MAX_BYTES) {
        throw new Error("companion_response_frame_limit");
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
