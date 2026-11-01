import type { Prisma } from "@prisma/client";
import { hasHydratableMediaBlobAuthority, isMediaAssetOperationalForAuthority, isSyntheticMediaAsset } from "@/server/lib/media-asset-authority";
import { attachmentAttempt } from "./turn-scope";

export function chatMediaDescription(metadata: Prisma.JsonValue): string | null {
  const delivery = record(record(metadata).libraryDelivery);
  return delivery.schemaVersion === 1 && typeof delivery.description === "string"
    && delivery.description.trim() ? delivery.description.trim() : null;
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
  input: { userId: string; characterId: string; sessionId: string; before: Date; mediaAssetId?: string },
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
  return selected.flatMap(attachment => {
    const asset = byId.get(attachment.mediaAssetId!);
    if (!asset || seen.has(asset.id) || (attachment.kind === "generated_image") !== (asset.type === "image")) return [];
    seen.add(asset.id);
    return [{ attachment, asset, description: chatMediaDescription(asset.metadata) }];
  });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
