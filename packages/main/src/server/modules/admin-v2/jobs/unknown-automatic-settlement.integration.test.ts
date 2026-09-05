import { markProductionItemGenerated } from "@/server/modules/content-production-state";
import type { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generationTerminalRecordChecksum, generationTerminalRecordSchema } from "@idream/shared/contracts";
import { generationJobDetailResponseSchema, generationJobQuerySchema } from "@idream/shared/admin";
import { prisma } from "@/server/lib/db";
import { jobQueue } from "@/server/jobs/queue";
import { reserveInitialGenerationAttempt, resolveGenerationAttemptRetryAuthority } from "@/server/modules/generation/generation-attempt-authority";
import { recordGenerationAttemptEvent } from "@/server/ai/generation-attempt-events";
import { ingestGenerationTerminalRecord } from "@/server/ai/generation-terminal-record-ingest";
import { resolveGenerationAssetSuccessAttempts } from "@/server/ai/generation-asset-success-authority";
import { AUTOMATIC_UNKNOWN_SETTLEMENT_ACTOR_ID } from "@/server/ai/generation-unknown-resolution-evidence";
import { loadCharacterMediaOperationsProjection } from "../characters/character-media-operations";
import { getGenerationJobV2, queryGenerationJobsV2Authority } from "./query";
import { reconcileUnknownGenerationRequest } from "./unknown-reconciliation";

const suffix = randomUUID();
const actorId = `automatic-recovery-admin-${suffix}`;
const userId = `automatic-recovery-user-${suffix}`;
const requestIds: string[] = [];
const attemptIds: string[] = [];
const characterIds: string[] = [];
const runIds: string[] = [];

async function fixture(cost = 0, purpose = "character_hero") {
  const requestId = `automatic-recovery-${randomUUID()}`;
  const characterId = `automatic-recovery-character-${randomUUID()}`;
  requestIds.push(requestId); characterIds.push(characterId);
  await prisma.character.create({ data: { id: characterId, name: "Automatic timeout recovery", description: "Adult character recovery test", age: 28, source: "official", status: "approved", creatorId: userId, appearance: {}, advancedDetails: {} } });
  await prisma.generationJob.create({ data: { id: requestId, userId, characterId: cost > 0 ? null : characterId, mode: "image", status: "queued", provider: "mock", model: "mock-image-v2", prompt: "Adult character portrait", sourceType: cost > 0 ? "generator" : "content_production_item", controls: {}, presetIds: [], outputCount: 1, costDreamcoins: cost } });
  const runId = cost === 0 ? `run-${requestId}` : null;
  const itemId = cost === 0 ? `item-${requestId}` : null;
  if (runId && itemId) {
    runIds.push(runId);
    await prisma.contentProductionBatch.create({ data: {
      id: runId, title: "Late result recovery run", purpose, targetType: purpose === "campaign" ? "campaign" : "character", targetId: characterId,
      presetIds: [], count: 1, totalItems: 1, status: "queued", lifecycleState: "active", workflowStage: "generation", verificationState: "pending", createdById: actorId,
      items: { create: { id: itemId, jobId: requestId, itemIndex: 0, status: "queued", tags: [] } },
    } });
    await prisma.generationJob.update({ where: { id: requestId }, data: { sourceId: itemId } });
  }
  const reserved = await prisma.$transaction((tx) => reserveInitialGenerationAttempt(tx, { requestId, creativeRunItemId: itemId, dispatch: { outboxId: `dispatch-${requestId}`, eventType: "generation.retry.dispatch.v2", payload: {} } }));
  const attemptId = reserved.attempt.id; attemptIds.push(attemptId);
  const queueInput = (reserved.outbox.payload as { queueInput: { queue: string; dedupeKey: string; payload: Record<string, unknown>; maxAttempts: number } }).queueInput;
  await prisma.$transaction((tx) => recordGenerationAttemptEvent(tx, { eventId: `unknown-${attemptId}`, attemptId, eventType: "generation.attempt.unknown.v1", outcome: "unknown", occurredAt: new Date(), payload: {}, errorCode: "stale_provider_outcome", retryability: "operator_retry" }));
  await prisma.generationTransportExecution.create({ data: { attemptId, transportAttemptNo: 1, status: "unknown", idempotencyKey: `generation:${attemptId}:provider`, providerRequestId: null, finishedAt: new Date() } });
  if (cost > 0) await prisma.dreamcoinLedger.create({ data: { userId, delta: -cost, balanceAfter: 90, reason: "generation_spend", sourceId: requestId, idempotencyKey: `spend-${requestId}` } });
  const terminal = generationTerminalRecordSchema.parse({ version: 1, outcome: "succeeded", attemptId, attemptNo: 1, transportAttemptNo: 1, providerIdempotencyKey: `generation:${attemptId}:provider`, requestId: queueInput.payload.requestId, generationJobId: requestId, mode: "image", provider: queueInput.payload.provider, providerInvoked: true, model: queueInput.payload.model, providerRequestId: `provider-${attemptId}`, completedAt: new Date().toISOString(), usage: {}, assets: [{ ordinal: 0, key: `${queueInput.payload.outputPrefix}recovered.webp`, contentType: "image/webp", width: 768, height: 1024, providerKey: null }] });
  const ingest = () => ingestGenerationTerminalRecord({ terminalRecord: terminal, terminalRecordRef: `gen/terminal-records/${attemptId}/terminal.json`, terminalRecordChecksum: generationTerminalRecordChecksum(terminal) });
  const command = async (resolution: "confirm_failed" | "adopt_succeeded", system = false, key?: string, version?: number) => {
    const request = await prisma.generationJob.findUniqueOrThrow({ where: { id: requestId } });
    return reconcileUnknownGenerationRequest({ requestId, actor: { id: system ? AUTOMATIC_UNKNOWN_SETTLEMENT_ACTOR_ID : actorId, role: system ? "system" : "admin" }, command: { resolution, entityVersion: version ?? request.version, reason: "Verified generation recovery evidence", providerEvidenceRefs: [`attempt:${attemptId}`], confirmation: `${requestId}:${resolution}` }, idempotencyKey: key ?? (system ? `generation-unknown-sweep:${requestId}:${attemptId}` : `operator-${requestId}-${resolution}`), traceId: `trace-${requestId}` });
  };
  const detail = async () => generationJobDetailResponseSchema.parse((await (await getGenerationJobV2(new Request(`http://localhost/api/v2/admin/jobs/${requestId}`, { headers: { "x-idream-user-id": actorId, "x-idream-role": "admin" } }), requestId)).json()).data);
  return { requestId, characterId, runId, itemId, attemptId, queueInput, ingest, command, detail };
}

describe("automatic unknown timeout compensation", () => {
  beforeAll(async () => {
    await prisma.user.createMany({ data: [{ id: actorId, email: `${actorId}@example.test`, role: "admin", status: "active", dataClass: "internal" }, { id: userId, email: `${userId}@example.test`, status: "active", dataClass: "internal" }] });
  });
  afterAll(async () => {
    await prisma.contentProductionBatch.deleteMany({ where: { id: { in: runIds } } });
    await prisma.generationDelivery.deleteMany({ where: { requestId: { in: requestIds } } });
    await prisma.generationArtifact.deleteMany({ where: { attemptId: { in: attemptIds } } });
    await prisma.mediaAsset.deleteMany({ where: { sourceJobId: { in: requestIds } } });
    await prisma.aiUsageFact.deleteMany({ where: { attemptId: { in: attemptIds } } });
    await prisma.generationSettlementLink.deleteMany({ where: { requestId: { in: requestIds } } });
    await prisma.dreamcoinLedger.deleteMany({ where: { sourceId: { in: requestIds } } });
    await prisma.generationTransportExecution.deleteMany({ where: { attemptId: { in: attemptIds } } });
    await prisma.generationAttemptEvent.deleteMany({ where: { attemptId: { in: attemptIds } } });
    await prisma.generationAttempt.deleteMany({ where: { id: { in: attemptIds } } });
    await prisma.generationJobEvent.deleteMany({ where: { jobId: { in: requestIds } } });
    await prisma.generationJob.deleteMany({ where: { id: { in: requestIds } } });
    await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: { in: requestIds } } });
    await prisma.controlPlaneCommand.deleteMany({ where: { targetId: { in: requestIds } } });
    await prisma.adminAuditLog.deleteMany({ where: { targetId: { in: requestIds } } });
    await prisma.inboundEventReceipt.deleteMany({ where: { sourceEventId: { in: attemptIds } } });
    await prisma.moderationEvent.deleteMany({ where: { targetId: { in: requestIds } } });
    await prisma.character.deleteMany({ where: { id: { in: characterIds } } });
    await prisma.user.deleteMany({ where: { id: { in: [actorId, userId] } } });
    await prisma.$disconnect();
  });

  it.each(["character_hero", "campaign"])("adopts the same late artifact and repairs its failed %s Run item while preserving both audited decisions", async (purpose) => {
    const f = await fixture(0, purpose);
    const failed = await f.command("confirm_failed", true);
    expect(failed).toMatchObject({ requestStatus: "failed", refundAmount: 0 });
    expect(await prisma.contentProductionItem.findUniqueOrThrow({ where: { id: f.itemId! } })).toMatchObject({ status: "failed", version: 2, mediaAssetId: null });
    expect(await prisma.contentProductionBatch.findUniqueOrThrow({ where: { id: f.runId! } })).toMatchObject({ lifecycleState: "closed", failedItems: 1 });
    await expect(prisma.$transaction((tx) => markProductionItemGenerated(tx, { jobId: f.requestId, mediaAssetId: "unbound-asset" }))).rejects.toThrow("cannot rewrite Creative item state");
    await expect(f.ingest()).resolves.toMatchObject({ status: "persisted" });
    const originalArtifact = await prisma.generationArtifact.findFirstOrThrow({ where: { attemptId: f.attemptId } });
    const originalFailure = await prisma.controlPlaneCommand.findUniqueOrThrow({ where: { id: failed.commandId } });
    expect(await f.detail()).toMatchObject({ request: { requestOutcome: "needs_reconciliation" }, unknownTerminalEvidence: { adoptable: true } });
    const list = await queryGenerationJobsV2Authority({ db: prisma, query: generationJobQuerySchema.parse({ search: f.requestId }) });
    expect(list.items[0]?.requestOutcome).toBe("needs_reconciliation");
    const operation = (await loadCharacterMediaOperationsProjection(f.characterId)).operations[0];
    expect(operation.recoverability).toMatchObject({ state: "operator_action", reason: expect.stringContaining("adopt the recovered output") });
    const request = await prisma.generationJob.findUniqueOrThrow({ where: { id: f.requestId } });
    const attempt = await prisma.generationAttempt.findUniqueOrThrow({ where: { id: f.attemptId } });
    expect(await resolveGenerationAttemptRetryAuthority(prisma, { request, latestAttempt: attempt })).toMatchObject({ allowed: false });
    const adopted = await f.command("adopt_succeeded");
    expect(adopted).toMatchObject({ requestStatus: "completed", deliveredCount: 1, refundAmount: 0, attemptStatus: "unknown" });
    expect(await f.command("adopt_succeeded", false, `operator-${f.requestId}-adopt_succeeded`, failed.version)).toEqual(adopted);
    const asset = await prisma.mediaAsset.findFirstOrThrow({ where: { sourceJobId: f.requestId } });
    expect((await resolveGenerationAssetSuccessAttempts(prisma, [asset])).get(asset.id)?.id).toBe(f.attemptId);
    expect(await prisma.generationArtifact.findUniqueOrThrow({ where: { id: originalArtifact.id } })).toMatchObject({ validationState: "valid", archiveState: "active", assetId: asset.id });
    expect(await prisma.contentProductionItem.findUniqueOrThrow({ where: { id: f.itemId! } })).toMatchObject({ status: "generated", version: 3, jobId: f.requestId, mediaAssetId: asset.id });
    expect(await prisma.contentProductionBatch.findUniqueOrThrow({ where: { id: f.runId! } })).toMatchObject({
      lifecycleState: purpose === "campaign" ? "active" : "closed", workflowStage: purpose === "campaign" ? "placement" : "generation", verificationState: "pending", completedItems: 1, failedItems: 0, totalItems: 1,
    });
    expect(await prisma.generationArtifact.count({ where: { attemptId: f.attemptId } })).toBe(1);
    expect(await prisma.generationDelivery.count({ where: { requestId: f.requestId, status: "delivered" } })).toBe(1);
    expect(await prisma.generationAttempt.findUniqueOrThrow({ where: { id: f.attemptId } })).toEqual(attempt);
    expect(await prisma.controlPlaneCommand.findUniqueOrThrow({ where: { id: failed.commandId } })).toEqual(originalFailure);
    expect(await prisma.generationJobEvent.count({ where: { jobId: f.requestId, type: { in: ["unknown_reconciliation_confirm_failed", "unknown_reconciliation_adopt_succeeded"] } } })).toBe(2);
    expect(await prisma.dreamcoinLedger.count({ where: { sourceId: f.requestId } })).toBe(0);
  });

  it.each(["refunded", "manual", "forged", "older-evidence"] as const)("does not compensate %s terminal authority", async (kind) => {
    const f = await fixture(kind === "refunded" ? 10 : 0);
    const failed = await f.command("confirm_failed", kind !== "manual");
    await f.ingest();
    if (kind === "forged") await prisma.controlPlaneCommand.update({ where: { id: failed.commandId }, data: { status: "failed" } });
    if (kind === "older-evidence") await prisma.generationJobEvent.updateMany({ where: { jobId: f.requestId, type: "unknown_terminal_resolution_evidence_recovered" }, data: { createdAt: new Date("2020-01-01T00:00:00.000Z") } });
    const ledger = await prisma.dreamcoinLedger.findMany({ where: { sourceId: f.requestId } });
    expect((await f.detail()).unknownTerminalEvidence?.adoptable).toBe(false);
    await expect(f.command("adopt_succeeded")).rejects.toThrow("terminal operator resolution");
    expect(await prisma.mediaAsset.count({ where: { sourceJobId: f.requestId } })).toBe(0);
    expect(await prisma.dreamcoinLedger.findMany({ where: { sourceId: f.requestId } })).toEqual(ledger);
  });

  it("does not auto-settle while the exact original queued execution remains recoverable", async () => {
    const f = await fixture();
    await jobQueue.enqueue({ ...f.queueInput, payload: f.queueInput.payload as Prisma.InputJsonObject });
    try {
      await expect(f.command("confirm_failed", true)).rejects.toThrow("still recoverable");
      expect(await prisma.generationJob.findUniqueOrThrow({ where: { id: f.requestId } })).toMatchObject({ status: "queued", version: 1 });
      expect(await prisma.controlPlaneCommand.count({ where: { targetId: f.requestId } })).toBe(0);
    } finally { await jobQueue.removeByDedupeKey(f.queueInput.queue, f.queueInput.dedupeKey); }
  });
});
