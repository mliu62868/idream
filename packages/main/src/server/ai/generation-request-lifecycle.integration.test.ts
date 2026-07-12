import { randomUUID } from "node:crypto";
import { generationManifestChecksum } from "@idream/shared/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { recordGenerationAttemptQueuedEvent } from "./generation-attempt-events";
import { ingestGenerationManifest } from "./generation-manifest-ingest";
import { cancelGenerationRequest } from "./generation-request-lifecycle";

describe("Generation Request cancellation", () => {
  const suffix = randomUUID();
  const actorId = `cancel-actor-${suffix}`;
  const userId = `cancel-user-${suffix}`;
  const jobId = `cancel-job-${suffix}`;
  const attemptId = `cancel-attempt-${suffix}`;
  const idempotencyKey = `cancel-command-${suffix}`;

  beforeAll(async () => {
    await prisma.user.createMany({ data: [
      { id: actorId, email: `${actorId}@idream.internal`, role: "admin", status: "active" },
      { id: userId, email: `${userId}@idream.internal`, role: "user", status: "active" },
    ] });
    await prisma.generationJob.create({ data: { id: jobId, userId, mode: "image", controls: {}, presetIds: [], outputCount: 1, costDreamcoins: 10, status: "running" } });
    await prisma.dreamcoinLedger.create({ data: { userId, delta: -10, balanceAfter: 90, reason: "generation_spend", sourceId: jobId, idempotencyKey: `cancel-spend-${suffix}` } });
    await prisma.$transaction(async (tx) => {
      const attempt = await tx.generationAttempt.create({ data: { id: attemptId, requestId: jobId, attemptNo: 1, status: "queued" } });
      await recordGenerationAttemptQueuedEvent(tx, attempt);
      await tx.generationAttempt.update({ where: { id: attempt.id }, data: { status: "running", startedAt: new Date() } });
    });
  });

  afterAll(async () => {
    await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: jobId } });
    await prisma.adminAuditLog.deleteMany({ where: { actorId } });
    await prisma.controlPlaneCommandAttempt.deleteMany({ where: { commandId: { in: (await prisma.controlPlaneCommand.findMany({ where: { actorId }, select: { id: true } })).map((row) => row.id) } } });
    await prisma.controlPlaneCommand.deleteMany({ where: { actorId } });
    await prisma.inboundEventReceipt.deleteMany({ where: { sourceService: "gen", sourceEventId: attemptId } });
    await prisma.generationJobEvent.deleteMany({ where: { jobId } });
    await prisma.generationDelivery.deleteMany({ where: { requestId: jobId } });
    await prisma.generationArtifact.deleteMany({ where: { attemptId } });
    await prisma.generationTransportExecution.deleteMany({ where: { attemptId } });
    await prisma.generationAttemptEvent.deleteMany({ where: { attemptId } });
    await prisma.generationAttempt.deleteMany({ where: { id: attemptId } });
    await prisma.generationSettlementLink.deleteMany({ where: { requestId: jobId } });
    await prisma.dreamcoinLedger.deleteMany({ where: { sourceId: jobId } });
    await prisma.generationJob.deleteMany({ where: { id: jobId } });
    await prisma.user.deleteMany({ where: { id: { in: [actorId, userId] } } });
    await prisma.$disconnect();
  });

  it("replays the same cancellation, rejects key collisions, refunds once, and suppresses a late manifest", async () => {
    const input = { requestId: jobId, expectedVersion: 1, actor: { id: actorId, role: "admin" }, reason: "User requested cancellation", idempotencyKey, traceId: `cancel-trace-${suffix}` };
    const cancelled = await cancelGenerationRequest(input);
    await expect(cancelGenerationRequest(input)).resolves.toEqual(cancelled);
    await expect(cancelGenerationRequest({
      ...input,
      reason: "A different cancellation payload",
    })).rejects.toMatchObject({ status: 409 });
    expect(cancelled).toMatchObject({ requestId: jobId, status: "cancelled", version: 2, refundAmount: 10 });
    await expect(prisma.generationAttempt.findUnique({ where: { id: attemptId } })).resolves.toMatchObject({ status: "cancelled", retryability: "not_retryable" });
    await expect(prisma.generationSettlementLink.count({ where: { requestId: jobId } })).resolves.toBe(2);

    const manifest = { version: 1 as const, attemptId, attemptNo: 1, transportAttemptNo: 1, providerIdempotencyKey: `generation:${attemptId}:provider`, requestId: `provider-${suffix}`, generationJobId: jobId, mode: "image" as const, provider: "pipeline-image", providerRequestId: null, completedAt: new Date().toISOString(), assets: [{ ordinal: 0, key: `gen/${jobId}/image.webp`, contentType: "image/webp", width: 1024, height: 1024, providerKey: "late-provider-asset" }], usage: { gpuSeconds: 1 } };
    await expect(ingestGenerationManifest({ manifestRef: `gen/completion-manifests/${attemptId}/completion.json`, manifestChecksum: generationManifestChecksum(manifest), manifest })).resolves.toMatchObject({ acknowledged: true, status: "persisted" });
    await expect(prisma.generationArtifact.findFirst({ where: { attemptId } })).resolves.toMatchObject({ archiveState: "archived", validationState: "late_after_cancel", assetId: null });
    await expect(prisma.generationDelivery.findFirst({ where: { requestId: jobId } })).resolves.toMatchObject({
      status: "suppressed",
      deliveredAt: null,
    });
    await expect(prisma.generationJob.findUnique({ where: { id: jobId } })).resolves.toMatchObject({ status: "cancelled", deliveredOutputCount: 0, completedAt: null, finishedAt: expect.any(Date) });
  });
});
