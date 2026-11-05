import { durableEnvelopeHash, generationTerminalRecordChecksum } from "./durable-server";
import { describe, expect, it } from "vitest";
import {
  durableAckSchema,
  durableEventEnvelopeSchema,
  generationTerminalRecordSchema,
  generationTransportExecutionEventSchema,
} from "./durable";
import { generationAssetDerivativeKey } from "./generation-identity";
import { aiUsageRecordedV2Schema } from "./metric-events";

describe("durable cross-service contracts", () => {
  it("preserves historical failed checksums while retaining bounded cleanup intent", () => {
    const old = generationTerminalRecordSchema.parse({
      version: 1, outcome: "failed", attemptId: "cleanup-attempt", attemptNo: 1,
      providerIdempotencyKey: "generation:cleanup-attempt:provider", requestId: "request", generationJobId: "job",
      mode: "image", provider: "mock", providerInvoked: true, providerRequestId: null,
      completedAt: "2026-10-05T12:00:00.000Z", usage: {},
      error: { code: "asset_persist_failed", message: "store unavailable", retryability: "retryable" },
    });
    expect(old).not.toHaveProperty("cleanupKeys");
    expect(generationTerminalRecordChecksum(generationTerminalRecordSchema.parse(old)))
      .toBe(generationTerminalRecordChecksum(old));
    const cleanupKeys = ["gen/job/attempts/cleanup-attempt/image-1.png"];
    expect(generationTerminalRecordSchema.parse({ ...old, cleanupKeys })).toMatchObject({ cleanupKeys });
    expect(generationTerminalRecordSchema.safeParse({ ...old, cleanupKeys: [...cleanupKeys, ...cleanupKeys] }).success).toBe(false);
    expect(generationTerminalRecordSchema.safeParse({ ...old, cleanupKeys: Array.from({ length: 9 }, (_, i) => `key-${i}`) }).success).toBe(false);
    expect(generationTerminalRecordSchema.safeParse({ ...old, cleanupKeys: Array.from({ length: 8 }, (_, i) => `key-${i}`) }).success).toBe(true);
  });

  describe("asset derivatives", () => {
    const succeeded = {
      version: 1, outcome: "succeeded", attemptId: "attempt-1", attemptNo: 1,
      providerIdempotencyKey: "generation:attempt-1:provider", requestId: "request-1", generationJobId: "job-1",
      mode: "image", provider: "provider-1", providerInvoked: true, providerRequestId: null,
      completedAt: "2026-07-11T12:00:00.000Z",
      assets: [{ ordinal: 0, key: "gen/job-1/attempts/attempt-1/image-1.png", contentType: "image/png", width: 8, height: 8, providerKey: null }],
      usage: { model: "m" },
    };

    it("keeps the checksum of a record persisted before derivatives existed", () => {
      // Golden value computed from the schema as it stood before `derivative` was added.
      const historical = generationTerminalRecordSchema.parse(succeeded);
      expect(historical.outcome === "succeeded" && historical.assets[0]).not.toHaveProperty("derivative");
      expect(generationTerminalRecordChecksum(historical)).toBe("6a7b73a3d724bcc0b909eac975cb0fc8cb3577c6be7b58e031e7d73a50b2b55c");
    });

    it("survives parsing, because an old-shape parser would strip it and quarantine the record", () => {
      const derivative = { status: "ready", key: "gen/job-1/attempts/attempt-1/image-1.preview.webp", contentType: "image/webp", width: 8, height: 8, sizeBytes: 44 };
      const parsed = generationTerminalRecordSchema.parse({ ...succeeded, assets: [{ ...succeeded.assets[0], derivative }] });
      expect(parsed.outcome === "succeeded" && parsed.assets[0]!.derivative).toEqual(derivative);
      const failed = { status: "failed", code: "derivative_render_failed", message: "ffmpeg missing" };
      expect(generationTerminalRecordSchema.safeParse({ ...succeeded, assets: [{ ...succeeded.assets[0], derivative: failed }] }).success).toBe(true);
      expect(generationTerminalRecordSchema.safeParse({ ...succeeded, assets: [{ ...succeeded.assets[0], derivative: { status: "ready", key: "x", contentType: "image/png", width: 1, height: 1, sizeBytes: 1 } }] }).success).toBe(false);
    });

    it("derives one key from a canonical asset key and nothing else", () => {
      const prefix = "gen/job-1/attempts/job-1:2/";
      expect(generationAssetDerivativeKey(`${prefix}image-4.jpg`)).toBe(`${prefix}image-4.preview.webp`);
      expect(generationAssetDerivativeKey(`${prefix}image-1.webp`)).toBe(`${prefix}image-1.preview.webp`);
      expect(generationAssetDerivativeKey(`${prefix}video.mp4`)).toBe(`${prefix}video.preview.webp`);
      for (const key of [
        `${prefix}image-1.preview.webp`, `${prefix}video.preview.webp`, `${prefix}image-5.png`, `${prefix}video.png`, `${prefix}image-1.mp4`,
        "gen/job-1/image-1.png", "gen/job-1/attempts/a/b/image-1.png", "../gen/job-1/attempts/a/image-1.png",
        "gen/terminal-records/a/terminal.json", "character-images/c/a.png", "imports/a/b", "video-sequences/u/s/o/h.mp4",
      ]) expect(generationAssetDerivativeKey(key), key).toBeNull();
    });
  });
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

  it("permits providerInvoked=false only for an evidence-free input block or preparation failure", () => {
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
    const preparationFailure = {
      ...common,
      providerInvoked: false,
      outcome: "failed",
      error: {
        code: "preparation_failed",
        message: "Reference image could not be loaded",
        retryability: "retryable",
      },
    };
    expect(generationTerminalRecordSchema.safeParse(preparationFailure).success).toBe(true);
    const diagnostic = { code: "localized_image_edit_failed", elapsedMs: 4200, details: { segmentation: { code: "target_not_found", presence: 0.03 } } };
    expect(generationTerminalRecordSchema.parse({ ...preparationFailure, preparation: diagnostic })).toHaveProperty("preparation", diagnostic);
    expect(generationTerminalRecordSchema.parse(preparationFailure)).not.toHaveProperty("preparation");
    expect(generationTerminalRecordSchema.safeParse({ ...preparationFailure, preparation: diagnostic, providerInvoked: true }).success).toBe(false);
    expect(generationTerminalRecordSchema.safeParse({ ...preparationFailure, preparation: diagnostic, error: { ...preparationFailure.error, code: "provider_error" } }).success).toBe(false);
    expect(generationTerminalRecordSchema.safeParse({ ...preparationFailure, preparation: { ...diagnostic, elapsedMs: -1 } }).success).toBe(false);
    for (const invalid of [
      { providerRequestId: "invented-provider-request" },
      { accounting: { usage: {}, latencyMs: 0, costMicros: null, pricingVersion: null } },
      { usage: { images: 1 } },
      { outcome: "unknown" },
    ]) {
      expect(generationTerminalRecordSchema.safeParse({ ...preparationFailure, ...invalid }).success).toBe(false);
    }
  });
});


it("separates resource waiting from provider invocation evidence", () => {
  const wait = {
    version: 1, attemptId: "wait-attempt", attemptNo: 1, generationJobId: "wait-job",
    transportAttemptNo: 1, provider: "backend", model: "model", providerRequestId: null,
    idempotencyKey: "provider-key", status: "waiting", occurredAt: "2026-09-05T12:00:00.000Z",
  };
  expect(generationTransportExecutionEventSchema.parse(wait)).toMatchObject({ status: "waiting" });
  for (const invalid of [{ providerRequestId: "already-submitted" }, { error: { code: "provider_error", message: "error" } }, { accounting: { usage: {}, latencyMs: 0, costMicros: null, pricingVersion: null } }]) {
    expect(generationTransportExecutionEventSchema.safeParse({ ...wait, ...invalid }).success).toBe(false);
  }
});
