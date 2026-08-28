import type {
  GenerationRouteQualification,
  Prisma,
} from "@prisma/client";
import {
  assignWorkflowReferenceSlots,
  type WorkflowDescriptor,
  type WorkflowReferenceRole,
} from "@idream/shared/gen-workflow";
import {
  hasHydratableMediaBlobAuthority,
  isMediaAssetOperationalForAuthority,
} from "@/server/lib/media-asset-authority";
import { canonicalSha256 } from "../shared/canonical-json";
import {
  characterDraftAssetPurposes,
  draftAssetRouteEntries,
} from "./draft-asset-route-authority";
import { normalizedGenerationReferenceRole } from "./generation-route-authority";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function manifestEntries(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}

type DraftAssetPackAuthorityStore = Pick<
  Prisma.TransactionClient,
  | "contentProductionItem"
  | "creativeReviewDecision"
  | "generationAttempt"
  | "generationModelProfile"
  | "mediaAsset"
>;

type DraftAssetPackVisualAuthority = {
  readonly id: string;
  readonly version: number;
  readonly createdFrom: string;
  readonly evidenceState: string;
  readonly adapterRefs: Prisma.JsonValue;
};

type DraftAssetPackReferenceAuthority = {
  readonly id: string;
  readonly snapshotHash: string | null;
  readonly createdFrom: string;
  readonly references: readonly {
    readonly mediaAssetId: string;
  }[];
};

export async function discoverDraftAssetPackSourceAssetIds(
  tx: Pick<DraftAssetPackAuthorityStore, "contentProductionItem">,
  draftAssetPack: Prisma.JsonValue,
) {
  const itemIds = Object.values(draftAssetRouteEntries(draftAssetPack))
    .flatMap((entry) => entry.itemId ? [entry.itemId] : []);
  if (itemIds.length === 0) return [];
  const items = await tx.contentProductionItem.findMany({
    where: { id: { in: itemIds } },
    select: {
      job: {
        select: { referenceManifest: true },
      },
    },
  });
  return [...new Set(items.flatMap((item) =>
    manifestEntries(item.job?.referenceManifest)
      .filter((entry) => entry.role === "source_image")
      .flatMap((entry) =>
        typeof entry.mediaAssetId === "string" ? [entry.mediaAssetId] : []
      )
  ))].sort();
}

export function partitionedReferenceManifestAuthority(input: {
  readonly pinnedReferenceAssetIds: readonly string[];
  readonly manifestEntries: readonly Record<string, unknown>[];
  readonly canonicalReferenceAssetIds: readonly string[];
  readonly referenceSetRevisionId: string;
  readonly referenceSetSnapshotHash: string | null;
}) {
  const manifestAssetIds = input.manifestEntries.flatMap((entry) =>
    typeof entry.mediaAssetId === "string" ? [entry.mediaAssetId] : []
  );
  const canonicalEntries = input.manifestEntries.filter(
    (entry) => entry.role !== "source_image",
  );
  const sourceEntries = input.manifestEntries.filter(
    (entry) => entry.role === "source_image",
  );
  const canonicalManifestAssetIds = canonicalEntries.flatMap((entry) =>
    typeof entry.mediaAssetId === "string" ? [entry.mediaAssetId] : []
  );
  return {
    canonicalEntries,
    sourceEntries,
    matches:
      input.pinnedReferenceAssetIds.length > 0 &&
      input.manifestEntries.length > 0 &&
      canonicalSha256([...input.pinnedReferenceAssetIds].sort()) ===
        canonicalSha256([...manifestAssetIds].sort()) &&
      canonicalSha256([...canonicalManifestAssetIds].sort()) ===
        canonicalSha256([...input.canonicalReferenceAssetIds].sort()) &&
      canonicalEntries.every((entry) =>
        entry.referenceSetRevisionId === input.referenceSetRevisionId &&
        entry.snapshotHash === input.referenceSetSnapshotHash
      ) &&
      sourceEntries.every((entry) =>
        typeof entry.sourceJobId === "string" &&
        entry.referenceSetRevisionId === input.referenceSetRevisionId &&
        entry.snapshotHash === input.referenceSetSnapshotHash
      ),
  };
}

export function draftAssetSourceRuntimeAuthority(input: {
  readonly sourceReferenceCount: number;
  readonly pinnedReferenceCount: number;
  readonly canonicalReferenceRoles?: readonly string[];
  readonly workflow: WorkflowDescriptor | null;
  readonly profileSupportsReferenceImages: boolean;
  readonly profileSupportsInitImage: boolean;
}) {
  if (!input.workflow) return false;
  const fallbackCanonicalRole: WorkflowReferenceRole =
    input.workflow.identity.acceptedRoles.find(
      (role): role is Exclude<WorkflowReferenceRole, "source_image"> =>
        role !== "source_image",
    ) ?? "identity_anchor";
  const rawCanonicalReferenceRoles =
    input.canonicalReferenceRoles ?? Array.from(
    {
      length: Math.max(
        0,
        input.pinnedReferenceCount - input.sourceReferenceCount,
      ),
    },
    () => fallbackCanonicalRole,
  );
  const canonicalReferenceRoles = rawCanonicalReferenceRoles.map(
    normalizedGenerationReferenceRole,
  );
  if (
    canonicalReferenceRoles.some((role) => role === null) ||
    canonicalReferenceRoles.length + input.sourceReferenceCount !==
      input.pinnedReferenceCount ||
    (
      canonicalReferenceRoles.length > 0 &&
      !input.profileSupportsReferenceImages
    ) ||
    (input.sourceReferenceCount > 0 && !input.profileSupportsInitImage) ||
    (
      canonicalReferenceRoles.length > 0 &&
      input.sourceReferenceCount > 0 &&
      !input.workflow.identity.supportsSourceImageWithIdentity
    )
  ) {
    return false;
  }
  const requestedRoles = [
    ...canonicalReferenceRoles.filter(
      (role): role is WorkflowReferenceRole => role !== null,
    ),
    ...Array.from(
      { length: input.sourceReferenceCount },
      () => "source_image" as const,
    ),
  ];
  return assignWorkflowReferenceSlots(
    input.workflow,
    requestedRoles,
  ).ok;
}

/**
 * SPEC: 发布草稿只要求三个运营位各自指向本角色素材库中的可用图片。
 * INTENT: 生成、导入、外部制作只是素材进入图库的方式；人工评分和生成血缘不能成为
 *         运营选择 Cover / Hero / Chat 的资格门槛。Release 仍会冻结最终素材快照。
 */
export async function evaluateDraftAssetPackAuthority(
  tx: DraftAssetPackAuthorityStore,
  input: {
    readonly characterId: string;
    readonly draftAssetPack: Prisma.JsonValue;
    readonly visualProfile: DraftAssetPackVisualAuthority;
    readonly referenceSet: DraftAssetPackReferenceAuthority;
    readonly currentRoute: GenerationRouteQualification;
    readonly authorityLockedAssetIds: readonly string[];
  },
) {
  const entries = draftAssetRouteEntries(input.draftAssetPack);
  const selectedEntries = characterDraftAssetPurposes.flatMap((purpose) => {
    const entry = entries[purpose];
    return entry ? [{ purpose, entry }] : [];
  });
  const assetIds = [...new Set(selectedEntries.map(({ entry }) => entry.assetId))];
  const assets = await tx.mediaAsset.findMany({
    where: { id: { in: assetIds } },
  });
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const authorityLockedAssetIdSet = new Set(input.authorityLockedAssetIds);

  const invalidAssetPurposes = selectedEntries.flatMap(({ purpose, entry }) => {
    const asset = assetById.get(entry.assetId);
    return !asset ||
      asset.deletedAt !== null ||
      asset.type !== "image" ||
      asset.safetyStatus !== "passed" ||
      !isMediaAssetOperationalForAuthority(asset.metadata) ||
      !hasHydratableMediaBlobAuthority(asset) ||
      record(record(asset.metadata).platformAsset).status === "archived" ||
      asset.characterId !== input.characterId
      ? [purpose]
      : [];
  });
  const invalidLineagePurposes = selectedEntries.flatMap(
    ({ purpose, entry }) =>
      authorityLockedAssetIdSet.has(entry.assetId) ? [] : [purpose],
  );
  const distinctAssets = assetIds.length === selectedEntries.length;

  return {
    invalidAssetPurposes,
    invalidLineagePurposes,
    ready:
      selectedEntries.length === characterDraftAssetPurposes.length &&
      distinctAssets &&
      invalidAssetPurposes.length === 0 &&
      invalidLineagePurposes.length === 0,
  };
}
