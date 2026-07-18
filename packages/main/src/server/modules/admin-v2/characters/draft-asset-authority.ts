import type { Prisma } from "@prisma/client";
import { Errors } from "@/server/lib/errors";

const CHARACTER_ASSET_PURPOSES = [
  "character_cover",
  "character_hero",
  "character_chat",
] as const;

type CharacterAssetPurpose = (typeof CHARACTER_ASSET_PURPOSES)[number];

type DraftAssetAuthorityInvalidation = {
  readonly projectId: string;
  readonly previousVersion: number;
  readonly nextVersion: number;
  readonly invalidatedPurposes: readonly CharacterAssetPurpose[];
  readonly invalidatedAssetIds: readonly string[];
};

function record(value: Prisma.JsonValue): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function assetId(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = (value as Record<string, unknown>).assetId;
  return typeof candidate === "string" && candidate.trim() ? candidate : null;
}

/**
 * A draft Character asset is only valid for the Visual Identity and Reference
 * Set that its Generation Job pinned. Any mutation of either authority makes
 * the whole pack stale, so remove the current pointers in the same transaction
 * that changes authority. Generation and review history remain append-only.
 */
export async function invalidateCharacterDraftAssetPack(
  tx: Prisma.TransactionClient,
  characterId: string,
): Promise<DraftAssetAuthorityInvalidation | null> {
  const project = await tx.characterProject.findFirst({
    where: { characterId },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      version: true,
      draftImageAssetId: true,
      draftAssetPack: true,
    },
  });
  if (!project) return null;

  const pack = record(project.draftAssetPack);
  const invalidatedPurposes = CHARACTER_ASSET_PURPOSES.filter((purpose) =>
    assetId(pack[purpose]) !== null
  );
  const invalidatedAssetIds = [
    ...new Set([
      ...invalidatedPurposes.flatMap((purpose) => {
        const id = assetId(pack[purpose]);
        return id ? [id] : [];
      }),
      ...(project.draftImageAssetId ? [project.draftImageAssetId] : []),
    ]),
  ];
  if (invalidatedAssetIds.length === 0 && Object.keys(pack).length === 0) return null;

  const changed = await tx.characterProject.updateMany({
    where: { id: project.id, version: project.version },
    data: {
      draftImageAssetId: null,
      draftAssetPack: {},
      version: { increment: 1 },
    },
  });
  if (changed.count !== 1) {
    throw Errors.conflict("Character Project changed while stale draft assets were being invalidated", {
      characterId,
      projectId: project.id,
      expectedVersion: project.version,
    });
  }
  return {
    projectId: project.id,
    previousVersion: project.version,
    nextVersion: project.version + 1,
    invalidatedPurposes,
    invalidatedAssetIds,
  };
}
