import { describe, expect, it, vi } from "vitest";
import {
  COMPANION_RUNTIME_PROTOCOL_VERSION,
  encodeCompanionNdjsonFrame,
  type CompanionInvocation,
} from "@idream/shared/chat/companion-runtime";
import {
  cancelActiveCompanionInvocations,
  DshCompanionRuntime,
  purgeCompanionWorkspace,
} from "./companion-runtime.js";

const now = "2026-08-19T12:00:00.000Z";

function invocation(): CompanionInvocation {
  return {
    invocationId: "invocation-1",
    attemptId: "assistant-1:1",
    sessionId: "session-1",
    userId: "user-1",
    characterId: "character-1",
    memoryMode: "normal",
    deadlineAt: "2026-08-19T12:05:00.000Z",
    preparedTurn: {
      version: 1,
      model: "model-1",
      characterName: "Mira",
      messages: [{
        id: "user-1",
        sourceKind: "current_user",
        role: "user",
        content: "Show me the view tonight.",
      }],
      tools: [],
      profile: {
        tier: "free",
        adapter: "openai-compatible-v1",
        provider: "local",
        baseUrl: "http://127.0.0.1:8061/v1",
        model: "model-1",
        supportsTools: true,
        maxOutputTokens: 1_000,
        timeout: { firstTokenMs: 1_000, idleMs: 1_000, completionMs: 2_000 },
        sampling: {
          temperature: 0.9,
          topP: 0.95,
          repetitionPenalty: 1.05,
          structuredTemperature: 0.2,
        },
      },
      budget: { maxInputTokens: 2_000, usedInputTokens: 100, dropped: [] },
      trace: {
        characterContentVersionId: "ccv-1",
        characterReleaseId: "release-1",
        soulFingerprint: "fingerprint",
        compilerVersion: "soul-v1",
        sceneVersion: 1,
        relationshipVersion: 2,
        fileContextRevision: "3",
      },
    },
  };
}

describe("DshCompanionRuntime", () => {
  it("bridges strict event, tool and commit frames over authenticated NDJSON", async () => {
    const input = invocation();
    const toolCall = {
      attemptId: input.attemptId,
      callId: "call-1",
      name: "generate_image_async" as const,
      arguments: { prompt: "Mira beside a blue observatory window" },
    };
    const candidate = {
      attemptId: input.attemptId,
      content: "Look at that blue horizon.",
      finishReason: "stop" as const,
      provider: "local",
      model: "model-1",
      usage: { promptTokens: 12, completionTokens: 7, reasoningTokens: 0 },
      execution: { steps: 2, toolCalls: 1 },
      completedAt: now,
    };
    const stream = [
      {
        protocolVersion: COMPANION_RUNTIME_PROTOCOL_VERSION,
        type: "event" as const,
        invocationId: input.invocationId,
        event: {
          type: "text_delta" as const,
          invocationId: input.invocationId,
          attemptId: input.attemptId,
          sequence: 1,
          occurredAt: now,
          delta: "Look at that blue horizon.",
        },
      },
      {
        protocolVersion: COMPANION_RUNTIME_PROTOCOL_VERSION,
        type: "tool_call" as const,
        invocationId: input.invocationId,
        call: toolCall,
      },
      {
        protocolVersion: COMPANION_RUNTIME_PROTOCOL_VERSION,
        type: "commit" as const,
        invocationId: input.invocationId,
        candidate,
      },
    ].map(encodeCompanionNdjsonFrame).join("");
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return calls.length === 1
        ? new Response(stream, { status: 200, headers: { "content-type": "application/x-ndjson" } })
        : Response.json({ ok: true });
    });
    const events: string[] = [];
    const runtime = new DshCompanionRuntime({
      baseUrl: "http://127.0.0.1:3101",
      token: "sidecar-secret",
      fetchImpl: fetchImpl as typeof fetch,
    });

    await runtime.run(input, {
      emit(event) {
        events.push(event.type);
      },
      async executeTool(call) {
        expect(call).toEqual(toolCall);
        return {
          attemptId: call.attemptId,
          callId: call.callId,
          name: call.name,
          outcome: "succeeded",
          output: { status: "queued" },
        };
      },
      async commit(received) {
        expect(received).toEqual(candidate);
        return {
          attemptId: received.attemptId,
          accepted: true,
          status: "committed",
          terminalMessageId: "assistant-1",
          committedAt: now,
        };
      },
    });

    expect(events).toEqual(["text_delta"]);
    expect(calls.map(({ url }) => url)).toEqual([
      "http://127.0.0.1:3101/v1/invocations",
      "http://127.0.0.1:3101/v1/invocations/invocation-1/tool-result",
      "http://127.0.0.1:3101/v1/invocations/invocation-1/commit",
    ]);
    expect(calls.every(({ init }) => new Headers(init.headers).get("authorization") === "Bearer sidecar-secret"))
      .toBe(true);
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      type: "run",
      invocation: { invocationId: input.invocationId },
    });
  });

  it("rejects non-monotonic event sequences before they reach product callbacks", async () => {
    const input = invocation();
    const event = (sequence: number) => encodeCompanionNdjsonFrame({
      protocolVersion: COMPANION_RUNTIME_PROTOCOL_VERSION,
      type: "event",
      invocationId: input.invocationId,
      event: {
        type: "heartbeat",
        invocationId: input.invocationId,
        attemptId: input.attemptId,
        sequence,
        occurredAt: now,
      },
    });
    const runtime = new DshCompanionRuntime({
      baseUrl: "http://127.0.0.1:3101",
      token: "secret",
      fetchImpl: async () => new Response(event(2) + event(1), { status: 200 }),
    });

    await expect(runtime.run(input, {
      emit() {},
      async executeTool() { throw new Error("unused"); },
      async commit() { throw new Error("unused"); },
    })).rejects.toThrow(/event sequence/);
  });

  it("maps Chat shutdown to every active sidecar invocation", async () => {
    let close: (() => void) | undefined;
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url));
      if (calls.length > 1) return Response.json({ ok: true });
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          close = () => controller.close();
        },
      }), { status: 200 });
    });
    const runtime = new DshCompanionRuntime({
      baseUrl: "http://127.0.0.1:3101",
      token: "secret",
      fetchImpl: fetchImpl as typeof fetch,
    });
    const running = runtime.run(invocation(), {
      emit() {},
      async executeTool() { throw new Error("unused"); },
      async commit() { throw new Error("unused"); },
    });
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    await cancelActiveCompanionInvocations("shutdown");
    close?.();
    await running;

    expect(calls[1]).toBe(
      "http://127.0.0.1:3101/v1/invocations/invocation-1/cancel",
    );
  });

  it("rejects a duplicate live invocation without losing shutdown ownership", async () => {
    let close: (() => void) | undefined;
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url));
      if (String(url).endsWith("/cancel")) return Response.json({ ok: true });
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          close = () => controller.close();
        },
      }), { status: 200 });
    });
    const runtime = new DshCompanionRuntime({
      baseUrl: "http://127.0.0.1:3101",
      token: "secret",
      fetchImpl: fetchImpl as typeof fetch,
    });
    const port = {
      emit() {},
      async executeTool() { throw new Error("unused"); },
      async commit() { throw new Error("unused"); },
    };
    const running = runtime.run(invocation(), port);
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    await expect(runtime.run(invocation(), port)).rejects.toThrow("already active");
    await cancelActiveCompanionInvocations("shutdown");
    expect(calls.at(-1)).toContain("/cancel");
    close?.();
    await running;
  });

  it("purges a relationship workspace through the authenticated strict endpoint", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ ok: true, purged: 2 }));
    await expect(purgeCompanionWorkspace({
      baseUrl: "http://127.0.0.1:3101",
      token: "secret",
      target: { scope: "relationship", userId: "user-1", characterId: "char-1" },
      fetchImpl: fetchImpl as typeof fetch,
    })).resolves.toEqual({ purged: 2 });
    const calls = fetchImpl.mock.calls as unknown[][];
    const init = calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      scope: "relationship",
      userId: "user-1",
      characterId: "char-1",
    });
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer secret");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
