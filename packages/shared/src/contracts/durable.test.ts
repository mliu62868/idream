import { describe, expect, it } from "vitest";
import {
  durableAckSchema,
  durableEnvelopeHash,
  durableEventEnvelopeSchema,
  generationCompletionManifestSchema,
  generationManifestChecksum,
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
    const manifest = generationCompletionManifestSchema.parse({
      version: 1,
      attemptId: "attempt-1",
      attemptNo: 1,
      requestId: "request-1",
      generationJobId: "job-1",
      mode: "image",
      provider: "provider-1",
      providerRequestId: null,
      completedAt: "2026-07-11T12:00:00.000Z",
      assets: [{ ordinal: 0, key: "a.webp", contentType: "image/webp", providerKey: null }],
      usage: { model: "m", gpuSeconds: 1 },
    });
    expect(generationManifestChecksum(manifest)).toBe(
      generationManifestChecksum({ ...manifest, usage: { gpuSeconds: 1, model: "m" } }),
    );
  });

  it("carries explicit provider accounting and rejects guessed pricing", () => {
    const accounting = {
      usage: { images: 2 },
      latencyMs: 640,
      costMicros: 125_000,
      pricingVersion: "fal-flux-v3",
    };
    const manifest = {
      version: 1 as const,
      attemptId: "attempt-1",
      attemptNo: 1,
      requestId: "request-1",
      generationJobId: "job-1",
      mode: "image" as const,
      provider: "fal",
      model: "flux-pro",
      providerRequestId: "provider-request-1",
      completedAt: "2026-07-11T12:00:00.000Z",
      assets: [{ ordinal: 0, key: "a.webp", contentType: "image/webp", providerKey: null }],
      usage: { images: 2 },
      accounting,
    };
    expect(generationCompletionManifestSchema.parse(manifest)).toMatchObject({ accounting });

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
});
