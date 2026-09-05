import type { Prisma } from "@prisma/client";
import { generationTerminalRecordSchema, generationTerminalRecordChecksum } from "@idream/shared/contracts";
import { canonicalSha256 } from "@/server/modules/admin-v2/shared/canonical-json";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";

// Projection fixture for the facts written atomically by unknown reconciliation.
// The real ingest/adopt transaction is exercised in unknown-reconciliation.integration.test.ts.
export async function recoveredGenerationFixture(tx: Prisma.TransactionClient, assetId: string, actorId: string) {
  const asset = await tx.mediaAsset.findUniqueOrThrow({ where: { id: assetId } });
  const job = await tx.generationJob.findUniqueOrThrow({ where: { id: asset.sourceJobId! } });
  if (job.status !== "completed" || job.deliveredOutputCount !== 1) throw new Error("Recovered projection fixture requires a completed one-output Request");
  const previous = await tx.generationAttempt.findFirstOrThrow({ where: { requestId: job.id }, orderBy: { attemptNo: "desc" } });
  const attempt = await tx.generationAttempt.create({ data: {
    requestId: job.id, attemptNo: previous.attemptNo + 1, status: "unknown", provider: previous.provider,
    profileKey: previous.profileKey, profileVersion: previous.profileVersion, workflowKey: previous.workflowKey, workflowVersion: previous.workflowVersion,
    errorCode: "ambiguous_non_replayable", operatorGuidance: "Reconcile provider before retrying.",
  } });
  const terminal = generationTerminalRecordSchema.parse({
    version: 1, outcome: "succeeded", attemptId: attempt.id, attemptNo: attempt.attemptNo,
    providerIdempotencyKey: `generation:${attempt.id}:provider`, requestId: `generation_dispatch_${attempt.id}`,
    generationJobId: job.id, mode: job.mode, provider: job.provider, providerInvoked: true, model: job.model ?? "test-model",
    providerRequestId: `provider-${attempt.id}`, completedAt: new Date().toISOString(), usage: { providerRequestIds: [`provider-${attempt.id}`] },
    assets: [{ ordinal: 0, key: asset.storageKey!, contentType: asset.contentType ?? "image/webp", providerKey: null }],
  });
  const terminalRecordRef = `gen/terminal-records/${attempt.id}/resolved.json`;
  const terminalRecordChecksum = generationTerminalRecordChecksum(terminal);
  const envelopeHash = canonicalSha256({ terminalRecordRef, terminalRecordChecksum });
  const receipt = await tx.inboundEventReceipt.create({ data: { sourceService: "gen_resolution", sourceEventId: attempt.id, processingState: "processed", payloadHash: envelopeHash } });
  const resolutionEvent = await tx.generationJobEvent.create({ data: {
    jobId: job.id, type: "unknown_terminal_resolution_evidence_recovered", message: "Recovered provider result fixture",
    metadata: toInputJson({ attemptId: attempt.id, resolutionReceiptId: receipt.id, resolutionPayloadHash: envelopeHash,
      recoveredSuccess: { version: 1, kind: "generation.completed", requestId: terminal.requestId, generationJobId: job.id,
        attemptId: attempt.id, attemptNo: attempt.attemptNo, mode: job.mode, provider: job.provider, terminalRecordRef, terminalRecordChecksum,
        assets: [{ key: asset.storageKey, contentType: asset.contentType ?? "image/webp", providerKey: null }], usage: terminal.usage } }),
  } });
  const updatedAsset = await tx.mediaAsset.update({ where: { id: asset.id }, data: {
    metadata: toInputJson({ ...(asset.metadata as Record<string, unknown>), recoveredUnknown: true, index: 0, terminalRecordRef, terminalRecordChecksum }),
  } });
  const artifact = await tx.generationArtifact.create({ data: { attemptId: attempt.id, ordinal: 0, assetId: asset.id, providerRef: null, terminalRecordChecksum, validationState: "valid", archiveState: "active" } });
  const delivery = await tx.generationDelivery.create({ data: { requestId: job.id, artifactId: artifact.id, targetType: "user_library", targetId: job.userId, status: "delivered", deliveredAt: new Date() } });
  const commandId = `recovery-${attempt.id}`;
  const command = await tx.controlPlaneCommand.create({ data: {
    id: commandId, scope: "test", idempotencyKey: commandId, commandType: "generation.request.reconcile_unknown", targetType: "generation_request", targetId: job.id,
    actorId, requestId: commandId, requestHash: canonicalSha256({ attemptId: attempt.id }), status: "succeeded",
    result: { commandId, requestId: job.id, attemptId: attempt.id, attemptStatus: "unknown", resolution: "adopt_succeeded", requestStatus: "completed", version: job.version,
      refundAmount: 0, deliveredCount: 1, nextReviewAt: null, reconciledAt: new Date().toISOString() },
  } });
  await tx.generationJobEvent.create({ data: { jobId: job.id, type: "unknown_reconciliation_adopt_succeeded", message: "Provider success adopted",
    metadata: { attemptId: attempt.id, commandId, resolution: "adopt_succeeded" } } });
  return { attempt, asset: updatedAsset, artifact, delivery, command, receipt, resolutionEvent };
}
