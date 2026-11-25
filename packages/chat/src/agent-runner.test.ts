import { describe, expect, it } from "vitest";
import type { CompanionEvent } from "./agent-runtime/contracts";
import {
  agentRunFailureEvidence,
  agentRunTraceEvent,
  classifyAgentRunCancellation,
  createDeltaCoalescer,
} from "./agent-runner";

describe("AgentRun failure evidence", () => {
  it("preserves the embedded runtime failure classification", () => {
    expect(agentRunFailureEvidence({
      cancelled: false,
      prompt: {
        productPromptVersion: "companion-product-1",
        preparedTurnVersion: null,
        systemPromptDigest: null,
        soulFingerprint: null,
      },
      runtimeFailure: {
        code: "provider_first_token_timeout",
        message: "companion provider response failed",
        retryable: true,
      },
      reason: "DSH ended without a terminal commit",
    })).toMatchObject({
      authority: "chat_agent_run",
      prompt: { productPromptVersion: "companion-product-1" },
      failureCode: "provider_first_token_timeout",
    });
  });

  it("keeps cancellation authoritative over a runtime failure", () => {
    expect(agentRunFailureEvidence({
      cancelled: true,
      prompt: {
        productPromptVersion: "companion-product-1",
        preparedTurnVersion: null,
        systemPromptDigest: null,
        soulFingerprint: null,
      },
      runtimeFailure: {
        code: "provider_idle_timeout",
        message: "companion provider response failed",
        retryable: true,
      },
      reason: "cancelled by Main",
    })).toMatchObject({ failureCode: "reply_cancelled" });
  });

  it("preserves an internal AgentRun deadline cancellation", () => {
    const cancellation = classifyAgentRunCancellation(false, "timeout");
    expect(cancellation).toEqual({
      cancelled: true,
      reason: "timeout",
      failureCode: "agent_run_deadline_timeout",
    });
    expect(agentRunFailureEvidence({
      cancelled: cancellation.cancelled,
      prompt: {
        productPromptVersion: "companion-product-1",
        preparedTurnVersion: null,
        systemPromptDigest: null,
        soulFingerprint: null,
      },
      runtimeCancellation: cancellation.reason,
      reason: "DSH ended without a terminal commit",
    })).toMatchObject({
      failureCode: "agent_run_deadline_timeout",
      cancellationReason: "timeout",
    });
  });
});

describe("AgentRun local trace", () => {
  it("does not persist streamed companion content", () => {
    const event: CompanionEvent = {
      invocationId: "invocation-1",
      attemptId: "attempt-1",
      sequence: 1,
      occurredAt: "2026-08-28T12:00:00.000Z",
      type: "text_delta",
      delta: "private generated content",
    };

    expect(agentRunTraceEvent(event)).toBeNull();
  });

  it("persists physical usage even when no terminal candidate follows", () => {
    const event: CompanionEvent = { invocationId: "invocation-1", attemptId: "attempt-1", sequence: 2,
      occurredAt: "2026-08-28T12:00:00.000Z", type: "usage",
      usage: { promptTokens: 1942, completionTokens: 256, reasoningTokens: null } };
    expect(agentRunTraceEvent(event)).toEqual({ kind: "pi.usage", payload: { usage: event.usage } });
  });

  it("keeps content-free failure classification", () => {
    const event: CompanionEvent = {
      invocationId: "invocation-1",
      attemptId: "attempt-1",
      sequence: 2,
      occurredAt: "2026-08-28T12:00:00.000Z",
      type: "failed",
      error: {
        code: "provider_idle_timeout",
        message: "companion provider response failed",
        retryable: true,
      },
    };

    expect(agentRunTraceEvent(event)).toEqual({
      kind: "pi.failed",
      payload: { error: event.error },
    });
  });
});

describe("SSE delta coalescer", () => {
  it("coalesces rapid small token chunks and flushes immediately at char cap or explicit boundary", async () => {
    const emitted: string[] = [];
    const coalescer = createDeltaCoalescer(async (delta) => {
      emitted.push(delta);
    }, { flushMs: 50, maxChars: 10 });

    await coalescer.push("Hel");
    await coalescer.push("lo ");
    expect(emitted).toEqual([]);
    await coalescer.push("world!");
    expect(emitted).toEqual(["Hello world!"]);

    await coalescer.push("Tail");
    expect(emitted).toEqual(["Hello world!"]);
    await coalescer.flush();
    expect(emitted).toEqual(["Hello world!", "Tail"]);

    await coalescer.push("Cut");
    coalescer.discard();
    await new Promise((resolve) => setTimeout(resolve, 70));
    await coalescer.flush();
    expect(emitted).toEqual(["Hello world!", "Tail"]);
  });
});
