import { describe, expect, it } from "vitest";
import {
  durableAckSchema,
  durableEnvelopeHash,
  durableEventEnvelopeSchema,
  generationTerminalRecordChecksum,
  generationTerminalRecordSchema,
  generationTransportExecutionEventSchema,
} from "./durable";
import { aiUsageRecordedV2Schema } from "./metric-events";

describe("durable cross-service contracts", () => {
  it("uses one canonical envelope hash and makes quarantine impossible to acknowledge", () => {
    const envelope = durableEventEnvelopeSchema.parse({
      sourceService: "main",
      sourceEventId: "event-1",
      eventType: "user.deleted",
      schemaVersion: 1,
      occurredAt: "2026-07-31T12:00:00.000Z",
      aggregateType: "user",
      aggregateId: "user-1",
      payload: { reason: "requested", userId: "user-1" },
    });
    expect(durableEnvelopeHash(envelope)).toBe(durableEnvelopeHash({
      ...envelope,
      payload: { userId: "user-1", reason: "requested" },
    }));
    expect(durableEnvelopeHash({ ...envelope, payload: { userId: "user-2" } }))
      .not.toBe(durableEnvelopeHash(envelope));
    expect(durableAckSchema.parse({
      acknowledged: true,
      status: "duplicate",
      receiptId: "main:event-1",
    })).toMatchObject({ acknowledged: true, status: "duplicate" });
    expect(durableAckSchema.safeParse({
      acknowledged: true,
      status: "quarantined",
      receiptId: "main:event-1",
    }).success).toBe(false);
  });

  it("produces a stable checksum independent of object key order", () => {
    const terminalRecord = generationTerminalRecordSchema.parse({
      version: 1,
      outcome: "succeeded",
      attemptId: "attempt-1",
      attemptNo: 1,
      providerIdempotencyKey: "generation:attempt-1:provider",
      requestId: "request-1",
      generationJobId: "job-1",
      mode: "image",
      provider: "provider-1",
      providerInvoked: true,
      providerRequestId: null,
      completedAt: "2026-07-11T12:00:00.000Z",
      assets: [{ ordinal: 0, key: "a.webp", contentType: "image/webp", providerKey: null }],
      usage: { model: "m", gpuSeconds: 1 },
    });
    expect(generationTerminalRecordChecksum(terminalRecord)).toBe(
      generationTerminalRecordChecksum({ ...terminalRecord, usage: { gpuSeconds: 1, model: "m" } }),
    );
  });

  it("carries explicit provider accounting and rejects guessed pricing", () => {
    const accounting = {
      usage: { images: 2 },
      latencyMs: 640,
      costMicros: 125_000,
      pricingVersion: "fal-flux-v3",
    };
    const terminalRecord = {
      version: 1 as const,
      attemptId: "attempt-1",
      attemptNo: 1,
      providerIdempotencyKey: "generation:attempt-1:provider",
      requestId: "request-1",
      generationJobId: "job-1",
      mode: "image" as const,
      provider: "fal",
      providerInvoked: true,
      model: "flux-pro",
      providerRequestId: "provider-request-1",
      completedAt: "2026-07-11T12:00:00.000Z",
      assets: [{ ordinal: 0, key: "a.webp", contentType: "image/webp", providerKey: null }],
      usage: { images: 2 },
      accounting,
    };
    expect(generationTerminalRecordSchema.parse({
      ...terminalRecord,
      outcome: "succeeded",
    })).toMatchObject({ accounting });

    const terminal = {
      version: 1 as const,
      attemptId: "attempt-1",
      attemptNo: 1,
      generationJobId: "job-1",
      transportAttemptNo: 1,
      provider: "fal",
      model: "flux-pro",
      providerRequestId: "provider-request-1",
      idempotencyKey: "generation:attempt-1:provider",
      status: "failed" as const,
      occurredAt: "2026-07-11T12:00:01.000Z",
      error: { code: "rate_limited", message: "capacity exhausted" },
      accounting,
    };
    expect(generationTransportExecutionEventSchema.parse(terminal)).toMatchObject({ accounting });
    expect(generationTransportExecutionEventSchema.safeParse({
      ...terminal,
      accounting: { ...accounting, pricingVersion: null },
    }).success).toBe(false);
    expect(generationTransportExecutionEventSchema.parse({
      ...terminal,
      accounting: { usage: {}, latencyMs: 640, costMicros: null, pricingVersion: null },
    })).toMatchObject({ accounting: { costMicros: null, pricingVersion: null } });
    expect(aiUsageRecordedV2Schema.safeParse({
      invocationId: "attempt-1:1",
      provider: "fal",
      model: "flux-pro",
      usage: { images: 2 },
      costMicros: 125_000,
      pricingVersion: null,
    }).success).toBe(false);
  });

  it("represents every generation terminal outcome as one durable record", () => {
    const common = {
      version: 1 as const,
      attemptId: "attempt-1",
      attemptNo: 1,
      transportAttemptNo: 1,
      providerIdempotencyKey: "generation:attempt-1:provider",
      requestId: "request-1",
      generationJobId: "job-1",
      mode: "image" as const,
      provider: "backend",
      providerInvoked: true,
      model: "image-model",
      providerRequestId: null,
      completedAt: "2026-07-11T12:00:00.000Z",
      usage: {},
    };

    expect(generationTerminalRecordSchema.parse({
      ...common,
      outcome: "succeeded",
      assets: [{ ordinal: 0, key: "a.webp", contentType: "image/webp", providerKey: null }],
    })).toMatchObject({ outcome: "succeeded", assets: [{ key: "a.webp" }] });
    expect(generationTerminalRecordSchema.parse({
      ...common,
      outcome: "failed",
      error: { code: "backend_error", message: "backend unavailable", retryability: "operator_retry" },
    })).toMatchObject({ outcome: "failed", error: { code: "backend_error" } });
    expect(generationTerminalRecordSchema.parse({
      ...common,
      outcome: "blocked",
      block: { policyCode: "PROHIBITED_OTHER", message: "blocked", layer: "provider" },
    })).toMatchObject({ outcome: "blocked", block: { layer: "provider" } });
    expect(generationTerminalRecordSchema.parse({
      ...common,
      outcome: "unknown",
      error: { code: "ambiguous_non_replayable", message: "timed out", retryability: "not_retryable" },
    })).toMatchObject({ outcome: "unknown", error: { retryability: "not_retryable" } });
    expect(generationTerminalRecordSchema.safeParse({
      ...common,
      providerInvoked: undefined,
      outcome: "failed",
      error: { code: "moderation_unavailable", message: "unavailable", retryability: "retryable" },
    }).success).toBe(false);
  });

  it("requires terminal asset MIME to match the generation mode", () => {
    const common = {
      version: 1 as const,
      outcome: "succeeded" as const,
      attemptId: "attempt-mime",
      attemptNo: 1,
      transportAttemptNo: 1,
      providerIdempotencyKey: "generation:attempt-mime:provider",
      requestId: "generation_dispatch_attempt-mime",
      generationJobId: "job-mime",
      provider: "backend",
      providerInvoked: true,
      model: "model",
      providerRequestId: null,
      completedAt: "2026-07-11T12:00:00.000Z",
      usage: {},
    };
    expect(generationTerminalRecordSchema.safeParse({
      ...common,
      mode: "image",
      assets: [{ ordinal: 0, key: "wrong.mp4", contentType: "video/mp4", providerKey: null }],
    }).success).toBe(false);
    expect(generationTerminalRecordSchema.safeParse({
      ...common,
      mode: "video",
      assets: [{ ordinal: 0, key: "wrong.webp", contentType: "image/webp", providerKey: null }],
    }).success).toBe(false);
  });

  it("permits providerInvoked=false only for an evidence-free input block", () => {
    const common = {
      version: 1 as const,
      attemptId: "attempt-input-block",
      attemptNo: 1,
      transportAttemptNo: 1,
      providerIdempotencyKey: "generation:attempt-input-block:provider",
      requestId: "request-input-block",
      generationJobId: "job-input-block",
      mode: "image" as const,
      provider: "backend",
      model: "image-model",
      providerRequestId: null,
      completedAt: "2026-07-11T12:00:00.000Z",
      usage: {},
    };
    const inputBlock = {
      ...common,
      providerInvoked: false,
      outcome: "blocked" as const,
      block: {
        policyCode: "UNDERAGE",
        message: "Input moderation blocked the request",
        layer: "input" as const,
      },
    };

    expect(generationTerminalRecordSchema.safeParse(inputBlock).success).toBe(true);
    expect(generationTerminalRecordSchema.safeParse({
      ...inputBlock,
      providerInvoked: true,
    }).success).toBe(false);
    expect(generationTerminalRecordSchema.safeParse({
      ...inputBlock,
      providerRequestId: "provider-request-that-cannot-exist",
    }).success).toBe(false);
    expect(generationTerminalRecordSchema.safeParse({
      ...inputBlock,
      accounting: {
        usage: {},
        latencyMs: 0,
        costMicros: null,
        pricingVersion: null,
      },
    }).success).toBe(false);
    expect(generationTerminalRecordSchema.safeParse({
      ...common,
      providerInvoked: false,
      outcome: "failed",
      error: {
        code: "moderation_unavailable",
        message: "Moderation unavailable",
        retryability: "retryable",
      },
    }).success).toBe(false);
    expect(generationTerminalRecordSchema.safeParse({
      ...inputBlock,
      block: { ...inputBlock.block, layer: "provider" },
    }).success).toBe(false);
  });
});
