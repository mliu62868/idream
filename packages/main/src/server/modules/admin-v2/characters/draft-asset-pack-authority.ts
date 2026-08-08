import type {
  GenerationRouteQualification,
  Prisma,
} from "@prisma/client";
import {
  assignWorkflowReferenceSlots,
  type WorkflowDescriptor,
  type WorkflowReferenceRole,
} from "@idream/shared/gen-workflow";
import { isMediaAssetOperationalForAuthority } from "@/server/lib/media-asset-authority";
import { canonicalSha256 } from "../shared/canonical-json";
import { characterIdentityReviewEvidencePassed } from "../shared/creative-review-quality";
import { generationWorkflowDescriptor } from "@/server/modules/generation/generation-catalog";
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

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
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
 * Revalidates the mutable facts behind the Project's immutable draft-pack
 * pointers immediately before QA. Selection-time approval is not sufficient:
 * media availability, review authority, and generation lineage can all drift.
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
  const itemIds = selectedEntries.flatMap(({ entry }) =>
    entry.itemId ? [entry.itemId] : []
  );
  const generationJobIds = selectedEntries.flatMap(({ entry }) =>
    entry.generationJobId ? [entry.generationJobId] : []
  );
  const assets = await tx.mediaAsset.findMany({
    where: { id: { in: assetIds } },
  });
  const items = await tx.contentProductionItem.findMany({
    where: { id: { in: itemIds } },
    include: { batch: true, job: true },
  });
  const decisions = await tx.creativeReviewDecision.findMany({
    where: { runItemId: { in: itemIds } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const attempts = await tx.generationAttempt.findMany({
    where: {
      requestId: { in: generationJobIds },
      status: "succeeded",
    },
    orderBy: [
      { requestId: "asc" },
      { attemptNo: "desc" },
      { id: "desc" },
    ],
  });
  const workflow = await generationWorkflowDescriptor(
    input.currentRoute.workflowKey,
  );
  const generationProfile = await tx.generationModelProfile.findFirst({
    where: {
      profileKey: input.currentRoute.generationProfileKey,
      version: input.currentRoute.generationProfileVersion,
      status: "active",
    },
  });
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const itemById = new Map(items.map((item) => [item.id, item]));
  const latestDecisionByItemId = new Map<string, (typeof decisions)[number]>();
  for (const decision of decisions) {
    if (!latestDecisionByItemId.has(decision.runItemId)) {
      latestDecisionByItemId.set(decision.runItemId, decision);
    }
  }
  const latestAttemptByJobId = new Map<string, (typeof attempts)[number]>();
  for (const attempt of attempts) {
    if (!latestAttemptByJobId.has(attempt.requestId)) {
      latestAttemptByJobId.set(attempt.requestId, attempt);
    }
  }
  const canonicalReferenceAssetIds = input.referenceSet.references
    .map((reference) => reference.mediaAssetId);
  const authorityLockedAssetIdSet = new Set(input.authorityLockedAssetIds);
  const sourceManifestEntries = items.flatMap((item) =>
    manifestEntries(item.job?.referenceManifest)
      .filter((entry) => entry.role === "source_image")
  );
  const sourceAssetIds = sourceManifestEntries.flatMap((entry) =>
    typeof entry.mediaAssetId === "string" ? [entry.mediaAssetId] : []
  );
  const sourceAssets = await tx.mediaAsset.findMany({
    where: { id: { in: [...new Set(sourceAssetIds)] } },
    include: { sourceJob: true },
  });
  const sourceAssetById = new Map(
    sourceAssets.map((asset) => [asset.id, asset]),
  );
  const sourceItemIds = sourceAssets.flatMap((asset) =>
    asset.sourceJob?.sourceType === "content_production_item" &&
      typeof asset.sourceJob.sourceId === "string"
      ? [asset.sourceJob.sourceId]
      : []
  );
  const sourceDecisions = await tx.creativeReviewDecision.findMany({
    where: { runItemId: { in: sourceItemIds } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const latestSourceDecisionByItemId = new Map<
    string,
    (typeof sourceDecisions)[number]
  >();
  for (const decision of sourceDecisions) {
    if (!latestSourceDecisionByItemId.has(decision.runItemId)) {
      latestSourceDecisionByItemId.set(decision.runItemId, decision);
    }
  }
  const profileCapabilities = record(
    record(generationProfile?.runnerConfig).capabilities,
  );

  const invalidAssetPurposes = selectedEntries.flatMap(({ purpose, entry }) => {
    const asset = assetById.get(entry.assetId);
    return !asset ||
      asset.deletedAt !== null ||
      asset.type !== "image" ||
      asset.safetyStatus !== "passed" ||
      !isMediaAssetOperationalForAuthority(asset.metadata) ||
      asset.characterId !== input.characterId
      ? [purpose]
      : [];
  });
  const invalidLineagePurposes = selectedEntries.flatMap(({ purpose, entry }) => {
    if (
      !entry.runId ||
      !entry.itemId ||
      !entry.reviewDecisionId ||
      !entry.generationJobId
    ) {
      return [purpose];
    }
    const asset = assetById.get(entry.assetId);
    const item = itemById.get(entry.itemId);
    const job = item?.job ?? null;
    const latestDecision = latestDecisionByItemId.get(entry.itemId);
    const latestAttempt = latestAttemptByJobId.get(entry.generationJobId);
    const sourceMeta = record(job?.sourceMeta);
    const pinnedReferenceAssetIds = strings(job?.referenceAssetIds);
    const pinnedManifestEntries = manifestEntries(job?.referenceManifest);
    const partitionedManifest = partitionedReferenceManifestAuthority({
      pinnedReferenceAssetIds,
      manifestEntries: pinnedManifestEntries,
      canonicalReferenceAssetIds,
      referenceSetRevisionId: input.referenceSet.id,
      referenceSetSnapshotHash: input.referenceSet.snapshotHash,
    });
    const sourceAuthorityMatches = partitionedManifest.sourceEntries.every(
      (manifestEntry) => {
        const sourceAssetId =
          typeof manifestEntry.mediaAssetId === "string"
            ? manifestEntry.mediaAssetId
            : null;
        const sourceAsset = sourceAssetId
          ? sourceAssetById.get(sourceAssetId)
          : null;
        const sourceJob = sourceAsset?.sourceJob ?? null;
        const sourceDecision =
          sourceJob?.sourceType === "content_production_item" &&
            typeof sourceJob.sourceId === "string"
            ? latestSourceDecisionByItemId.get(sourceJob.sourceId)
            : null;
        return Boolean(
          sourceAssetId &&
          authorityLockedAssetIdSet.has(sourceAssetId) &&
          sourceAsset &&
          sourceAsset.deletedAt === null &&
          sourceAsset.type === "image" &&
          sourceAsset.safetyStatus === "passed" &&
          isMediaAssetOperationalForAuthority(sourceAsset.metadata) &&
          sourceAsset.characterId === input.characterId &&
          sourceJob &&
          manifestEntry.sourceJobId === sourceJob.id &&
          sourceJob.status === "completed" &&
          sourceJob.mode === "image" &&
          sourceJob.deliveredOutputCount > 0 &&
          sourceJob.characterId === input.characterId &&
          sourceJob.visualProfileId === input.visualProfile.id &&
          sourceJob.visualProfileVersion === input.visualProfile.version &&
          sourceJob.referenceSetRevisionId === input.referenceSet.id &&
          sourceJob.sourceType === "content_production_item" &&
          sourceDecision &&
          sourceDecision.artifactId === sourceAsset.id &&
          characterIdentityReviewEvidencePassed({
            bootstrapIdentity: false,
            decision: sourceDecision.decision,
            identityConsistency: sourceDecision.identityConsistency,
            score: sourceDecision.score,
            evidence: sourceDecision.evidence,
          })
        );
      },
    );
    const sourceRuntimeMatches = draftAssetSourceRuntimeAuthority({
      sourceReferenceCount: partitionedManifest.sourceEntries.length,
      pinnedReferenceCount: pinnedManifestEntries.length,
      canonicalReferenceRoles: partitionedManifest.canonicalEntries.flatMap(
        (entry) => typeof entry.role === "string" ? [entry.role] : [],
      ),
      workflow,
      profileSupportsReferenceImages:
        profileCapabilities.referenceImages === true,
      profileSupportsInitImage: profileCapabilities.initImage === true,
    });
    const bootstrapAuthorityMatches =
      entry.bootstrapIdentity &&
      purpose === "character_cover" &&
      sourceMeta.bootstrapIdentity === true &&
      job?.visualProfileId === null &&
      job.referenceSetRevisionId === null &&
      strings(job.referenceAssetIds).length === 0 &&
      manifestEntries(job.referenceManifest).length === 0 &&
      input.visualProfile.createdFrom ===
        `identity_bootstrap:${entry.generationJobId}` &&
      input.referenceSet.createdFrom ===
        `identity_bootstrap:${entry.generationJobId}` &&
      input.visualProfile.evidenceState === "reviewed_bootstrap" &&
      record(input.visualProfile.adapterRefs).bootstrapIdentity === true &&
      record(input.visualProfile.adapterRefs).generationJobId ===
        entry.generationJobId &&
      input.referenceSet.references.some((reference) =>
        reference.mediaAssetId === entry.assetId
      );
    const qualifiedIdentityRouteMatches =
      !entry.bootstrapIdentity &&
      sourceMeta.bootstrapIdentity !== true &&
      job?.visualProfileId === input.visualProfile.id &&
      job.visualProfileVersion === input.visualProfile.version &&
      job.referenceSetRevisionId === input.referenceSet.id &&
      partitionedManifest.matches &&
      sourceAuthorityMatches &&
      sourceRuntimeMatches &&
      sourceMeta.referenceSetRevisionId === input.referenceSet.id &&
      sourceMeta.generationRouteQualificationId === input.currentRoute.id &&
      sourceMeta.generationRouteFingerprint ===
        input.currentRoute.routeFingerprint &&
      entry.generationRouteFingerprint === input.currentRoute.routeFingerprint &&
      job.profileId === input.currentRoute.generationProfileKey &&
      job.profileVersion === input.currentRoute.generationProfileVersion &&
      job.model === input.currentRoute.workflowKey &&
      latestAttempt?.profileKey === input.currentRoute.generationProfileKey &&
      latestAttempt.profileVersion ===
        input.currentRoute.generationProfileVersion &&
      latestAttempt.workflowKey === input.currentRoute.workflowKey &&
      latestAttempt.workflowVersion === input.currentRoute.workflowVersion;

    return !asset ||
      !authorityLockedAssetIdSet.has(entry.assetId) ||
      canonicalReferenceAssetIds.some(
        (referenceAssetId) =>
          !authorityLockedAssetIdSet.has(referenceAssetId),
      ) ||
      !item ||
      item.batchId !== entry.runId ||
      item.jobId !== entry.generationJobId ||
      item.mediaAssetId !== entry.assetId ||
      item.batch.targetType !== "character" ||
      item.batch.targetId !== input.characterId ||
      item.batch.purpose !== purpose ||
      !["approved", "published"].includes(item.status) ||
      !job ||
      job.id !== entry.generationJobId ||
      job.status !== "completed" ||
      job.mode !== "image" ||
      job.deliveredOutputCount < 1 ||
      job.characterId !== input.characterId ||
      job.sourceType !== "content_production_item" ||
      job.sourceId !== item.id ||
      sourceMeta.batchId !== item.batchId ||
      sourceMeta.purpose !== purpose ||
      sourceMeta.targetType !== "character" ||
      sourceMeta.targetId !== input.characterId ||
      sourceMeta.bootstrapIdentity !== entry.bootstrapIdentity ||
      asset.sourceJobId !== job.id ||
      !job.profileId ||
      !job.profileVersion ||
      !job.model ||
      !job.provider ||
      !latestAttempt ||
      latestAttempt.provider !== job.provider ||
      latestAttempt.profileKey !== job.profileId ||
      latestAttempt.profileVersion !== job.profileVersion ||
      latestAttempt.workflowKey !== job.model ||
      !latestDecision ||
      latestDecision.id !== entry.reviewDecisionId ||
      latestDecision.artifactId !== entry.assetId ||
      !characterIdentityReviewEvidencePassed({
        bootstrapIdentity: entry.bootstrapIdentity,
        decision: latestDecision.decision,
        identityConsistency: latestDecision.identityConsistency,
        score: latestDecision.score,
        evidence: latestDecision.evidence,
      }) ||
      (!bootstrapAuthorityMatches && !qualifiedIdentityRouteMatches)
      ? [purpose]
      : [];
  });

  return {
    invalidAssetPurposes,
    invalidLineagePurposes,
    ready:
      selectedEntries.length === characterDraftAssetPurposes.length &&
      invalidAssetPurposes.length === 0 &&
      invalidLineagePurposes.length === 0,
  };
}
