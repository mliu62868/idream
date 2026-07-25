import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { renderPrometheusMetrics, resetMetricsForTests } from "@idream/shared";
import { generationManifestChecksum } from "@idream/shared/contracts";
import { prisma } from "@/server/lib/db";
import { ingestGenerationManifest } from "./generation-manifest-ingest";

const attemptId = "durable_manifest_attempt_1";
const outboxId = `generation_manifest_${attemptId}`;

const manifest = {
  version: 1 as const,
  attemptId,
  attemptNo: 1,
  transportAttemptNo: 2,
  providerIdempotencyKey: `generation:${attemptId}:provider`,
  requestId: "provider_request_1",
  generationJobId: "durable_manifest_job_1",
  mode: "image" as const,
  provider: "mock-image",
  model: "mock-image-v2",
  providerRequestId: "provider-1",
  completedAt: "2026-07-11T12:00:00.000Z",
  assets: [{
    ordinal: 0,
    key: "gen/durable/1.webp",
    contentType: "image/webp",
    width: 1024,
    height: 1024,
    providerKey: "provider-asset-1",
  }],
  usage: { gpuSeconds: 1.2, model: "mock-image" },
  accounting: {
    usage: { images: 1, gpuSeconds: 1.2 },
    latencyMs: 640,
    costMicros: 125_000,
    pricingVersion: "mock-image-pricing-v2",
  },
};

beforeEach(async () => {
  await prisma.mainOutboxEvent.deleteMany({ where: { id: outboxId } });
  await prisma.inboundEventReceipt.deleteMany({ where: { sourceService: "gen", sourceEventId: attemptId } });
  await prisma.generationArtifact.deleteMany({ where: { attemptId } });
  await prisma.generationTransportExecution.deleteMany({ where: { attemptId } });
  await prisma.generationAttemptEvent.deleteMany({ where: { attemptId } });
  await prisma.generationAttempt.deleteMany({ where: { id: attemptId } });
  await prisma.aiUsageFact.deleteMany({ where: { attemptId } });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("generation completion manifest durable ingest", () => {
  it("atomically records receipt, attempt, transport, artifact and finalize outbox", async () => {
    resetMetricsForTests();
    const input = {
      manifestRef: `gen/completion-manifests/${attemptId}/manifest.json`,
      manifestChecksum: generationManifestChecksum(manifest),
      manifest,
    };
    expect(await ingestGenerationManifest(input)).toMatchObject({ acknowledged: true, status: "persisted" });
    expect(await ingestGenerationManifest(input)).toMatchObject({ acknowledged: true, status: "duplicate" });
    expect(renderPrometheusMetrics()).toContain(
      "generation_completion_manifest_replay_total{outcome=\"durable_duplicate\"} 1",
    );

    expect(await prisma.inboundEventReceipt.count({ where: { sourceService: "gen", sourceEventId: attemptId } })).toBe(1);
    expect(await prisma.generationAttempt.findUnique({ where: { id: attemptId } })).toMatchObject({
      requestId: manifest.generationJobId,
      status: "running",
      completionManifestRef: input.manifestRef,
    });
    expect(await prisma.generationAttemptEvent.findMany({ where: { attemptId } })).toEqual([
      expect.objectContaining({
        sequence: 1,
        eventType: "generation.attempt.manifest_ingested.v1",
        outcome: null,
      }),
    ]);
    expect(await prisma.generationTransportExecution.findUnique({ where: { attemptId_transportAttemptNo: { attemptId, transportAttemptNo: 2 } } })).toMatchObject({
      status: "succeeded",
      idempotencyKey: manifest.providerIdempotencyKey,
      latencyMs: manifest.accounting.latencyMs,
      costMicros: BigInt(manifest.accounting.costMicros),
      pricingVersion: manifest.accounting.pricingVersion,
    });
    expect(await prisma.aiUsageFact.findMany({ where: { attemptId } })).toEqual([
      expect.objectContaining({
        requestId: manifest.generationJobId,
        provider: manifest.provider,
        model: manifest.model,
        latencyMs: manifest.accounting.latencyMs,
        costMicros: BigInt(manifest.accounting.costMicros),
        pricingVersion: manifest.accounting.pricingVersion,
      }),
    ]);
    expect(await prisma.generationArtifact.count({ where: { attemptId } })).toBe(1);
    expect(await prisma.mainOutboxEvent.findUnique({ where: { id: outboxId } })).toMatchObject({
      eventType: "generation.manifest.accepted.v1",
      payload: expect.objectContaining({
        provider: manifest.provider,
        model: manifest.model,
      }),
    });
  });

  it("rejects a checksum mismatch before creating authority rows", async () => {
    const result = await ingestGenerationManifest({
      manifestRef: "gen/bad.json",
      manifestChecksum: "0".repeat(64),
      manifest,
    });
    expect(result).toEqual({ acknowledged: false, status: "quarantined", receiptId: null });
    expect(await prisma.generationAttempt.findUnique({ where: { id: attemptId } })).toBeNull();
  });

  it("does not rewrite a terminal TransportExecution when a conflicting completion manifest arrives", async () => {
    await prisma.generationAttempt.create({
      data: { id: attemptId, requestId: manifest.generationJobId, attemptNo: 1, status: "running" },
    });
    await prisma.generationTransportExecution.create({
      data: {
        attemptId,
        transportAttemptNo: manifest.transportAttemptNo,
        idempotencyKey: manifest.providerIdempotencyKey,
        status: "failed",
        finishedAt: new Date("2026-07-11T11:59:00.000Z"),
      },
    });
    const input = {
      manifestRef: `gen/completion-manifests/${attemptId}/conflict.json`,
      manifestChecksum: generationManifestChecksum(manifest),
      manifest,
    };

    await expect(ingestGenerationManifest(input)).rejects.toThrow("cannot rewrite a terminal TransportExecution");
    await expect(prisma.generationTransportExecution.findUniqueOrThrow({
      where: { attemptId_transportAttemptNo: { attemptId, transportAttemptNo: manifest.transportAttemptNo } },
    })).resolves.toMatchObject({ status: "failed", manifestRef: null });
    await expect(prisma.inboundEventReceipt.count({ where: { sourceService: "gen", sourceEventId: attemptId } })).resolves.toBe(0);
    await expect(prisma.generationArtifact.count({ where: { attemptId } })).resolves.toBe(0);
    await expect(prisma.mainOutboxEvent.count({ where: { id: outboxId } })).resolves.toBe(0);
  });

  it("does not reopen a terminal business Attempt from a late manifest", async () => {
    await prisma.generationAttempt.create({
      data: { id: attemptId, requestId: manifest.generationJobId, attemptNo: 1, status: "succeeded", finishedAt: new Date() },
    });
    const input = {
      manifestRef: `gen/completion-manifests/${attemptId}/late.json`,
      manifestChecksum: generationManifestChecksum(manifest),
      manifest,
    };

    await expect(ingestGenerationManifest(input)).rejects.toThrow("cannot reopen a terminal Generation Attempt");
    await expect(prisma.generationAttempt.findUniqueOrThrow({ where: { id: attemptId } })).resolves.toMatchObject({ status: "succeeded" });
    await expect(prisma.inboundEventReceipt.count({ where: { sourceService: "gen", sourceEventId: attemptId } })).resolves.toBe(0);
    await expect(prisma.generationTransportExecution.count({ where: { attemptId } })).resolves.toBe(0);
    await expect(prisma.generationArtifact.count({ where: { attemptId } })).resolves.toBe(0);
  });

  it("archives late artifacts without delivery when the business Attempt is cancelled", async () => {
    const suffix = crypto.randomUUID();
    const userId = `late-user-${suffix}`;
    const jobId = `late-job-${suffix}`;
    const cancelledAttemptId = `late-attempt-${suffix}`;
    const lateManifest = { ...manifest, attemptId: cancelledAttemptId, generationJobId: jobId, requestId: `late-provider-${suffix}`, providerIdempotencyKey: `generation:${cancelledAttemptId}:provider` };
    const lateOutboxId = `generation_manifest_${cancelledAttemptId}`;
    try {
      await prisma.user.create({ data: { id: userId, email: `${userId}@idream.internal`, status: "active" } });
      await prisma.generationJob.create({ data: { id: jobId, userId, mode: "image", controls: {}, presetIds: [], status: "cancelled" } });
      await prisma.generationAttempt.create({ data: { id: cancelledAttemptId, requestId: jobId, attemptNo: 1, status: "cancelled", finishedAt: new Date() } });
      const input = { manifestRef: `gen/completion-manifests/${cancelledAttemptId}/completion.json`, manifestChecksum: generationManifestChecksum(lateManifest), manifest: lateManifest };
      await expect(ingestGenerationManifest(input)).resolves.toMatchObject({ acknowledged: true, status: "persisted" });
      await expect(prisma.generationArtifact.findMany({ where: { attemptId: cancelledAttemptId } })).resolves.toEqual([expect.objectContaining({ validationState: "late_after_cancel", archiveState: "archived", assetId: null })]);
      await expect(prisma.generationDelivery.findFirst({ where: { requestId: jobId } })).resolves.toMatchObject({
        status: "suppressed",
        deliveredAt: null,
      });
      await expect(prisma.mainOutboxEvent.findUnique({ where: { id: lateOutboxId } })).resolves.toBeNull();
      await expect(prisma.generationJob.findUnique({ where: { id: jobId } })).resolves.toMatchObject({ status: "cancelled", completedAt: null });
    } finally {
      await prisma.mainOutboxEvent.deleteMany({ where: { id: lateOutboxId } });
      await prisma.inboundEventReceipt.deleteMany({ where: { sourceService: "gen", sourceEventId: cancelledAttemptId } });
      await prisma.generationJobEvent.deleteMany({ where: { jobId } });
      await prisma.generationDelivery.deleteMany({ where: { requestId: jobId } });
      await prisma.generationArtifact.deleteMany({ where: { attemptId: cancelledAttemptId } });
      await prisma.generationTransportExecution.deleteMany({ where: { attemptId: cancelledAttemptId } });
      await prisma.generationAttemptEvent.deleteMany({ where: { attemptId: cancelledAttemptId } });
      await prisma.generationAttempt.deleteMany({ where: { id: cancelledAttemptId } });
      await prisma.generationJob.deleteMany({ where: { id: jobId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });

  it("archives late artifacts without delivery after a stale-failed Attempt", async () => {
    const suffix = crypto.randomUUID();
    const userId = `late-failed-user-${suffix}`;
    const jobId = `late-failed-job-${suffix}`;
    const failedAttemptId = `late-failed-attempt-${suffix}`;
    const lateManifest = {
      ...manifest,
      attemptId: failedAttemptId,
      generationJobId: jobId,
      requestId: `late-failed-provider-${suffix}`,
      providerIdempotencyKey: `generation:${failedAttemptId}:provider`,
    };
    try {
      await prisma.user.create({
        data: {
          id: userId,
          email: `${userId}@idream.internal`,
          status: "active",
        },
      });
      await prisma.generationJob.create({
        data: {
          id: jobId,
          userId,
          mode: "video",
          controls: {},
          presetIds: [],
          status: "failed",
          errorCode: "stale_timeout",
        },
      });
      await prisma.generationAttempt.create({
        data: {
          id: failedAttemptId,
          requestId: jobId,
          attemptNo: 1,
          status: "failed",
          errorCode: "stale_timeout",
          finishedAt: new Date(),
        },
      });
      const input = {
        manifestRef: `gen/completion-manifests/${failedAttemptId}/completion.json`,
        manifestChecksum: generationManifestChecksum(lateManifest),
        manifest: lateManifest,
      };

      await expect(ingestGenerationManifest(input)).resolves.toMatchObject({
        acknowledged: true,
        status: "persisted",
      });
      await expect(
        prisma.generationArtifact.findMany({
          where: { attemptId: failedAttemptId },
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          validationState: "late_after_failed",
          archiveState: "archived",
          assetId: null,
        }),
      ]);
      await expect(
        prisma.generationDelivery.findFirst({ where: { requestId: jobId } }),
      ).resolves.toMatchObject({ status: "suppressed", deliveredAt: null });
    } finally {
      await prisma.inboundEventReceipt.deleteMany({
        where: { sourceService: "gen", sourceEventId: failedAttemptId },
      });
      await prisma.generationJobEvent.deleteMany({ where: { jobId } });
      await prisma.generationDelivery.deleteMany({ where: { requestId: jobId } });
      await prisma.generationArtifact.deleteMany({
        where: { attemptId: failedAttemptId },
      });
      await prisma.generationTransportExecution.deleteMany({
        where: { attemptId: failedAttemptId },
      });
      await prisma.generationAttemptEvent.deleteMany({
        where: { attemptId: failedAttemptId },
      });
      await prisma.generationAttempt.deleteMany({
        where: { id: failedAttemptId },
      });
      await prisma.generationJob.deleteMany({ where: { id: jobId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });
});
