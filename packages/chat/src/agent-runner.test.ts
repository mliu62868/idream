import { describe, expect, it } from "vitest";
import type { CompanionEvent } from "./agent-runtime/contracts";
import {
  agentRunFailureEvidence,
  agentRunTraceEvent,
  classifyAgentRunCancellation,
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
      kind: "dsh.failed",
      payload: { error: event.error },
    });
  });
});
