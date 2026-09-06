import type { GenerationAttempt, Prisma, PrismaClient } from "@prisma/client";
import { unknownGenerationReconciliationResultSchema } from "@idream/shared/admin";
import { validatedUnknownSuccessResolution } from "@/server/ai/generation-unknown-resolution-evidence";

type Db = PrismaClient | Prisma.TransactionClient;
type Asset = { readonly id: string; readonly sourceJobId: string | null; readonly storageKey?: string | null; readonly metadata: unknown };
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

// A reconciled Request can succeed while its original Attempt remains unknown.
// Accept only the exact delivered Artifact authorized by the completed adoption
// command and the same validated terminal Receipt used by reconciliation itself.
export async function resolveGenerationAssetSuccessAttempts(db: Db, assets: readonly Asset[]) {
  const requestIds = [...new Set(assets.flatMap((asset) => asset.sourceJobId ? [asset.sourceJobId] : []))];
  const result = new Map<string, GenerationAttempt>();
  if (requestIds.length === 0) return result;
  const attempts = await db.generationAttempt.findMany({
    where: { requestId: { in: requestIds }, status: { in: ["succeeded", "unknown"] } },
    orderBy: [{ requestId: "asc" }, { attemptNo: "desc" }],
  });
  const successful = new Map<string, GenerationAttempt>();
  for (const attempt of attempts) if (attempt.status === "succeeded" && !successful.has(attempt.requestId)) successful.set(attempt.requestId, attempt);
  const unknownAttempts = attempts.filter((attempt) => attempt.status === "unknown");
  const recoveryByAttempt = new Map<string, Awaited<ReturnType<typeof adoptedResolution>>>();
  const artifacts = unknownAttempts.length > 0 ? await db.generationArtifact.findMany({
    where: { assetId: { in: assets.map((asset) => asset.id) }, attemptId: { in: unknownAttempts.map((attempt) => attempt.id) } },
  }) : [];
  const boundAttemptIds = new Set(artifacts.map((artifact) => artifact.attemptId));
  for (const attempt of unknownAttempts.filter((attempt) => boundAttemptIds.has(attempt.id))) {
    recoveryByAttempt.set(attempt.id, await adoptedResolution(db, attempt));
  }
  const deliveries = artifacts.length > 0 ? await db.generationDelivery.findMany({ where: {
    artifactId: { in: artifacts.map((artifact) => artifact.id) }, status: "delivered", deliveredAt: { not: null }, targetType: "user_library",
  } }) : [];
  for (const asset of assets) {
    if (!asset.sourceJobId) continue;
    const metadata = record(asset.metadata);
    const boundArtifacts = artifacts.filter((artifact) => artifact.assetId === asset.id);
    if (metadata.recoveredUnknown !== true && boundArtifacts.length === 0) {
      const attempt = successful.get(asset.sourceJobId);
      if (attempt) result.set(asset.id, attempt);
      continue;
    }
    // Recovered metadata must never borrow a different successful Attempt.
    if (metadata.recoveredUnknown !== true || boundArtifacts.length !== 1) continue;
    const artifact = boundArtifacts[0]!;
    if (artifact.validationState !== "valid" || artifact.archiveState !== "active") continue;
    const attempt = unknownAttempts.find((candidate) => candidate.id === artifact.attemptId && candidate.requestId === asset.sourceJobId);
    const recovery = attempt ? recoveryByAttempt.get(attempt.id) : null;
    const terminalAsset = recovery?.payload.assets[artifact.ordinal];
    if (!attempt || !recovery || !terminalAsset || artifact.ordinal !== metadata.index ||
      artifact.terminalRecordChecksum !== recovery.payload.terminalRecordChecksum ||
      metadata.terminalRecordChecksum !== recovery.payload.terminalRecordChecksum ||
      metadata.terminalRecordRef !== recovery.payload.terminalRecordRef ||
      asset.storageKey !== terminalAsset.key ||
      artifact.providerRef !== record(terminalAsset).providerKey) continue;
    const delivery = deliveries.find((candidate) => candidate.artifactId === artifact.id && candidate.targetId === recovery.userId);
    if (delivery?.requestId !== asset.sourceJobId) continue;
    result.set(asset.id, attempt);
  }
  return result;
}

async function adoptedResolution(db: Db, attempt: GenerationAttempt) {
  const job = await db.generationJob.findUnique({ where: { id: attempt.requestId }, select: { status: true, deliveredOutputCount: true, userId: true, provider: true } });
  if (job?.status !== "completed" || job.deliveredOutputCount < 1) return null;
  const evidence = await validatedUnknownSuccessResolution(db, attempt.id);
  if (!evidence || evidence.payload.attemptNo !== attempt.attemptNo || evidence.payload.provider !== attempt.provider || job.provider !== attempt.provider) return null;
  const event = await db.generationJobEvent.findFirst({ where: {
    jobId: attempt.requestId, type: "unknown_reconciliation_adopt_succeeded", metadata: { path: ["attemptId"], equals: attempt.id },
  }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  const metadata = record(event?.metadata);
  if (metadata.resolution !== "adopt_succeeded" || typeof metadata.commandId !== "string") return null;
  const command = await db.controlPlaneCommand.findUnique({ where: { id: metadata.commandId } });
  const outcome = unknownGenerationReconciliationResultSchema.safeParse(command?.result);
  if (command?.status !== "succeeded" || command.commandType !== "generation.request.reconcile_unknown" || command.targetType !== "generation_request" || command.targetId !== attempt.requestId ||
    !outcome.success || outcome.data.resolution !== "adopt_succeeded" || outcome.data.requestId !== attempt.requestId || outcome.data.attemptId !== attempt.id || outcome.data.commandId !== command.id || outcome.data.deliveredCount !== job.deliveredOutputCount) return null;
  return { ...evidence, userId: job.userId };
}
