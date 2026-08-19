import { Prisma } from "@prisma/client";
import { Errors } from "@/server/lib/errors";
import {
  hasHydratableMediaBlobAuthority,
  isMediaAssetOperationalForAuthority,
} from "@/server/lib/media-asset-authority";
import { referenceSetSnapshotHash } from "@/server/modules/admin-v2/characters/release-snapshot";
import { invalidateCharacterDraftAssetPack } from "@/server/modules/admin-v2/characters/draft-asset-authority";
import {
  lockCharacterGenerationAuthority,
  lockCharacterMediaAssetAuthorities,
} from "@/server/modules/admin-v2/characters/generation-authority-lock";
import { jsonStringArray } from "./json-values";
import {
  assertCharacterIdentityAuthorityMutable,
  characterVisualProfileCreateData,
  type GenerationVisualProfile,
} from "./generation-character-authority";

// SPEC: 角色身份（CharacterVisualProfile）与其参考集（ReferenceSetRevision）的权威读写。
//
// INTENT: 「这次生成用哪几张参考图、按什么权重」是身份侧的问题，不是下单侧的问题。
// 用户侧下单、重试、建角色、改角色四条路径都要问同一个问题，答案必须只有一份实现。

export type ReferenceSetWithReferences = Prisma.ReferenceSetRevisionGetPayload<{
  include: { references: true };
}>;

type CharacterVisualProfileSource = {
  id: string;
  name: string;
  age: number;
  description: string;
  style: string | null;
  gender: string | null;
  appearance: Prisma.JsonValue;
  advancedDetails: Prisma.JsonValue;
  imageAssetId?: string | null;
};

export async function createActiveCharacterVisualProfileVersion(
  tx: Prisma.TransactionClient,
  character: CharacterVisualProfileSource,
  input: { createdFrom: string },
) {
  await lockCharacterGenerationAuthority(tx, character.id);
  await assertCharacterIdentityAuthorityMutable(tx, character.id);
  const active = await tx.characterVisualProfile.findFirst({
    where: { characterId: character.id, status: "active" },
    orderBy: { version: "desc" },
  });
  const activeReferenceAuthority = active
    ? await loadLockedGenerationReferenceAuthority(
        tx,
        character.id,
        active,
        "balanced",
      )
    : null;
  const inheritedReferences =
    activeReferenceAuthority?.referenceSetRevision?.references.map((reference) => ({
      mediaAssetId: reference.mediaAssetId,
      position: reference.position,
      role: reference.role,
      weight: reference.weight,
      selectionReason: reference.selectionReason,
    })) ?? [];
  const anchorAssetIds = inheritedReferences
    .filter((reference) =>
      reference.role === "primary_face" || reference.role === "identity_anchor"
    )
    .map((reference) => reference.mediaAssetId);
  if (active) {
    await tx.characterVisualProfile.updateMany({
      where: { characterId: character.id, status: "active" },
      data: { status: "archived" },
    });
  }
  const version = (active?.version ?? 0) + 1;
  const createdFrom =
    inheritedReferences.length === 0 &&
    (!active || active.createdFrom.startsWith("generation_bootstrap"))
      ? `generation_bootstrap:${input.createdFrom}`
      : input.createdFrom;
  const created = await tx.characterVisualProfile.create({
    data: characterVisualProfileCreateData({
      characterId: character.id,
      version,
      status: "active",
      style: character.style ?? "realistic",
      name: character.name,
      age: character.age,
      description: character.description,
      gender: character.gender ?? "female",
      appearance: character.appearance,
      advancedDetails: character.advancedDetails,
      anchorAssetIds,
      createdFrom,
    }),
  });
  if (inheritedReferences.length > 0) {
    await createReferenceSetRevision(
      tx,
      created,
      `visual_profile_version:${input.createdFrom}`,
      inheritedReferences,
    );
  }
  if (active) {
    await tx.characterLook.updateMany({
      where: { visualProfileId: active.id, status: "active" },
      data: { status: "needs_rebase", activeKey: null },
    });
  }
  await invalidateCharacterDraftAssetPack(tx, character.id);
  return created;
}

// SPEC: 为还没有 active Reference Set 的身份建出首个参考集。
// INTENT: 只用 anchorAssetIds（候选图池）——参考集本身的权威是 ReferenceSetRevision，
// 「没有 revision」就等于「还没有参考集」，此时唯一可信的线索就是图池里的锚点。
export function referenceSnapshotInputs(profile: GenerationVisualProfile) {
  return jsonStringArray(profile.anchorAssetIds).map((mediaAssetId, index) => ({
    mediaAssetId,
    position: index,
    role: index === 0 ? "primary_face" : "identity_anchor",
    weight: index === 0 ? 1 : 0.9,
    selectionReason: index === 0 ? "primary_identity_anchor" : "supporting_identity_angle",
  }));
}

export async function loadLockedGenerationReferenceAuthority(
  tx: Prisma.TransactionClient,
  characterId: string,
  expectedProfile: GenerationVisualProfile,
  consistencyMode: "balanced" | "strict" | "creative",
  additionalMediaAssetIds: readonly string[] = [],
) {
  await lockCharacterGenerationAuthority(tx, characterId);
  const lockedCharacter = await tx.character.findFirst({
    where: {
      id: characterId,
      deletedAt: null,
    },
    select: { id: true },
  });
  if (!lockedCharacter) {
    throw Errors.conflict(
      "Character was archived before generation authority could be pinned",
      { characterId },
    );
  }
  const activeProfile = await tx.characterVisualProfile.findFirst({
    where: { characterId, status: "active" },
    orderBy: { version: "desc" },
  });
  if (
    !activeProfile ||
    activeProfile.id !== expectedProfile.id ||
    activeProfile.version !== expectedProfile.version
  ) {
    throw Errors.conflict(
      "Character identity changed before the generation job could pin its authority",
      { characterId },
    );
  }

  // 「没有任何参考图」以 active Reference Set 为准（anchorAssetIds 是候选图池，非空只说明
  // 有候选、不代表已发布参考集）。归一后无 active revision ⟺ 无参考图。
  const bootstrapWithoutReferences =
    activeProfile.createdFrom.startsWith("generation_bootstrap") &&
    jsonStringArray(activeProfile.anchorAssetIds).length === 0 &&
    (await tx.referenceSetRevision.count({
      where: { visualProfileId: activeProfile.id, status: "active" },
    })) === 0;
  if (bootstrapWithoutReferences) {
    await lockCharacterMediaAssetAuthorities(tx, additionalMediaAssetIds);
    return {
      anchorAssetIds: [] as string[],
      referenceAssetIds: [] as string[],
      referenceManifest: [] as ReturnType<typeof referenceManifestFromRevision>,
      referenceSetRevision: null,
    };
  }

  const candidate = await tx.referenceSetRevision.findFirst({
    where: { visualProfileId: activeProfile.id, status: "active" },
    include: { references: { orderBy: { position: "asc" } } },
    orderBy: { revision: "desc" },
  });
  if (!candidate || candidate.references.length === 0) {
    throw Errors.conflict(
      "Character generation requires a complete active Reference Set",
      {
        characterId,
        visualProfileId: activeProfile.id,
      },
    );
  }
  await lockCharacterMediaAssetAuthorities(
    tx,
    [
      ...candidate.references.map((reference) => reference.mediaAssetId),
      ...additionalMediaAssetIds,
    ],
  );
  const referenceSetRevision = await tx.referenceSetRevision.findFirst({
    where: {
      visualProfileId: activeProfile.id,
      status: "active",
    },
    include: {
      references: {
        include: { mediaAsset: true },
        orderBy: { position: "asc" },
      },
    },
    orderBy: { revision: "desc" },
  });
  if (!referenceSetRevision || referenceSetRevision.id !== candidate.id) {
    throw Errors.conflict(
      "Character Reference Set changed before generation authority was pinned",
      { characterId, referenceSetRevisionId: candidate.id },
    );
  }
  const referenceAssetIds = referenceSetRevision.references.map(
    (reference) => reference.mediaAssetId,
  );
  if (
    new Set(referenceAssetIds).size !== referenceAssetIds.length ||
    referenceSetRevision.references.some(
      (reference, index) =>
        reference.position !== index ||
        reference.mediaAsset.deletedAt !== null ||
        reference.mediaAsset.type !== "image" ||
        reference.mediaAsset.safetyStatus !== "passed" ||
        !isMediaAssetOperationalForAuthority(reference.mediaAsset.metadata) ||
        !hasHydratableMediaBlobAuthority(reference.mediaAsset) ||
        reference.mediaAsset.characterId !== characterId,
    )
  ) {
    throw Errors.conflict(
      "Every Character reference must be unique, ordered, available, safety-passed, and owned by the exact Character",
      {
        characterId,
        referenceSetRevisionId: referenceSetRevision.id,
      },
    );
  }
  const computedSnapshotHash = referenceSetSnapshotHash(referenceSetRevision);
  if (
    !referenceSetRevision.snapshotHash ||
    referenceSetRevision.snapshotHash !== computedSnapshotHash
  ) {
    throw Errors.conflict(
      "Character Reference Set snapshot is not sealed to its current references",
      {
        characterId,
        referenceSetRevisionId: referenceSetRevision.id,
      },
    );
  }
  const referenceManifest = referenceManifestFromRevision(
    referenceSetRevision,
    consistencyMode,
  );
  return {
    anchorAssetIds: referenceSetRevision.references
      .filter((reference) =>
        reference.role === "primary_face" || reference.role === "identity_anchor"
      )
      .map((reference) => reference.mediaAssetId),
    referenceAssetIds,
    referenceManifest,
    referenceSetRevision,
  };
}

export async function createReferenceSetRevision(
  tx: Prisma.TransactionClient,
  profile: GenerationVisualProfile,
  createdFrom: string,
  references = referenceSnapshotInputs(profile),
) {
  const proposedReferences = references;
  const existingAssets = await tx.mediaAsset.findMany({
    where: {
      id: { in: proposedReferences.map((reference) => reference.mediaAssetId) },
      deletedAt: null,
      type: "image",
      safetyStatus: "passed",
      characterId: profile.characterId,
    },
    select: { id: true, storageKey: true, url: true, metadata: true },
  });
  const existingAssetIds = new Set(existingAssets.map((asset) => asset.id));
  if (
    existingAssetIds.size !== proposedReferences.length ||
    proposedReferences.some((reference) => !existingAssetIds.has(reference.mediaAssetId)) ||
    existingAssets.some((asset) =>
      !isMediaAssetOperationalForAuthority(asset.metadata) ||
      !hasHydratableMediaBlobAuthority(asset)
    )
  ) {
    throw Errors.conflict(
      "Every Character reference must be available, safety-passed, and owned by the exact Character",
      { characterId: profile.characterId },
    );
  }
  const availableReferences = proposedReferences;
  const latest = await tx.referenceSetRevision.aggregate({
    where: { visualProfileId: profile.id },
    _max: { revision: true },
  });
  await tx.referenceSetRevision.updateMany({
    where: { visualProfileId: profile.id, status: "active" },
    data: { status: "superseded" },
  });
  return tx.referenceSetRevision.create({
    data: {
      visualProfileId: profile.id,
      revision: (latest._max.revision ?? 0) + 1,
      status: "active",
      selectorVersion: "v1",
      createdFrom,
      snapshotHash: referenceSetSnapshotHash({
        visualProfileId: profile.id,
        revision: (latest._max.revision ?? 0) + 1,
        selectorVersion: "v1",
        references: availableReferences,
      }),
      references: {
        create: availableReferences.map((reference) => ({
            ...reference,
            selectorVersion: "v1",
          })),
      },
    },
    include: { references: { orderBy: { position: "asc" } } },
  });
}

export function referenceManifestFromRevision(
  revision: ReferenceSetWithReferences,
  consistencyMode?: "balanced" | "strict" | "creative",
) {
  return revision.references.map((reference) => ({
    mediaAssetId: reference.mediaAssetId,
    role: reference.role,
    weight: resolvedReferenceWeight(reference.role, reference.weight, consistencyMode),
    crop: reference.crop,
    qualityScore: reference.qualityScore,
    identityScore: reference.identityScore,
    selectorVersion: reference.selectorVersion,
    selectionReason: reference.selectionReason,
  }));
}

function resolvedReferenceWeight(
  role: string,
  baseWeight: number,
  mode?: "balanced" | "strict" | "creative",
) {
  if (!mode || mode === "balanced") return baseWeight;
  const anchor = role === "primary_face" || role === "identity_anchor";
  if (mode === "strict") return anchor ? 1.25 : 0.95;
  return anchor ? 0.65 : 0.45;
}
