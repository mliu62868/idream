import type { Prisma } from "@prisma/client";
import {
  characterSoulBehaviorBlockingCases,
  characterSoulBehaviorEvaluationSchema,
  characterSoulBehaviorEvaluatorVersion,
  characterSoulLiveCanarySchema,
  characterQaAuthorityMatches,
  characterQaProvenanceMatchesRun,
  parseCharacterReleaseAssetManifest,
} from "@idream/shared/admin";
import { loadCharacterSoulSnapshot } from "@idream/shared";
import { env } from "@/server/lib/env";
import {
  evaluateMediaAssetCustomerPublishability,
  hasHydratableMediaBlobAuthority,
} from "@/server/lib/media-asset-authority";
import { canonicalSha256 } from "../shared/canonical-json";
import { characterIdentityReviewEvidencePassed } from "../shared/creative-review-quality";
import { toInputJson } from "../shared/prisma-json";
import { characterReleaseAssetPurpose } from "./character-release-contract";
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
import { findLatestCharacterQaAuthorityRun } from "./qa-authority";
import { requiredCharacterSoulChatProfiles } from "./soul-evaluation";

// SPEC: 当前发布策略版本 —— 证据按它判新旧，升版即让旧 Release 的合格证明失效。
export const CHARACTER_RELEASE_POLICY_VERSION = "character-release-policy-v2";

export const releaseCheckKeys = [
  "release_generation_authority_kind",
  "project_character_authority",
  "revision_is_immutable_and_pinned",
  "soul_snapshot_valid",
  "soul_release_policy",
  "soul_behavior_evaluation",
  "soul_live_model_canaries",
  "opening_complete",
  "visual_identity_exact_version",
  "reference_set_published_snapshot",
  "generation_route_qualified",
  "character_qa_passed",
  "release_avatar_manifest_available",
  "release_asset_manifest_available",
  "release_assets_customer_publishable",
  "release_asset_review_authority",
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
    evidence.characterExists === false ? "character_missing" : "project_missing",
  revision_is_immutable_and_pinned: () => "revision_missing",
  soul_snapshot_valid: null,
  soul_release_policy: null,
  soul_behavior_evaluation: null,
  soul_live_model_canaries: null,
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
  character_qa_passed: (evidence) =>
    evidence.authorityStatus !== "passed"
      ? "character_qa_not_passed"
      : evidence.authorityMatches === false
        ? "character_qa_authority_mismatch"
        : "character_qa_not_latest_authority",
  release_avatar_manifest_available: () => "approved_avatar_missing",
  release_asset_manifest_available: null,
  release_assets_customer_publishable: null,
  release_asset_review_authority: null,
  release_asset_generation_authority: null,
  snapshot_hash_matches: null,
} as const satisfies Readonly<
  Record<ReleaseCheckKey, ReleaseBlockerResolver | null>
>;

export function characterReleaseProposalBlockers(
  failed: readonly { readonly key: ReleaseCheckKey; readonly evidence: Record<string, unknown> }[],
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
  /**
   * INVARIANT: Release 行不 pin projectVersion 与 draftAssetPackHash，因此对已发布快照这两项
   * 只能拿 QA Run 自己的值比较（自比恒真）。提案时它们是活事实——「QA 是不是针对当前草稿包和
   * 当前 project 版本跑的」——由调用方显式喂进来，同一台引擎才答得了这个问题。
   */
  readonly liveQaAuthority?: {
    readonly projectVersion: number;
    readonly draftAssetPackHash: string | null;
  };
}

export async function evaluateCharacterReleaseSnapshot(
  tx: Prisma.TransactionClient,
  release: CharacterReleaseSnapshotCandidate,
  policyVersion: string,
  now: Date,
) {
  // Interactive transactions use one connection; keep reads sequential so the
  // pg adapter never multiplexes queries on an already-busy client.
  const manifestPlacements = releasePlacements(release.releasePlacementManifest);
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
  const characterQa = releaseRecord(provenance.characterQa);
  const strictCharacterQa =
    release.legacy === false &&
    provenance.schemaVersion ===
      "character-release-generation-provenance-v2" &&
    provenance.policyVersion === CHARACTER_RELEASE_POLICY_VERSION &&
    policyVersion === CHARACTER_RELEASE_POLICY_VERSION &&
    hasCanonicalRequiredReleaseRoute(releaseRoute);
  const characterQaRunId = releaseString(characterQa.qaRunId);
  const characterQaRun = characterQaRunId
    ? await tx.characterQaRun.findUnique({ where: { id: characterQaRunId } })
    : null;
  const expectedQaAuthority = characterQaRun
    ? {
        characterId: project?.characterId ?? null,
        projectId: release.projectId,
        characterContentVersionId: release.characterContentVersionId,
        projectVersion:
          release.liveQaAuthority?.projectVersion ?? characterQaRun.projectVersion,
        visualProfileId: release.visualProfileId,
        visualProfileVersion: release.visualProfileVersion,
        visualProfileHash: currentVisualHash,
        referenceSetRevisionId: release.referenceSetRevisionId,
        referenceSetRevision: referenceSet?.revision ?? null,
        referenceSetHash: currentReferenceHash,
        draftAssetPackHash:
          release.liveQaAuthority?.draftAssetPackHash ??
          characterQaRun.draftAssetPackHash,
      }
    : null;
  const characterQaAuthorityMatched = Boolean(
    expectedQaAuthority &&
      characterQaAuthorityMatches(characterQaRun, expectedQaAuthority),
  );
  const latestCharacterQaRun = strictCharacterQa && characterQaRun
    ? await findLatestCharacterQaAuthorityRun(tx, {
        characterId: characterQaRun.characterId,
        projectId: characterQaRun.projectId,
        characterContentVersionId: characterQaRun.characterContentVersionId,
        projectVersion: characterQaRun.projectVersion,
        visualProfileId: characterQaRun.visualProfileId,
        visualProfileVersion: characterQaRun.visualProfileVersion,
        visualProfileHash: characterQaRun.visualProfileHash,
        referenceSetRevisionId: characterQaRun.referenceSetRevisionId,
        referenceSetRevision: characterQaRun.referenceSetRevision,
        referenceSetHash: characterQaRun.referenceSetHash,
        draftAssetPackHash: characterQaRun.draftAssetPackHash,
      })
    : characterQaRun;
  const strictAssetManifest = parseCharacterReleaseAssetManifest(
    release.releasePlacementManifest,
  );
  const avatarAssetId = releaseAvatarAssetId(release.releasePlacementManifest);
  const placementAssets = await tx.mediaAsset.findMany({
    where: { id: { in: [...new Set(manifestPlacements.map((placement) => placement.assetId))] } },
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
  const placementAssetById = new Map(placementAssets.map((asset) => [asset.id, asset]));
  const placementItems = await tx.contentProductionItem.findMany({
    where: { id: { in: manifestPlacements.flatMap((placement) => placement.itemId ? [placement.itemId] : []) } },
    include: { batch: true, job: true },
  });
  const placementItemById = new Map(placementItems.map((item) => [item.id, item]));
  const placementAttempts = await tx.generationAttempt.findMany({
    where: {
      requestId: {
        in: manifestPlacements.flatMap((placement) => placement.generationJobId ? [placement.generationJobId] : []),
      },
      status: "succeeded",
    },
    orderBy: [{ requestId: "asc" }, { attemptNo: "desc" }],
  });
  const latestAttemptByJobId = new Map<string, (typeof placementAttempts)[number]>();
  for (const attempt of placementAttempts) {
    if (!latestAttemptByJobId.has(attempt.requestId)) {
      latestAttemptByJobId.set(attempt.requestId, attempt);
    }
  }
  const placementDecisions = await tx.creativeReviewDecision.findMany({
    where: { runItemId: { in: manifestPlacements.flatMap((placement) => placement.itemId ? [placement.itemId] : []) } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const latestDecisionByItemId = new Map<string, (typeof placementDecisions)[number]>();
  for (const decision of placementDecisions) {
    if (!latestDecisionByItemId.has(decision.runItemId)) {
      latestDecisionByItemId.set(decision.runItemId, decision);
    }
  }
  const rawPlacementProvenance = Array.isArray(provenance.placements)
    ? provenance.placements.map(releaseRecord)
    : [];
  const manifestIsWellFormed =
    strictCharacterQa &&
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
  const customerPublishabilityFailures = manifestPlacements.flatMap((placement) => {
    const asset = placementAssetById.get(placement.assetId);
    const item = placement.itemId
      ? placementItemById.get(placement.itemId)
      : null;
    const job = item?.job ?? null;
    const latestAttempt = placement.generationJobId
      ? latestAttemptByJobId.get(placement.generationJobId)
      : null;
    const pinnedCandidates = rawPlacementProvenance.filter((candidate) =>
      candidate.slotKey === placement.slotKey
    );
    const pinned = pinnedCandidates.length === 1
      ? pinnedCandidates[0]
      : undefined;
    const publishability = evaluateMediaAssetCustomerPublishability({
      metadata: asset?.metadata,
      pinnedProvider: pinned?.provider,
      pinnedProviderRequired: strictCharacterQa,
      pinnedProviderDuplicate: pinnedCandidates.length > 1,
      pinnedProviderAssetMismatch: Boolean(
        pinned &&
        (
          pinned.assetId !== placement.assetId ||
          pinned.generationJobId !== placement.generationJobId
        )
      ),
      jobProvider: job?.provider,
      jobProviderRequired: strictCharacterQa,
      latestAttemptProvider: latestAttempt?.provider,
      latestAttemptProviderRequired: strictCharacterQa,
    });
    return publishability.publishable
      ? []
      : [{
          slotKey: placement.slotKey,
          assetId: placement.assetId,
          reasons: publishability.reasons,
          providers: {
            pinned: releaseString(pinned?.provider),
            job: job?.provider ?? null,
            latestAttempt: latestAttempt?.provider ?? null,
          },
        }];
  });
  const syntheticPlacementSlots = customerPublishabilityFailures
    .filter((failure) => failure.reasons.includes("metadata_synthetic"))
    .map((failure) => failure.slotKey);
  const invalidReviewAuthoritySlots = manifestPlacements.flatMap((placement) => {
    const lineage = [placement.runId, placement.itemId, placement.reviewDecisionId];
    const hasLineage = lineage.some((value) => value !== null);
    if (!hasLineage) return [placement.slotKey];
    if (lineage.some((value) => value === null) || !placement.itemId) return [placement.slotKey];
    const item = placementItemById.get(placement.itemId);
    const decision = latestDecisionByItemId.get(placement.itemId);
    const asset = placementAssetById.get(placement.assetId);
    return !item ||
      item.batchId !== placement.runId ||
      item.mediaAssetId !== placement.assetId ||
      item.batch.targetType !== "character" ||
      item.batch.targetId !== project?.characterId ||
      item.batch.purpose !== characterReleaseAssetPurpose(placement.slotKey) ||
      !["approved", "published"].includes(item.status) ||
      asset?.characterId !== project?.characterId ||
      !decision ||
      decision.id !== placement.reviewDecisionId ||
      decision.artifactId !== placement.assetId ||
      !characterIdentityReviewEvidencePassed({
        bootstrapIdentity: placement.bootstrapIdentity,
        decision: decision.decision,
        identityConsistency: decision.identityConsistency,
        score: decision.score,
        evidence: decision.evidence,
      })
      ? [placement.slotKey]
      : [];
  });
  const invalidGenerationAuthoritySlots = manifestPlacements.flatMap((placement) => {
    if (!placement.generationJobId) {
      return [placement.slotKey];
    }
    if (!placement.itemId) return [placement.slotKey];
    const item = placementItemById.get(placement.itemId);
    const job = item?.job ?? null;
    const attempt = latestAttemptByJobId.get(placement.generationJobId);
    const asset = placementAssetById.get(placement.assetId);
    const pinnedCandidates = rawPlacementProvenance.filter((candidate) =>
      candidate.slotKey === placement.slotKey
    );
    const pinned = pinnedCandidates.length === 1 &&
        pinnedCandidates[0]?.assetId === placement.assetId &&
        pinnedCandidates[0]?.generationJobId === placement.generationJobId
      ? pinnedCandidates[0]
      : undefined;
    const sourceMeta = releaseRecord(job?.sourceMeta);
    const manifestEntries = referenceManifestEntries(job?.referenceManifest ?? null);
    const manifestAssetIds = manifestEntries.flatMap((manifestEntry) =>
      typeof manifestEntry.mediaAssetId === "string" ? [manifestEntry.mediaAssetId] : []
    );
    const referenceAssetIds = releaseStringArray(job?.referenceAssetIds ?? null);
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
      sourceMeta.batchId === item.batchId &&
      sourceMeta.purpose === characterReleaseAssetPurpose(placement.slotKey) &&
      sourceMeta.targetType === "character" &&
      sourceMeta.targetId === project?.characterId &&
      sourceMeta.bootstrapIdentity === placement.bootstrapIdentity &&
      asset?.sourceJobId === job.id &&
      attempt.status === "succeeded" &&
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
      pinned.referenceManifestHash === (
        job.referenceManifest ? canonicalSha256(job.referenceManifest) : null
      ),
    );
    const bootstrapAuthorityMatches = Boolean(
      commonAuthorityMatches &&
      placement.bootstrapIdentity &&
      placement.slotKey === "character_avatar" &&
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
      referenceSet.references.some((reference) => reference.mediaAssetId === placement.assetId),
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
      canonicalSha256([...referenceAssetIds].sort()) === canonicalSha256([...manifestAssetIds].sort()) &&
      manifestEntries.every((manifestEntry) =>
        manifestEntry.referenceSetRevisionId === release.referenceSetRevisionId &&
        manifestEntry.snapshotHash === referenceSet.snapshotHash
      ) &&
      sourceMeta.referenceSetRevisionId === release.referenceSetRevisionId &&
      job.profileId === releaseRoute.generationProfileKey &&
      job.profileVersion === releaseRoute.generationProfileVersion &&
      job.model === releaseRoute.workflowKey &&
      attempt.profileKey === releaseRoute.generationProfileKey &&
      attempt.profileVersion === releaseRoute.generationProfileVersion &&
      attempt.workflowKey === releaseRoute.workflowKey &&
      attempt.workflowVersion === releaseRoute.workflowVersion,
    );
    return bootstrapAuthorityMatches || identityRouteAuthorityMatches
      ? []
      : [placement.slotKey];
  });
  const avatarAsset = avatarAssetId ? placementAssetById.get(avatarAssetId) ?? null : null;
  const soulResult = content
    ? loadCharacterSoulSnapshot(content.personaSnapshot)
    : null;
  const behaviorEvaluation = characterSoulBehaviorEvaluationSchema.safeParse(
    characterQaRun?.behaviorEvaluation,
  );
  const behaviorAuthorityPassed = Boolean(
    behaviorEvaluation.success &&
    soulResult?.ok &&
    // 换评测器即让旧证据失效：证据必须由当前评测器产出。
    behaviorEvaluation.data.evaluatorVersion === characterSoulBehaviorEvaluatorVersion &&
    behaviorEvaluation.data.characterContentVersionId === release.characterContentVersionId &&
    behaviorEvaluation.data.soulFingerprint === soulResult.snapshot.compiled.fingerprint &&
    behaviorEvaluation.data.compilerVersion === soulResult.snapshot.compiled.compilerVersion &&
    behaviorEvaluation.data.cases.every((entry) =>
      !characterSoulBehaviorBlockingCases.has(entry.key) || entry.result === "passed"
    ),
  );
  const rawCanaries = Array.isArray(characterQaRun?.liveCanaries)
    ? characterQaRun.liveCanaries
    : [];
  const parsedCanaries = rawCanaries.map((value) => characterSoulLiveCanarySchema.safeParse(value));
  const canaries = parsedCanaries.flatMap((value) => value.success ? [value.data] : []);
  const expectedCanaries = requiredCharacterSoulChatProfiles();
  const canaryByTier = new Map(canaries.map((canary) => [canary.tier, canary]));
  const liveCanaryAuthorityPassed = Boolean(
    soulResult?.ok &&
    parsedCanaries.every((value) => value.success) &&
    canaryByTier.size === canaries.length &&
    canaries.length === expectedCanaries.length &&
    expectedCanaries.every(({ tier, profile: expected }) => {
      const canary = canaryByTier.get(tier);
      return Boolean(
        canary &&
        canary.result === "passed" &&
        canary.adapter === expected.adapter &&
        canary.provider === expected.provider &&
        canary.model === expected.model &&
        canary.characterContentVersionId === release.characterContentVersionId &&
        canary.soulFingerprint === soulResult.snapshot.compiled.fingerprint &&
        canary.compilerVersion === soulResult.snapshot.compiled.compilerVersion
      );
    }),
  );
  const opening = content ? releaseRecord(content.openingSnapshot) : {};
  const checks: ValidationCheck[] = [
    {
      key: "release_generation_authority_kind",
      passed: strictCharacterQa,
      evidence: {
        legacy: release.legacy,
        provenanceSchemaVersion: provenance.schemaVersion ?? null,
        provenancePolicyVersion: provenance.policyVersion ?? null,
        requiredPolicyVersion: CHARACTER_RELEASE_POLICY_VERSION,
        canonicalRequiredReleaseRoute:
          hasCanonicalRequiredReleaseRoute(releaseRoute),
        requiredSchemaVersion:
          "character-release-generation-provenance-v2",
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
        schemaVersion: soulResult?.ok
          ? soulResult.snapshot.schemaVersion
          : null,
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
      // Legacy Releases retain their explicit immutable prompt through the
      // schemaVersion 0 decoder. Every newly governed Release must finish all
      // Soul authoring dimensions rather than hide gaps behind generic filler.
      passed:
        soulResult?.ok === true &&
        (release.legacy || soulResult.diagnostics.length === 0),
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
      key: "soul_behavior_evaluation",
      passed: release.legacy || behaviorAuthorityPassed,
      evidence: {
        legacyRelease: release.legacy,
        qaRunId: characterQaRun?.id ?? null,
        suiteVersion: behaviorEvaluation.success
          ? behaviorEvaluation.data.suiteVersion
          : null,
        evaluatorVersion: behaviorEvaluation.success
          ? behaviorEvaluation.data.evaluatorVersion
          : null,
        immutableAuthorityMatches: behaviorAuthorityPassed,
      },
    },
    {
      key: "soul_live_model_canaries",
      passed: release.legacy || liveCanaryAuthorityPassed,
      evidence: {
        legacyRelease: release.legacy,
        qaRunId: characterQaRun?.id ?? null,
        requiredProfiles: expectedCanaries.map(({ tier, profile }) => ({
          tier,
          provider: profile.provider,
          model: profile.model,
        })),
        observedProfiles: canaries.map((canary) => ({
          tier: canary.tier,
          provider: canary.provider,
          model: canary.model,
          firstTokenMs: canary.firstTokenMs,
          totalMs: canary.totalMs,
          coldStart: canary.coldStart,
          result: canary.result,
          evidenceRef: canary.evidenceRef,
        })),
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
        (
          isOperatorSingleImageRoute(route) ||
          (
            route.sampleCount >= 40 &&
            route.identityMatch >= 0.9
          )
        ) &&
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
      key: "character_qa_passed",
      passed:
        characterQa.status === "passed" &&
        characterQaRun !== null &&
        characterQaRun.status === "passed" &&
        characterQaRun.characterId === project?.characterId &&
        characterQaRun.projectId === release.projectId &&
        characterQaRun.characterContentVersionId === release.characterContentVersionId &&
        characterQaRun.evidenceHash === releaseString(characterQa.evidenceHash) &&
        latestCharacterQaRun?.id === characterQaRun.id &&
        (!strictCharacterQa || (
          characterQaProvenanceMatchesRun(characterQa, characterQaRun) &&
          characterQaAuthorityMatched
        )),
      evidence: {
        status: characterQa.status ?? null,
        qaRunId: characterQaRunId,
        // 提案侧按这三项把单一 check 还原成它更细的 blocker 词表，顺序即优先级。
        authorityMatches: characterQaAuthorityMatched,
        evidenceHash: characterQa.evidenceHash ?? null,
        authorityStatus: characterQaRun?.status ?? null,
        latestAuthorityQaRunId: latestCharacterQaRun?.id ?? null,
        latestAuthorityStatus: latestCharacterQaRun?.status ?? null,
        latestAuthorityCreatedAt:
          latestCharacterQaRun?.createdAt.toISOString() ?? null,
        schemaVersion: provenance.schemaVersion ?? null,
        projectVersion: characterQaRun?.projectVersion ?? null,
        visualProfileId: characterQaRun?.visualProfileId ?? null,
        visualProfileVersion: characterQaRun?.visualProfileVersion ?? null,
        visualProfileHash: characterQaRun?.visualProfileHash ?? null,
        referenceSetRevisionId: characterQaRun?.referenceSetRevisionId ?? null,
        referenceSetRevision: characterQaRun?.referenceSetRevision ?? null,
        referenceSetHash: characterQaRun?.referenceSetHash ?? null,
        draftAssetPackHash: characterQaRun?.draftAssetPackHash ?? null,
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
      key: "release_asset_review_authority",
      passed: invalidReviewAuthoritySlots.length === 0,
      evidence: { invalidReviewAuthoritySlots },
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
