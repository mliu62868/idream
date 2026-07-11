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
  requestId: "provider_request_1",
  generationJobId: "durable_manifest_job_1",
  mode: "image" as const,
  provider: "mock-image",
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
};

beforeEach(async () => {
  await prisma.mainOutboxEvent.deleteMany({ where: { id: outboxId } });
  await prisma.inboundEventReceipt.deleteMany({ where: { sourceService: "gen", sourceEventId: attemptId } });
  await prisma.generationArtifact.deleteMany({ where: { attemptId } });
  await prisma.generationTransportExecution.deleteMany({ where: { attemptId } });
  await prisma.generationAttemptEvent.deleteMany({ where: { attemptId } });
  await prisma.generationAttempt.deleteMany({ where: { id: attemptId } });
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
    expect(await prisma.generationTransportExecution.count({ where: { attemptId } })).toBe(1);
    expect(await prisma.generationArtifact.count({ where: { attemptId } })).toBe(1);
    expect(await prisma.mainOutboxEvent.findUnique({ where: { id: outboxId } })).toMatchObject({
      eventType: "generation.manifest.accepted.v1",
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
});
