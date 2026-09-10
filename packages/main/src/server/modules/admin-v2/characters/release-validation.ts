import { resolveGenerationAssetSuccessAttempts } from "@/server/ai/generation-asset-success-authority";
import type { Prisma } from "@prisma/client";
import { parseCharacterReleaseAssetManifest } from "@idream/shared/admin";
import {
  companionProductContractCanary,
  COMPANION_PRODUCT_PROMPT_VERSION,
  loadCharacterSoulSnapshot,
} from "@idream/shared";
import { env } from "@/server/lib/env";
import {
  evaluateMediaAssetCustomerPublishability,
  hasHydratableMediaBlobAuthority,
  inspectOperatorUploadAuthority,
} from "@/server/lib/media-asset-authority";
import { canonicalSha256 } from "../shared/canonical-json";
import { toInputJson } from "../shared/prisma-json";
import { CHARACTER_RELEASE_POLICY_VERSION } from "./character-release-contract";
import { characterDraftAssetPurposes } from "./draft-asset-route-authority";
import {
  evaluateEffectiveGenerationRouteAuthority,
  isOperatorSingleImageRoute,
} from "./generation-route-authority";
import {
  lockCharacterGenerationAuthority,
  lockCharacterMediaAssetAuthorities,
} from "./generation-authority-lock";
import {
  characterReleaseSnapshotHash,
  characterVisualProfileSnapshotHash,
  referenceSetSnapshotHash,
} from "./release-snapshot";
import {
  hasCanonicalRequiredReleaseRoute,
  releaseAvatarAssetId,
  releasePlacements,
  releaseRecord,
  releaseString,
  releaseStringArray,
  requiredReleaseRoute,
} from "./release-snapshot-values";
import {
  characterReferenceMediaAuthoritySelect,
  unavailableCharacterReferenceMediaIds,
} from "./reference-media-authority";
import {
  evaluateCharacterImageReviewAuthority,
  isCharacterLibraryOperatorUpload,
} from "./image-qualification";

export { CHARACTER_RELEASE_POLICY_VERSION };

export const releaseCheckKeys = [
  "release_generation_authority_kind",
  "project_character_authority",
  "revision_is_immutable_and_pinned",
  "soul_snapshot_valid",
  "soul_release_policy",
  "companion_product_contract",
  "opening_complete",
  "visual_identity_exact_version",
  "reference_set_published_snapshot",
  "generation_route_qualified",
  "release_avatar_manifest_available",
  "release_asset_manifest_available",
  "release_assets_customer_publishable",
  "release_asset_source_authority",
  "release_asset_generation_authority",
  "snapshot_hash_matches",
] as const;

export type ReleaseCheckKey = (typeof releaseCheckKeys)[number];

interface ValidationCheck {
  readonly key: ReleaseCheckKey;
  readonly passed: boolean;
  readonly evidence: Record<string, unknown>;
}

type ReleaseBlockerResolver = (evidence: Record<string, unknown>) => string;

/**
 * SPEC: check key → 提案响应里的 blocker code，全仓唯一一份。
 *
 * INTENT: propose 此前自己算 12 个 blocker，与这 18 道闸同规异名（三对一一对应但拼写不同）且
 * 可以互相矛盾。现在只有一台引擎，这张表只负责把它的裁决翻回 propose 早已对外发布的词表。
 * `null` 表示这道闸在提案侧本来就没有名字（Soul 四道门、快照哈希、客户可发布性等），直接透出
 * check key —— 提案此前根本不查它们。
 *
 * INVARIANT: `satisfies Record<ReleaseCheckKey, …>` 让「新增一道闸却没决定它的 code」变成编译
 * 错误。四道闸的 code 比闸本身更细，按 evidence 还原，分支顺序即优先级。
 */
const RELEASE_PROPOSAL_BLOCKER_CODES = {
  release_generation_authority_kind: null,
  project_character_authority: (evidence) =>
    evidence.characterExists === false
      ? "character_missing"
      : "project_missing",
  revision_is_immutable_and_pinned: () => "revision_missing",
  soul_snapshot_valid: null,
  soul_release_policy: null,
  companion_product_contract: null,
  opening_complete: null,
  visual_identity_exact_version: (evidence) =>
    evidence.immutableHash === null
      ? "active_visual_profile_missing_or_unsealed"
      : "active_visual_profile_hash_invalid",
  reference_set_published_snapshot: (evidence) =>
    Array.isArray(evidence.unavailableReferenceMediaIds) &&
    evidence.unavailableReferenceMediaIds.length > 0
      ? "active_reference_set_media_unavailable"
      : evidence.snapshotHash === null || evidence.referenceCount === 0
        ? "active_reference_set_missing_or_empty"
        : "active_reference_set_hash_invalid",
  generation_route_qualified: () => "qualified_generation_route_missing",
  release_avatar_manifest_available: () => "approved_avatar_missing",
  release_asset_manifest_available: null,
  release_assets_customer_publishable: null,
  release_asset_source_authority: null,
  release_asset_generation_authority: null,
  snapshot_hash_matches: null,
} as const satisfies Readonly<
  Record<ReleaseCheckKey, ReleaseBlockerResolver | null>
>;

export function characterReleaseBlockers(
  failed: readonly {
    readonly key: ReleaseCheckKey;
    readonly evidence: Record<string, unknown>;
  }[],
) {
  return [
    ...new Set(
      failed.map((check) => {
        const resolve: ReleaseBlockerResolver | null =
          RELEASE_PROPOSAL_BLOCKER_CODES[check.key];
        return resolve ? resolve(check.evidence) : check.key;
      }),
    ),
  ];
}

function referenceManifestEntries(value: Prisma.JsonValue | null) {
  return Array.isArray(value) ? value.map(releaseRecord) : [];
}

/**
 * SPEC: 「这份发布快照是否合法」的唯一输入形状。
 *
 * INTENT: 提案时还没有 CharacterRelease 行，但要回答的是同一个问题。把引擎的入参从「一行
 * Release」放宽成「一份候选快照」之后，propose 与 publish/resume 共用同一台规则引擎——此前
 * propose 内联了一份约 300 行的平行实现，两边同规异名且可以互相矛盾（propose 完全不看 Soul
 * 四道门，于是能提出一个必然发布失败的候选）。
 *
 * 持久化的 Release 行结构上就是一份候选快照，无需适配器。
 */
export interface CharacterReleaseSnapshotCandidate {
  readonly projectId: string;
  readonly revisionId: string | null;
  readonly characterContentVersionId: string | null;
  readonly visualProfileId: string | null;
  readonly visualProfileVersion: number | null;
  readonly referenceSetRevisionId: string | null;
  readonly generationProvenance: Prisma.JsonValue;
  readonly releasePlacementManifest: Prisma.JsonValue;
  readonly snapshotHash: string;
  readonly legacy: boolean;
  readonly rollbackOfReleaseId: string | null;
}

export async function evaluateCharacterReleaseSnapshot(
  tx: Prisma.TransactionClient,
  release: CharacterReleaseSnapshotCandidate,
  policyVersion: string,
  now: Date,
) {
  // Interactive transactions use one connection; keep reads sequential so the
  // pg adapter never multiplexes queries on an already-busy client.
  const manifestPlacements = releasePlacements(
    release.releasePlacementManifest,
  );
  const authorityProject = await tx.characterProject.findUnique({
    where: { id: release.projectId },
    select: { characterId: true },
  });
  if (authorityProject) {
    await lockCharacterGenerationAuthority(tx, authorityProject.characterId);
  }
  const referenceAuthority = release.referenceSetRevisionId
    ? await tx.referenceSetRevision.findUnique({
        where: { id: release.referenceSetRevisionId },
        select: {
          references: {
            select: { mediaAssetId: true },
            orderBy: { position: "asc" },
          },
        },
      })
    : null;
  await lockCharacterMediaAssetAuthorities(tx, [
    ...manifestPlacements.map((placement) => placement.assetId),
    ...(referenceAuthority?.references.map(
      (reference) => reference.mediaAssetId,
    ) ?? []),
  ]);
  const project = await tx.characterProject.findUnique({
    where: { id: release.projectId },
  });
  // CharacterProject.characterId 没有外键约束，Character 行确实可能不在了。
  const character = project
    ? await tx.character.findUnique({
        where: { id: project.characterId },
        select: { id: true },
      })
    : null;
  const revision = release.revisionId
    ? await tx.characterRevision.findUnique({
        where: { id: release.revisionId },
      })
    : null;
  const content = release.characterContentVersionId
    ? await tx.characterContentVersion.findUnique({
        where: { id: release.characterContentVersionId },
      })
    : null;
  const profile = release.visualProfileId
    ? await tx.characterVisualProfile.findUnique({
        where: { id: release.visualProfileId },
      })
    : null;
  const referenceSet = release.referenceSetRevisionId
    ? await tx.referenceSetRevision.findUnique({
        where: { id: release.referenceSetRevisionId },
        include: {
          references: {
            include: {
              mediaAsset: {
                select: characterReferenceMediaAuthoritySelect,
              },
            },
            orderBy: { position: "asc" },
          },
        },
      })
    : null;
  const provenance = releaseRecord(release.generationProvenance);
  const releaseRoute = requiredReleaseRoute(release.generationProvenance);
  const routeFingerprint = releaseString(releaseRoute.routeFingerprint);
  const route = routeFingerprint
    ? await tx.generationRouteQualification.findFirst({
        where: {
          routeFingerprint,
          result: "qualified",
          policyVersion,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        orderBy: { evaluatedAt: "desc" },
      })
    : null;
  const effectiveRoute = await evaluateEffectiveGenerationRouteAuthority(tx, {
    qualification: route,
    currentPolicyVersion: policyVersion,
    currentEvaluatorVersion: env.GENERATION_ROUTE_EVALUATOR_VERSION,
    now,
    requiredReferenceCount: referenceSet?.references.length ?? 0,
    requiredReferenceRoles:
      referenceSet?.references.map((reference) => reference.role) ?? [],
  });
  const canonicalSnapshotHash = characterReleaseSnapshotHash({
    projectId: release.projectId,
    revisionId: release.revisionId,
    characterContentVersionId: release.characterContentVersionId,
    visualProfileId: release.visualProfileId,
    visualProfileVersion: release.visualProfileVersion,
    referenceSetRevisionId: release.referenceSetRevisionId,
    generationProvenance: release.generationProvenance,
    releasePlacementManifest: release.releasePlacementManifest,
  });
  const currentVisualHash = profile
    ? characterVisualProfileSnapshotHash(profile)
    : null;
  const currentReferenceHash = referenceSet
    ? referenceSetSnapshotHash(referenceSet)
    : null;
  const unavailableReferenceMediaIds =
    referenceSet && project
      ? unavailableCharacterReferenceMediaIds(
          referenceSet.references,
          project.characterId,
        )
      : [];
  const strictGeneratedRelease =
    release.legacy === false &&
    provenance.schemaVersion === "character-release-generation-provenance-v2" &&
    provenance.policyVersion === CHARACTER_RELEASE_POLICY_VERSION &&
    policyVersion === CHARACTER_RELEASE_POLICY_VERSION &&
    hasCanonicalRequiredReleaseRoute(releaseRoute);
  const strictAssetManifest = parseCharacterReleaseAssetManifest(
    release.releasePlacementManifest,
  );
  const avatarAssetId = releaseAvatarAssetId(release.releasePlacementManifest);
  const placementAssets = await tx.mediaAsset.findMany({
    where: {
      id: {
        in: [
          ...new Set(manifestPlacements.map((placement) => placement.assetId)),
        ],
      },
    },
    select: {
      id: true,
      characterId: true,
      deletedAt: true,
      safetyStatus: true,
      storageKey: true,
      url: true,
      sourceJobId: true,
      metadata: true,
    },
  });
  const placementAssetById = new Map(
    placementAssets.map((asset) => [asset.id, asset]),
  );
  const placementItems = await tx.contentProductionItem.findMany({
    where: {
      OR: [
        {
          id: {
            in: manifestPlacements.flatMap((placement) =>
              placement.itemId ? [placement.itemId] : [],
            ),
          },
        },
        {
          mediaAssetId: {
            in: manifestPlacements.map((placement) => placement.assetId),
          },
        },
      ],
    },
    include: { batch: true, job: true },
  });
  const placementItemById = new Map(
    placementItems.map((item) => [item.id, item]),
  );
  const placementItemByAssetId = new Map(
    placementItems.flatMap((item) =>
      item.mediaAssetId ? [[item.mediaAssetId, item] as const] : []
    ),
  );
  const reviewDecisions = await tx.creativeReviewDecision.findMany({
    where: {
      OR: [
        ...(placementItems.length > 0
          ? [{ runItemId: { in: placementItems.map((item) => item.id) } }]
          : []),
        {
          runItemId: null,
          artifactId: {
            in: manifestPlacements.map((placement) => placement.assetId),
          },
        },
      ],
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const latestReviewByItemId = new Map<
    string,
    (typeof reviewDecisions)[number]
  >();
  const latestUploadReviewByAssetId = new Map<
    string,
    (typeof reviewDecisions)[number]
  >();
  for (const decision of reviewDecisions) {
    if (
      decision.runItemId &&
      !latestReviewByItemId.has(decision.runItemId)
    ) {
      latestReviewByItemId.set(decision.runItemId, decision);
    } else if (
      decision.runItemId === null &&
      !latestUploadReviewByAssetId.has(decision.artifactId)
    ) {
      latestUploadReviewByAssetId.set(decision.artifactId, decision);
    }
  }
  const attemptsByAssetId = await resolveGenerationAssetSuccessAttempts(tx, placementAssets);
  const rawPlacementProvenance = Array.isArray(provenance.placements)
    ? provenance.placements.map(releaseRecord)
    : [];
  const manifestIsWellFormed =
    strictGeneratedRelease &&
    strictAssetManifest !== null &&
    manifestPlacements.length === strictAssetManifest.placements.length;
  const unavailablePlacementSlots = manifestPlacements.flatMap((placement) => {
    const asset = placementAssetById.get(placement.assetId);
    return !asset ||
      asset.deletedAt !== null ||
      asset.safetyStatus !== "passed" ||
      !hasHydratableMediaBlobAuthority(asset)
      ? [placement.slotKey]
      : [];
  });
  const customerPublishabilityFailures = manifestPlacements.flatMap(
    (placement) => {
      const asset = placementAssetById.get(placement.assetId);
      const item = placement.itemId
        ? placementItemById.get(placement.itemId)
        : null;
      const job = item?.job ?? null;
      const latestAttempt = placement.generationJobId
        ? attemptsByAssetId.get(placement.assetId)
        : null;
      const pinnedCandidates = rawPlacementProvenance.filter(
        (candidate) => candidate.slotKey === placement.slotKey,
      );
      const pinned =
        pinnedCandidates.length === 1 ? pinnedCandidates[0] : undefined;
      const uploadAuthority = asset
        ? inspectOperatorUploadAuthority(asset)
        : null;
      const publishability = strictGeneratedRelease && uploadAuthority
        ? (() => {
            const base = evaluateMediaAssetCustomerPublishability({
              metadata: asset?.metadata,
            });
            const reasons = [
              ...base.reasons,
              ...uploadAuthority.reasons,
              ...(
                placement.runId ||
                placement.itemId ||
                placement.generationJobId ||
                placementItemByAssetId.has(placement.assetId) ||
                pinnedCandidates.length > 0
                  ? ["operator_upload_generation_lineage_present" as const]
                  : []
              ),
            ];
            return {
              publishable: reasons.length === 0,
              reasons: [...new Set(reasons)],
            };
          })()
        : evaluateMediaAssetCustomerPublishability({
            metadata: asset?.metadata,
            pinnedProvider: pinned?.provider,
            pinnedProviderRequired: strictGeneratedRelease,
            pinnedProviderDuplicate: pinnedCandidates.length > 1,
            pinnedProviderAssetMismatch: Boolean(
              pinned &&
              (pinned.assetId !== placement.assetId ||
                pinned.generationJobId !== placement.generationJobId),
            ),
            jobProvider: job?.provider,
            jobProviderRequired: strictGeneratedRelease,
            latestAttemptProvider: latestAttempt?.provider,
            latestAttemptProviderRequired: strictGeneratedRelease,
          });
      return publishability.publishable
        ? []
        : [
            {
              slotKey: placement.slotKey,
              assetId: placement.assetId,
              reasons: publishability.reasons,
              providers: {
                pinned: releaseString(pinned?.provider),
                job: job?.provider ?? null,
                latestAttempt: latestAttempt?.provider ?? null,
              },
            },
          ];
    },
  );
  const syntheticPlacementSlots = customerPublishabilityFailures
    .filter((failure) => failure.reasons.includes("metadata_synthetic"))
    .map((failure) => failure.slotKey);
  const invalidImageSourceSlots = manifestPlacements.flatMap(
    (placement) => {
      const asset = placementAssetById.get(placement.assetId);
      if (!strictGeneratedRelease) {
        return asset?.characterId === project?.characterId
          ? []
          : [placement.slotKey];
      }
      const uploadAuthority = asset
        ? inspectOperatorUploadAuthority(asset)
        : null;
      const item = placement.itemId
        ? placementItemById.get(placement.itemId)
        : null;
      const review = uploadAuthority
        ? latestUploadReviewByAssetId.get(placement.assetId) ?? null
        : item
          ? latestReviewByItemId.get(item.id) ?? null
          : null;
      const visualAuthority =
        profile?.immutableHash &&
        referenceSet?.snapshotHash &&
        referenceSet.references.length > 0
          ? {
              visualProfileId: profile.id,
              visualProfileVersion: profile.version,
              visualProfileHash: profile.immutableHash,
              referenceSetRevisionId: referenceSet.id,
              referenceSetSnapshotHash: referenceSet.snapshotHash,
            }
          : null;
      const qualification = evaluateCharacterImageReviewAuthority({
        source: uploadAuthority ? "operator_upload" : "generation",
        characterId: project?.characterId ?? "",
        assetId: placement.assetId,
        assetAvailable: Boolean(
          asset &&
          asset.deletedAt === null &&
          asset.safetyStatus === "passed" &&
          hasHydratableMediaBlobAuthority(asset),
        ),
        sourceAuthorityValid: uploadAuthority
          ? Boolean(
              asset &&
              isCharacterLibraryOperatorUpload(asset) &&
              asset.characterId === project?.characterId &&
              placement.runId === null &&
              placement.itemId === null &&
              placement.generationJobId === null &&
              !placementItemByAssetId.has(placement.assetId),
            )
          : Boolean(
              asset?.characterId === project?.characterId &&
              item?.mediaAssetId === placement.assetId,
            ),
        bootstrapIdentity: placement.bootstrapIdentity,
        review,
        pinnedReviewDecisionId: placement.reviewDecisionId,
        currentVisualAuthority: visualAuthority,
      });
      return qualification.qualified
        ? []
        : [placement.slotKey];
    },
  );
  const invalidGenerationAuthoritySlots = manifestPlacements.flatMap(
    (placement) => {
      if (!placement.generationJobId) {
        return [];
      }
      if (!placement.itemId) return [placement.slotKey];
      const item = placementItemById.get(placement.itemId);
      const job = item?.job ?? null;
      const attempt = attemptsByAssetId.get(placement.assetId);
      const asset = placementAssetById.get(placement.assetId);
      const pinnedCandidates = rawPlacementProvenance.filter(
        (candidate) => candidate.slotKey === placement.slotKey,
      );
      const pinned =
        pinnedCandidates.length === 1 &&
        pinnedCandidates[0]?.assetId === placement.assetId &&
        pinnedCandidates[0]?.generationJobId === placement.generationJobId
          ? pinnedCandidates[0]
          : undefined;
      const sourceMeta = releaseRecord(job?.sourceMeta);
      const manifestEntries = referenceManifestEntries(
        job?.referenceManifest ?? null,
      );
      const manifestAssetIds = manifestEntries.flatMap((manifestEntry) =>
        typeof manifestEntry.mediaAssetId === "string"
          ? [manifestEntry.mediaAssetId]
          : [],
      );
      const referenceAssetIds = releaseStringArray(
        job?.referenceAssetIds ?? null,
      );
      const commonAuthorityMatches = Boolean(
        item &&
        job &&
        attempt &&
        pinned &&
        pinned.bootstrapIdentity === placement.bootstrapIdentity &&
        item.jobId === placement.generationJobId &&
        job.id === placement.generationJobId &&
        job.status === "completed" &&
        job.mode === "image" &&
        job.deliveredOutputCount >= 1 &&
        job.profileId !== null &&
        job.profileVersion !== null &&
        job.model !== null &&
        job.provider !== null &&
        pinned.provider === job.provider &&
        job.characterId === project?.characterId &&
        job.sourceType === "content_production_item" &&
        job.sourceId === item.id &&
        placement.runId === item.batchId &&
        item.batch.targetType === "character" &&
        item.batch.targetId === project?.characterId &&
        sourceMeta.batchId === item.batchId &&
        // The original brief is provenance, not a product placement. Keep it
        // bound to its actual Run when an existing image is selected elsewhere.
        characterDraftAssetPurposes.some((purpose) => purpose === item.batch.purpose) &&
        sourceMeta.purpose === item.batch.purpose &&
        sourceMeta.targetType === "character" &&
        sourceMeta.targetId === project?.characterId &&
        sourceMeta.bootstrapIdentity === placement.bootstrapIdentity &&
        asset?.sourceJobId === job.id &&
        // The asset-bound resolver also accepts an adopted unknown Attempt
        // after verifying its resolution Receipt, command, Artifact and Delivery.
        attempt.provider === job.provider &&
        attempt.profileKey === job.profileId &&
        attempt.profileVersion === job.profileVersion &&
        attempt.workflowKey === job.model &&
        pinned.attemptId === attempt.id &&
        pinned.attemptNo === attempt.attemptNo &&
        pinned.generationProfileKey === job.profileId &&
        pinned.generationProfileVersion === job.profileVersion &&
        pinned.workflowKey === job.model &&
        pinned.workflowVersion === attempt.workflowVersion &&
        pinned.visualProfileId === job.visualProfileId &&
        pinned.visualProfileVersion === job.visualProfileVersion &&
        pinned.referenceSetRevisionId === job.referenceSetRevisionId &&
        pinned.referenceManifestHash ===
          (job.referenceManifest
            ? canonicalSha256(job.referenceManifest)
            : null),
      );
      const bootstrapAuthorityMatches = Boolean(
        commonAuthorityMatches &&
        placement.bootstrapIdentity &&
        job &&
        profile &&
        referenceSet &&
        sourceMeta.bootstrapIdentity === true &&
        job.visualProfileId === null &&
        job.referenceSetRevisionId === null &&
        referenceAssetIds.length === 0 &&
        manifestEntries.length === 0 &&
        profile.createdFrom === `identity_bootstrap:${job.id}` &&
        profile.evidenceState === "reviewed_bootstrap" &&
        releaseRecord(profile.adapterRefs).bootstrapIdentity === true &&
        releaseRecord(profile.adapterRefs).generationJobId === job.id &&
        referenceSet.createdFrom === `identity_bootstrap:${job.id}` &&
        referenceSet.references.some(
          (reference) => reference.mediaAssetId === placement.assetId,
        ),
      );
      const identityRouteAuthorityMatches = Boolean(
        commonAuthorityMatches &&
        !placement.bootstrapIdentity &&
        job &&
        attempt &&
        profile &&
        referenceSet &&
        route &&
        job.visualProfileId === release.visualProfileId &&
        job.visualProfileVersion === release.visualProfileVersion &&
        job.referenceSetRevisionId === release.referenceSetRevisionId &&
        referenceAssetIds.length > 0 &&
        manifestEntries.length > 0 &&
        canonicalSha256([...referenceAssetIds].sort()) ===
          canonicalSha256([...manifestAssetIds].sort()) &&
        manifestEntries.every(
          (manifestEntry) =>
            manifestEntry.referenceSetRevisionId ===
              release.referenceSetRevisionId &&
            manifestEntry.snapshotHash === referenceSet.snapshotHash,
        ) &&
        // SPEC: A route upgrade governs future generation. Delivered images keep
        // their historical Job/Attempt pins, checked by commonAuthorityMatches.
        sourceMeta.referenceSetRevisionId === release.referenceSetRevisionId,
      );
      return bootstrapAuthorityMatches || identityRouteAuthorityMatches
        ? []
        : [placement.slotKey];
    },
  );
  const avatarAsset = avatarAssetId
    ? (placementAssetById.get(avatarAssetId) ?? null)
    : null;
  const soulResult = content
    ? loadCharacterSoulSnapshot(content.personaSnapshot)
    : null;
  const companionCanary = soulResult?.ok
    ? companionProductContractCanary({
        soulPrompt: soulResult.snapshot.compiled.systemPrompt,
      })
    : null;
  const storedSoulSchemaVersion =
    content?.personaSnapshot &&
    typeof content.personaSnapshot === "object" &&
    !Array.isArray(content.personaSnapshot)
      ? (content.personaSnapshot as Record<string, unknown>).schemaVersion
      : null;
  // Historical Soul snapshots remain readable for pinned sessions. A current
  // v3 Soul cannot label itself legacy to bypass behavior or live-model proof.
  const historicalSoulReadOnly =
    release.legacy && storedSoulSchemaVersion !== 3;
  const opening = content ? releaseRecord(content.openingSnapshot) : {};
  const checks: ValidationCheck[] = [
    {
      key: "release_generation_authority_kind",
      passed: strictGeneratedRelease,
      evidence: {
        legacy: release.legacy,
        provenanceSchemaVersion: provenance.schemaVersion ?? null,
        provenancePolicyVersion: provenance.policyVersion ?? null,
        requiredPolicyVersion: CHARACTER_RELEASE_POLICY_VERSION,
        canonicalRequiredReleaseRoute:
          hasCanonicalRequiredReleaseRoute(releaseRoute),
        requiredSchemaVersion: "character-release-generation-provenance-v2",
      },
    },
    {
      key: "project_character_authority",
      passed: project !== null && character !== null,
      evidence: {
        projectId: release.projectId,
        characterId: project?.characterId ?? null,
        characterExists: character !== null,
      },
    },
    {
      key: "revision_is_immutable_and_pinned",
      passed:
        revision !== null &&
        revision.projectId === release.projectId &&
        revision.characterContentVersionId ===
          release.characterContentVersionId,
      evidence: { revisionId: release.revisionId },
    },
    {
      key: "soul_snapshot_valid",
      passed: soulResult?.ok === true,
      evidence: {
        characterContentVersionId: release.characterContentVersionId,
        schemaVersion: storedSoulSchemaVersion,
        compilerVersion: soulResult?.ok
          ? soulResult.snapshot.compiled.compilerVersion
          : null,
        soulFingerprint: soulResult?.ok
          ? soulResult.snapshot.compiled.fingerprint
          : null,
        estimatedTokens: soulResult?.ok
          ? soulResult.snapshot.compiled.estimatedTokens
          : null,
        diagnostics: soulResult?.diagnostics ?? [],
      },
    },
    {
      key: "soul_release_policy",
      // Historical snapshots remain readable for already-pinned sessions and
      // explicitly legacy Releases. Every newly governed Release must pin v3.
      passed:
        soulResult?.ok === true &&
        (historicalSoulReadOnly ||
          (storedSoulSchemaVersion === 3 &&
            soulResult.diagnostics.length === 0)),
      evidence: {
        legacyRelease: release.legacy,
        warningCodes: soulResult?.ok
          ? soulResult.diagnostics
              .filter((item) => item.severity === "warning")
              .map((item) => item.code)
          : [],
      },
    },
    {
      key: "companion_product_contract",
      passed: companionCanary?.passed === true,
      evidence: {
        characterContentVersionId: release.characterContentVersionId,
        soulFingerprint: soulResult?.ok
          ? soulResult.snapshot.compiled.fingerprint
          : null,
        compilerVersion: soulResult?.ok
          ? soulResult.snapshot.compiled.compilerVersion
          : null,
        productPromptVersion: COMPANION_PRODUCT_PROMPT_VERSION,
        canaryPromptDigest: companionCanary
          ? canonicalSha256(companionCanary.systemPrompt)
          : null,
        actionName: companionCanary?.actionName ?? null,
        imagePromptAuthority: companionCanary?.imagePromptAuthority ?? null,
        executionMode: companionCanary?.executionMode ?? null,
      },
    },
    {
      key: "opening_complete",
      passed: content !== null && releaseString(opening.firstMessage) !== null,
      evidence: {
        characterContentVersionId: release.characterContentVersionId,
      },
    },
    {
      key: "visual_identity_exact_version",
      passed:
        profile !== null &&
        profile.characterId === project?.characterId &&
        profile.version === release.visualProfileVersion &&
        (profile.status === "active" || release.rollbackOfReleaseId !== null) &&
        profile.immutableHash !== null &&
        profile.immutableHash === currentVisualHash,
      evidence: {
        visualProfileId: release.visualProfileId,
        expectedVersion: release.visualProfileVersion,
        actualVersion: profile?.version ?? null,
        immutableHash: profile?.immutableHash ?? null,
        currentVisualHash,
      },
    },
    {
      key: "reference_set_published_snapshot",
      passed:
        referenceSet !== null &&
        referenceSet.visualProfileId === release.visualProfileId &&
        (referenceSet.status === "active" ||
          release.rollbackOfReleaseId !== null) &&
        referenceSet.snapshotHash !== null &&
        referenceSet.snapshotHash === currentReferenceHash &&
        referenceSet.references.length > 0 &&
        unavailableReferenceMediaIds.length === 0,
      evidence: {
        referenceSetRevisionId: release.referenceSetRevisionId,
        referenceCount: referenceSet?.references.length ?? 0,
        snapshotHash: referenceSet?.snapshotHash ?? null,
        currentReferenceHash,
        unavailableReferenceMediaIds,
      },
    },
    {
      key: "generation_route_qualified",
      passed:
        effectiveRoute.state === "qualified" &&
        route !== null &&
        (isOperatorSingleImageRoute(route) ||
          (route.sampleCount >= 40 && route.identityMatch >= 0.9)) &&
        route.generationProfileKey === releaseRoute.generationProfileKey &&
        route.generationProfileVersion ===
          releaseRoute.generationProfileVersion &&
        route.workflowKey === releaseRoute.workflowKey &&
        route.workflowVersion === releaseRoute.workflowVersion,
      evidence: {
        routeFingerprint,
        qualificationId: route?.id ?? null,
        sampleCount: route?.sampleCount ?? null,
        identityMatch: route?.identityMatch ?? null,
        policyVersion,
        evaluatorVersion: env.GENERATION_ROUTE_EVALUATOR_VERSION,
        effectiveState: effectiveRoute.state,
        effectiveReason: effectiveRoute.reason,
      },
    },
    {
      key: "release_avatar_manifest_available",
      passed:
        avatarAsset !== null &&
        avatarAsset.deletedAt === null &&
        avatarAsset.safetyStatus === "passed" &&
        hasHydratableMediaBlobAuthority(avatarAsset),
      evidence: { avatarAssetId },
    },
    {
      key: "release_asset_manifest_available",
      passed: manifestIsWellFormed && unavailablePlacementSlots.length === 0,
      evidence: {
        placementCount: manifestPlacements.length,
        unavailablePlacementSlots,
        manifestIsWellFormed,
      },
    },
    {
      key: "release_assets_customer_publishable",
      passed: customerPublishabilityFailures.length === 0,
      evidence: {
        syntheticPlacementSlots,
        placements: customerPublishabilityFailures,
        failures: customerPublishabilityFailures,
      },
    },
    {
      key: "release_asset_source_authority",
      passed: invalidImageSourceSlots.length === 0,
      evidence: { invalidImageSourceSlots },
    },
    {
      key: "release_asset_generation_authority",
      passed: invalidGenerationAuthoritySlots.length === 0,
      evidence: { invalidGenerationAuthoritySlots },
    },
    {
      key: "snapshot_hash_matches",
      passed: release.snapshotHash === canonicalSnapshotHash,
      evidence: {
        stored: release.snapshotHash,
        computed: canonicalSnapshotHash,
      },
    },
  ];
  const failed = checks.filter((check) => !check.passed);
  return {
    checks,
    failed,
    project,
    content,
    avatarAssetId,
    snapshotHash: canonicalSnapshotHash,
  };
}

/**
 * SPEC: 对一行已持久化的 Release 跑同一台引擎，并把这次裁决落成不可变证据。
 *
 * INTENT: 证据只在有 Release 行时才写得下（ReleaseValidationRun 外键指向它）。提案阶段的候选
 * 快照没有行，因此走 evaluate；两条路径的判据完全相同，差别只在留不留痕。
 */
export async function validateCharacterReleaseSnapshot(
  tx: Prisma.TransactionClient,
  release: Awaited<
    ReturnType<
      Prisma.TransactionClient["characterRelease"]["findUniqueOrThrow"]
    >
  >,
  policyVersion: string,
  now: Date,
) {
  const evaluation = await evaluateCharacterReleaseSnapshot(
    tx,
    release,
    policyVersion,
    now,
  );
  const run = await tx.releaseValidationRun.create({
    data: {
      releaseId: release.id,
      snapshotHash: evaluation.snapshotHash,
      policyVersion,
      result: evaluation.failed.length === 0 ? "passed" : "failed",
      startedAt: now,
      finishedAt: now,
    },
  });
  await tx.releaseCheckResult.createMany({
    data: evaluation.checks.map((check) => ({
      validationRunId: run.id,
      checkKey: check.key,
      result: check.passed ? "passed" : "failed",
      evidence: toInputJson(check.evidence),
      checkedAt: now,
    })),
  });
  return { run, ...evaluation };
}
