import type { MediaAsset, Prisma } from "@prisma/client";
import { aiFinalizePayloadSchema, chatMediaEditProvenanceSchema } from "@idream/shared/contracts";
import { confirmedImageEditSchema, CONFIRMED_IMAGE_EDIT_VERSION } from "@idream/shared/chat/image-action";
import { checkExactGenerationDispatchAuthority } from "@/server/ai/generation-dispatch-evidence-authority";
import { MAIN_OUTBOX_GENERATION_DISPATCH_EVENT_TYPES } from "@/server/events/main-outbox-transport";
import { hasHydratableMediaBlobAuthority, isMediaAssetOperationalForAuthority, isSyntheticMediaAsset } from "@/server/lib/media-asset-authority";
import { attachmentAttempt } from "./turn-scope";

export function chatMediaDescription(metadata: Prisma.JsonValue): string | null {
  const delivery = record(record(metadata).libraryDelivery);
  return delivery.schemaVersion === 1 && typeof delivery.description === "string"
    && delivery.description.trim() ? delivery.description.trim() : null;
}

function chatMediaEditProvenance(proof: Record<string, unknown>, controls: Record<string, unknown>) {
  const pin = confirmedImageEditSchema.safeParse(controls.localizedEdit);
  if (!pin.success) return undefined;
  if (proof.version !== CONFIRMED_IMAGE_EDIT_VERSION || proof.status !== "ok"
    || proof.regionAuthority !== "user_confirmation" || proof.maskCorrectnessCertified !== false || proof.intentVerified !== false
    || proof.sourceAssetId !== controls.sourceImageAssetId || proof.target !== pin.data.target
    || proof.sourceSnapshotId !== pin.data.sourceSnapshotId || proof.sourceSha256 !== pin.data.sourceSha256
    || proof.confirmationId !== pin.data.confirmationId || proof.maskSha256 !== pin.data.maskSha256
    || proof.sampling !== (pin.data.operation.kind === "recolor" ? "hsl-lightness-preserving-1" : "source-latent-noise-mask-v1")) return undefined;
  const parsed = chatMediaEditProvenanceSchema.safeParse({ sourceMediaAssetId: proof.sourceAssetId,
    requestedTarget: proof.target, operation: proof.operation });
  return parsed.success && JSON.stringify(parsed.data.operation) === JSON.stringify(pin.data.operation) ? parsed.data : undefined;
}

/** Read accepted execution evidence, never a later delivery request or mutable Job controls. */
async function deliveredEditProvenance(db: Prisma.TransactionClient, assets: readonly MediaAsset[]) {
  const result = new Map<string, ReturnType<typeof chatMediaEditProvenanceSchema.parse>>();
  const candidates = assets.filter(asset => asset.type === "image" && asset.sourceJobId && asset.storageKey);
  if (!candidates.length) return result;
  const artifacts = await db.generationArtifact.findMany({ where: {
    assetId: { in: candidates.map(asset => asset.id) }, validationState: "valid", archiveState: "active",
  } });
  if (!artifacts.length) return result;
  const attempts = await db.generationAttempt.findMany({ where: {
    id: { in: artifacts.map(artifact => artifact.attemptId) }, status: "succeeded",
  } });
  if (!attempts.length) return result;
  const requestIds = [...new Set(attempts.map(attempt => attempt.requestId))];
  // A transaction owns one pg client; keep its evidence reads sequential.
  const jobs = await db.generationJob.findMany({
    where: { id: { in: requestIds } }, select: { id: true, userId: true, mode: true },
  });
  const outboxes = await db.mainOutboxEvent.findMany({ where: { OR: [
    { aggregateType: "generation_request", aggregateId: { in: requestIds }, eventType: { in: [...MAIN_OUTBOX_GENERATION_DISPATCH_EVENT_TYPES] } },
    { aggregateType: "generation_attempt", aggregateId: { in: attempts.map(attempt => attempt.id) }, eventType: "generation.terminal_record.accepted.v1" },
  ] } });
  for (const asset of candidates) {
    const bound = artifacts.filter(artifact => artifact.assetId === asset.id);
    if (bound.length !== 1) continue;
    const artifact = bound[0]!;
    const attempt = attempts.find(item => item.id === artifact.attemptId);
    const job = jobs.find(item => item.id === asset.sourceJobId);
    if (!attempt || !job || attempt.requestId !== job.id || job.userId !== asset.ownerId || job.mode !== "image") continue;
    const dispatches = outboxes.filter(row => row.aggregateType === "generation_request"
      && row.aggregateId === job.id && record(row.payload).attemptId === attempt.id);
    const terminals = outboxes.filter(row => row.aggregateType === "generation_attempt" && row.aggregateId === attempt.id);
    if (dispatches.length !== 1 || terminals.length !== 1) continue;
    const dispatch = checkExactGenerationDispatchAuthority({ job, attempt, dispatch: dispatches[0]! });
    const terminal = aiFinalizePayloadSchema.safeParse(terminals[0]!.payload);
    if (!dispatch.ok || !terminal.success || terminal.data.kind !== "generation.completed") continue;
    const accepted = terminal.data;
    if (accepted.generationJobId !== job.id || accepted.attemptId !== attempt.id || accepted.attemptNo !== attempt.attemptNo
      || accepted.requestId !== dispatch.authority.queuePayload.requestId || accepted.provider !== attempt.provider
      || accepted.model !== dispatch.authority.queuePayload.model || accepted.mode !== "image" || accepted.assets.length !== 1
      || accepted.terminalRecordChecksum !== artifact.terminalRecordChecksum || accepted.terminalRecordRef !== attempt.terminalRecordRef) continue;
    const output = accepted.assets[artifact.ordinal];
    // The successful attempt must have produced these exact delivered bytes.
    if (!output || output.key !== asset.storageKey || record(asset.metadata).index !== artifact.ordinal
      || (output.providerKey ?? null) !== artifact.providerRef || (output.providerKey ?? output.key) !== asset.providerAssetId) continue;
    const controls = record(dispatch.authority.queuePayload.controls);
    const sources = dispatch.authority.queuePayload.referenceImages;
    const source = Array.isArray(sources) ? sources.filter(item => record(item).role === "source_image") : [];
    const proof = record(record(output.quality).preservation);
    if (source.length !== 1 || record(source[0]).assetId !== controls.sourceImageAssetId
      || record(source[0]).sourceSnapshotId !== proof.sourceSnapshotId || record(source[0]).contentSha256 !== proof.sourceSha256) continue;
    const provenance = chatMediaEditProvenance(proof, controls);
    if (provenance) result.set(asset.id, provenance);
  }
  return result;
}

export function readableOwnedChatMediaWhere(userId: string, characterId: string): Prisma.MediaAssetWhereInput {
  return { ownerId: userId, characterId, deletedAt: null, safetyStatus: "passed", type: { in: ["image", "video"] } };
}

/** Requires a selected attachment from the owner's current conversation. */
export function readableDeliveredChatMediaWhere(userId: string, characterId: string): Prisma.MediaAssetWhereInput {
  return {
    ...readableOwnedChatMediaWhere(userId, characterId),
    // Scene assets have no Character identity pin; their delivery is the
    // conversation authority. Rebinding must use the same filter as resend.
    characterId: undefined,
    OR: [{ characterId }, { characterId: null }],
  };
}

export function isReadableChatMedia(asset: { metadata: Prisma.JsonValue; storageKey: string | null; url: string }) {
  return isMediaAssetOperationalForAuthority(asset.metadata)
    && !isSyntheticMediaAsset(asset.metadata) && hasHydratableMediaBlobAuthority(asset);
}

/** Only the selected, delivered attempt can grant a resend or enter Agent context. */
export async function deliveredChatMedia(
  db: Prisma.TransactionClient,
  input: { userId: string; characterId: string; sessionId: string; before: Date; mediaAssetId?: string; limit?: number },
) {
  const attachments = await db.chatTurnAttachment.findMany({
    where: {
      status: "completed", kind: { in: ["generated_image", "generated_video"] },
      mediaAssetId: input.mediaAssetId ?? { not: null },
      turn: { sessionId: input.sessionId, createdAt: { lt: input.before },
        session: { userId: input.userId, characterId: input.characterId } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: input.mediaAssetId ? 50 : 100,
    include: { turn: { select: { id: true, attempt: true } } },
  });
  const selected = attachments.filter(item => item.mediaAssetId && attachmentAttempt(item.metadata) === item.turn.attempt);
  const assets = selected.length ? await db.mediaAsset.findMany({
    where: {
      ...readableDeliveredChatMediaWhere(input.userId, input.characterId),
      id: { in: selected.map(item => item.mediaAssetId!) },
    },
  }) : [];
  const byId = new Map(assets.filter(isReadableChatMedia).map(asset => [asset.id, asset]));
  const seen = new Set<string>();
  const delivered = selected.flatMap(attachment => {
    const asset = byId.get(attachment.mediaAssetId!);
    if (!asset || seen.has(asset.id) || (attachment.kind === "generated_image") !== (asset.type === "image")) return [];
    seen.add(asset.id);
    return [{ attachment, asset, description: chatMediaDescription(asset.metadata) }];
  }).slice(0, input.limit ?? (input.mediaAssetId ? 1 : 100));
  const provenance = await deliveredEditProvenance(db, delivered.map(item => item.asset));
  return delivered.map(item => ({ ...item, editProvenance: provenance.get(item.asset.id) }));
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
