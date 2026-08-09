import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { generationWorkflowDescriptor } from "@/server/modules/generation/generation-catalog";
import { operationalMediaAssetWhere } from "@/server/modules/metric-data-scope";
import { evaluateEditorialReleaseAuthority } from "@/server/modules/ourdream/public-release-authority";
import { jsonRecord as record, jsonStrings as strings } from "../shared/prisma-json";
import {
  characterWorkspaceAnchorLink,
  characterWorkspaceTabLink,
  isVisualBlockerCode,
  visualBlockerDeepLink,
} from "./character-deep-link";
import { characterAssetPack } from "./draft-asset-route-authority";
import { generationSourceVariationAuthority } from "./generation-route-authority";
import { loadCharacterIdentityBootstrapAuthority } from "./identity-bootstrap-authority";
import {
  characterImageReadinessFingerprint,
  type inspectCharacterImageGenerationSource,
} from "./image-readiness-authority";
import { evaluateReleaseReadiness } from "./readiness";
import { CHARACTER_RELEASE_POLICY_VERSION } from "./release-validation";
import { characterVisualProfileSnapshotHash, referenceSetSnapshotHash } from "./release-snapshot";
import { findOperationalGenerationRoute } from "./visual-authority";
import {
  findBootstrapGenerationProfile,
  findIdentityCalibrationGenerationProfiles,
  findRouteEvaluationGenerationProfiles,
  loadCharacterVideoGenerationEstimate,
} from "./workspace-generation-profiles";
import {
  videoSourceAssetDto,
  visualAssetAvailable,
  visualAssetDto,
  visualPoolDtos,
} from "./workspace-visual-assets";

type VisualWorkspaceRelease = {
  id: string;
  version: number;
  snapshotHash: string;
  legacy: boolean;
  status: string;
};

type VisualWorkspaceLook = {
  id: string;
  ownerId: string | null;
  label: string;
  status: string;
  visualProfileId: string | null;
  referenceAssetId: string | null;
  rebasedFromLookId: string | null;
  updatedAt: Date;
};

/**
 * SPEC: 运营台 Visual 面板的全部事实——身份版本、参考集、图池、路线合格证、生图就绪度，
 * 连同它们各自的 deepLink 与阻塞项。
 * INTENT: 这一段是工作台里唯一「自己会长」的部分（十周 34 次改动大半落在这里），所以它
 * 自带取数：调用方只交出角色的既有事实，不需要知道要先查身份版本才能查参考集。返回值里
 * 额外带出 qualifiedRoute，因为 project 的草稿资产要用同一条路线指纹判新旧——这是投影
 * 之间真实的耦合，让它显式出现在签名里，好过让调用方再查一次。
 */
export async function loadCharacterVisualWorkspace(input: {
  readonly characterId: string;
  readonly character: { readonly id: string; readonly imageAssetId: string | null };
  readonly project: {
    readonly id: string;
    readonly version: number;
    readonly draftImageAssetId: string | null;
    readonly draftAssetPack: Prisma.JsonValue;
  };
  readonly serving: {
    readonly state: string;
    readonly currentReleaseId: string | null;
    readonly scheduledReleaseId: string | null;
    readonly version: number;
  } | null;
  readonly releases: readonly VisualWorkspaceRelease[];
  readonly activeLooks: readonly VisualWorkspaceLook[];
  readonly characterImageAvailable: boolean;
  readonly characterImageGenerationSource:
    | Awaited<ReturnType<typeof inspectCharacterImageGenerationSource>>
    | null;
}) {
  const {
    characterId,
    character,
    project,
    serving,
    releases,
    activeLooks,
    characterImageAvailable,
    characterImageGenerationSource,
  } = input;
  const activeIdentity = await prisma.characterVisualProfile.findFirst({
    where: { characterId, status: "active" },
    orderBy: { version: "desc" },
  });
  const activeReferenceSet = activeIdentity ? await prisma.referenceSetRevision.findFirst({
    where: { visualProfileId: activeIdentity.id, status: "active" },
    include: { references: { include: { mediaAsset: true }, orderBy: { position: "asc" } } },
    orderBy: { revision: "desc" },
  }) : null;
  const bootstrapAuthority = await loadCharacterIdentityBootstrapAuthority(prisma, characterId);
  // SPEC: 可选图池 = 这个角色当前所有可用的图，判据与 publishCharacterReferenceSet 的写入
  // 校验完全一致（归属本角色 / 未删除 / 是图片 / 安全通过）。
  // INTENT: 「哪些图能当参考图」是事实不是状态，不需要 anchorAssetIds 或 ReferenceCandidate
  // 再存一份——存了反而把新生成的好图挡在外面。取最近 60 张，够运营挑；已在参考集里的图
  // 由 activeReferenceSet.references 自带，不依赖这个池。
  const visualAsOf = new Date();
  const [
    visualPoolAssets,
    videoSourceAssets,
    routeQualifications,
    qualifiedRoute,
    bootstrapProfile,
    routeEvaluationProfiles,
    identityCalibrationProfiles,
    videoGenerationEstimate,
  ] = await Promise.all([
    prisma.mediaAsset.findMany({
      where: operationalMediaAssetWhere({
        deletedAt: null,
        type: "image",
        safetyStatus: "passed",
        characterId,
      }),
      orderBy: { createdAt: "desc" },
      take: 60,
    }),
    prisma.mediaAsset.findMany({
      where: operationalMediaAssetWhere({
        deletedAt: null,
        type: "image",
        safetyStatus: "passed",
        characterId,
      }),
      orderBy: { createdAt: "desc" },
      take: 60,
    }),
    activeIdentity ? prisma.generationRouteQualification.findMany({
      where: { style: activeIdentity.style },
      orderBy: { evaluatedAt: "desc" },
      take: 20,
    }) : Promise.resolve([]),
    activeIdentity ? findOperationalGenerationRoute(prisma, {
      style: activeIdentity.style,
      policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
      evaluatorVersion: env.GENERATION_ROUTE_EVALUATOR_VERSION,
      at: visualAsOf,
      requiredReferenceCount: activeReferenceSet?.references.length ?? 0,
      requiredReferenceRoles:
        activeReferenceSet?.references.map((reference) => reference.role) ?? [],
    }) : Promise.resolve(null),
    bootstrapAuthority.allowed ? findBootstrapGenerationProfile() : Promise.resolve(null),
    activeIdentity && activeReferenceSet
      ? findRouteEvaluationGenerationProfiles(
          activeReferenceSet.references.map((reference) => reference.role),
        )
      : Promise.resolve([]),
    findIdentityCalibrationGenerationProfiles(),
    loadCharacterVideoGenerationEstimate(),
  ]);
  const projectedRouteQualifications = qualifiedRoute &&
      !routeQualifications.some((qualification) => qualification.id === qualifiedRoute.id)
    ? [qualifiedRoute, ...routeQualifications]
    : routeQualifications;
  const qualificationProfileKey = (profileKey: string, version: number) =>
    `${profileKey}\u0000${version}`;
  const [workflowEntries, routeProfiles] = await Promise.all([
    Promise.all([...new Set(projectedRouteQualifications.map((qualification) => qualification.workflowKey))]
      .map(async (workflowKey) => {
        const descriptor = await generationWorkflowDescriptor(workflowKey);
        return [workflowKey, descriptor] as const;
      })),
    projectedRouteQualifications.length > 0
      ? prisma.generationModelProfile.findMany({
          where: {
            OR: projectedRouteQualifications.map((qualification) => ({
              profileKey: qualification.generationProfileKey,
              version: qualification.generationProfileVersion,
            })),
          },
          select: {
            profileKey: true,
            version: true,
            runnerConfig: true,
          },
        })
      : Promise.resolve([]),
  ]);
  const workflowByKey = new Map(workflowEntries);
  const routeProfileByKey = new Map(routeProfiles.map((profile) => [
    qualificationProfileKey(profile.profileKey, profile.version),
    profile,
  ]));
  const poolAssetById = new Map(visualPoolAssets.map((asset) => [asset.id, asset]));
  // visual.anchors 承载的是**可选图池**（前端 referenceCandidates = anchors ∪ references）。
  // 现在池 = 角色当前所有可用图，运营因此能把任何一张审核通过的新图选进参考集——
  // 这正是原先被 anchorAssetIds 挡住的事。已在参考集里的图由 references 提供，两者去重后展示。
  const anchors = activeIdentity
    ? visualPoolDtos(
        visualPoolAssets.map((asset) => asset.id),
        "identity_anchor",
        poolAssetById,
        characterId,
      )
    : [];
  const references = activeReferenceSet
    ? activeReferenceSet.references.map((reference) =>
        visualAssetDto(reference.mediaAsset, reference.role, characterId, reference)
      )
    : [];
  const visualReadiness = evaluateReleaseReadiness({
    snapshotHash: "visual-workbench",
    currentSnapshotHash: "visual-workbench",
    validatedPolicyVersion: CHARACTER_RELEASE_POLICY_VERSION,
    currentPolicyVersion: CHARACTER_RELEASE_POLICY_VERSION,
    content: { personaComplete: true, openingComplete: true },
    visualIdentity: activeIdentity ? {
      version: activeIdentity.version,
      anchorCount: anchors.filter((asset) => asset.available).length,
      requiredTraitsPresent: [
        activeIdentity.faceTraits,
        activeIdentity.hairTraits,
        activeIdentity.bodyTraits,
        activeIdentity.signatureTraits,
      ].some((traits) => Object.keys(record(traits)).length > 0),
      snapshotSealed: activeIdentity.immutableHash !== null
        && activeIdentity.immutableHash === characterVisualProfileSnapshotHash(activeIdentity),
    } : null,
    referenceSet: activeReferenceSet ? {
      revision: activeReferenceSet.revision,
      status: activeReferenceSet.status,
      snapshotSealed: activeReferenceSet.snapshotHash !== null
        && activeReferenceSet.snapshotHash === referenceSetSnapshotHash(activeReferenceSet),
      availableReferenceCount: activeReferenceSet.references.length > 0 &&
        activeReferenceSet.references.every((item) => visualAssetAvailable(item.mediaAsset, characterId))
          ? activeReferenceSet.references.length
          : 0,
    } : null,
    routeQualification: qualifiedRoute ? { status: qualifiedRoute.result, stale: false } : null,
    characterQa: { status: "passed" },
  });
  // SPEC: 生图（打磨）闸 ≠ 发布闸。这里只保留「没有它就画不出图」的条件。
  // INTENT: 密封 hash（*_unsealed）是内容的派生缓存，它的价值是发布时锁住身份，对生成一张
  // 草稿图没有意义；却曾要求运营「铸一个新版本」才能继续——用改数据的手段去修一个只需重算的
  // 值。发布链仍在 readiness.ts 里检查这两项，打磨阶段不再被它拦住。
  const visualBlockers = visualReadiness.blockers.filter((blocker) =>
    isVisualBlockerCode(blocker.code)
  );
  const currentReleaseForImageReadiness = serving?.currentReleaseId
    ? releases.find((release) => release.id === serving.currentReleaseId) ?? null
    : null;
  const imageReadinessFingerprint = characterImageReadinessFingerprint({
    characterId: character.id,
    characterImageAssetId: character.imageAssetId,
    sourceAsset: characterImageGenerationSource?.authority ?? null,
    projectId: project.id,
    projectVersion: project.version,
    draftImageAssetId: project.draftImageAssetId,
    draftAssetPack: project.draftAssetPack,
    serving: serving ? {
      currentReleaseId: serving.currentReleaseId,
      scheduledReleaseId: serving.scheduledReleaseId,
      version: serving.version,
    } : null,
    currentRelease: currentReleaseForImageReadiness ? {
      id: currentReleaseForImageReadiness.id,
      version: currentReleaseForImageReadiness.version,
      snapshotHash: currentReleaseForImageReadiness.snapshotHash,
    } : null,
    activeIdentity: activeIdentity ? {
      id: activeIdentity.id,
      version: activeIdentity.version,
      immutableHash: activeIdentity.immutableHash,
    } : null,
    activeReferenceSet: activeReferenceSet ? {
      id: activeReferenceSet.id,
      revision: activeReferenceSet.revision,
      snapshotHash: activeReferenceSet.snapshotHash,
    } : null,
  });
  const hasDraftAssetWork =
    project.draftImageAssetId !== null ||
    Object.keys(characterAssetPack(project.draftAssetPack)).length > 0;
  const hasCandidateRelease = releases.some((release) =>
    ["draft", "validating", "in_review", "approved"].includes(release.status)
  );
  const identityBlockerCodes = new Set([
    "visual_identity_missing",
    "visual_anchor_missing",
    "visual_traits_incomplete",
  ]);
  const referenceBlockerCodes = new Set([
    "reference_set_not_active",
    "reference_assets_unavailable",
  ]);
  const routeBlockerCodes = new Set([
    "generation_route_unqualified",
    "generation_route_stale",
  ]);
  const identityBlocked = visualBlockers.some((blocker) =>
    identityBlockerCodes.has(blocker.code)
  );
  const referencesBlocked = visualBlockers.some((blocker) =>
    referenceBlockerCodes.has(blocker.code)
  );
  const routeBlocked = visualBlockers.some((blocker) =>
    routeBlockerCodes.has(blocker.code)
  );
  const automaticLivePortraitRepairEligible = Boolean(
    characterImageAvailable &&
    character.imageAssetId &&
    serving?.state === "live" &&
    currentReleaseForImageReadiness?.legacy === true &&
    currentReleaseForImageReadiness.status === "published" &&
    serving?.currentReleaseId === currentReleaseForImageReadiness.id &&
    serving.scheduledReleaseId === null &&
    !hasDraftAssetWork &&
    !hasCandidateRelease &&
    activeIdentity === null &&
    activeReferenceSet === null &&
    activeLooks.length === 0 &&
    characterImageGenerationSource?.materializable === true
  );
  const editorialAuthority =
    automaticLivePortraitRepairEligible &&
      currentReleaseForImageReadiness &&
      character.imageAssetId
      ? await evaluateEditorialReleaseAuthority(prisma, {
          releaseId: currentReleaseForImageReadiness.id,
          projectionState: "live",
        })
      : null;
  const canAdoptLivePortrait = Boolean(
    automaticLivePortraitRepairEligible &&
    editorialAuthority?.valid === true &&
    editorialAuthority.characterId === characterId &&
    editorialAuthority.assetId === character.imageAssetId,
  );
  const imageReadinessState =
    visualBlockers.length === 0
      ? "ready" as const
      : bootstrapAuthority.allowed
        ? "bootstrap_required" as const
        : !identityBlocked && !referencesBlocked && routeBlocked
          ? "route_pending" as const
          : canAdoptLivePortrait
            ? "repairable" as const
            : "manual_review_required" as const;
  const visual = {
    activeIdentity: activeIdentity ? {
      id: activeIdentity.id,
      version: activeIdentity.version,
      status: activeIdentity.status,
      style: activeIdentity.style,
      identityPrompt: activeIdentity.identityPrompt,
      negativeIdentityPrompt: activeIdentity.negativeIdentityPrompt,
      traits: {
        face: record(activeIdentity.faceTraits),
        hair: record(activeIdentity.hairTraits),
        body: record(activeIdentity.bodyTraits),
        signature: record(activeIdentity.signatureTraits),
        style: record(activeIdentity.styleTraits),
      },
      immutableHash: activeIdentity.immutableHash,
      evidenceState: activeIdentity.evidenceState,
      defaultSeed: activeIdentity.defaultSeed,
      anchorAssetIds: strings(activeIdentity.anchorAssetIds),
      createdFrom: activeIdentity.createdFrom,
      createdAt: activeIdentity.createdAt.toISOString(),
    } : null,
    anchors,
    references,
    videoSources: videoSourceAssets.map((asset) =>
      videoSourceAssetDto(asset, characterId)
    ),
    videoGenerationEstimate,
    activeReferenceSet: activeReferenceSet ? {
      id: activeReferenceSet.id,
      revision: activeReferenceSet.revision,
      status: activeReferenceSet.status,
      selectorVersion: activeReferenceSet.selectorVersion,
      snapshotHash: activeReferenceSet.snapshotHash,
      createdFrom: activeReferenceSet.createdFrom,
      createdAt: activeReferenceSet.createdAt.toISOString(),
      references: activeReferenceSet.references.map((item) => visualAssetDto(item.mediaAsset, item.role, characterId, item)),
    } : null,
    looks: activeLooks.map((look) => ({
      ...look,
      status: look.status === "needs_rebase" ? "needs_rebase" as const : "active" as const,
      updatedAt: look.updatedAt.toISOString(),
    })),
    routeQualifications: projectedRouteQualifications.map((qualification) => {
      const workflow = workflowByKey.get(qualification.workflowKey) ?? null;
      const routeProfile = routeProfileByKey.get(qualificationProfileKey(
        qualification.generationProfileKey,
        qualification.generationProfileVersion,
      ));
      const profileCapabilities = record(
        record(routeProfile?.runnerConfig).capabilities as Prisma.JsonValue | undefined,
      );
      return {
        id: qualification.id,
        routeFingerprint: qualification.routeFingerprint,
        generationProfileKey: qualification.generationProfileKey,
        generationProfileVersion: qualification.generationProfileVersion,
        workflowKey: qualification.workflowKey,
        workflowVersion: qualification.workflowVersion,
        style: qualification.style,
        matrixKey: qualification.matrixKey,
        sampleCount: qualification.sampleCount,
        passCount: qualification.passCount,
        identityMatch: qualification.identityMatch,
        result: qualification.result,
        evidence: record(qualification.evidence),
        policyVersion: qualification.policyVersion,
        evaluatedAt: qualification.evaluatedAt.toISOString(),
        expiresAt: qualification.expiresAt?.toISOString() ?? null,
        stale: qualification.result === "qualified" && qualification.id !== qualifiedRoute?.id,
        identityContract: workflow
          ? {
              maxReferences: workflow.identity.maxReferences,
              acceptedRoles: workflow.identity.acceptedRoles,
              supportsLookReference:
                workflow.identity.supportsLookReference,
              supportsSourceImageWithIdentity:
                workflow.identity.supportsSourceImageWithIdentity,
            }
          : undefined,
        profileCapabilities: routeProfile
          ? {
              referenceImages: profileCapabilities.referenceImages === true,
              initImage: profileCapabilities.initImage === true,
            }
          : undefined,
        sourceVariationAuthority: generationSourceVariationAuthority({
          routeFingerprint: qualification.routeFingerprint,
          routeQualified: qualification.id === qualifiedRoute?.id,
          workflow,
          qualificationWorkflowVersion: qualification.workflowVersion,
          profileCapabilities,
          canonicalReferenceRoles:
            activeReferenceSet?.references.map((reference) => reference.role) ?? [],
          sourceReferenceCount: 1,
        }),
      };
    }),
    routeEvaluation: {
      ready: routeEvaluationProfiles.length > 0,
      blocker: !activeIdentity
        ? "Create and seal a Visual Identity before evaluating an image route."
        : !activeReferenceSet || activeReferenceSet.references.length === 0
          ? "Publish a sealed Reference Set before evaluating an image route."
          : routeEvaluationProfiles.length === 0
            ? "No active reference-capable image profile can consume this Reference Set."
            : null,
      sampleMinimum: 40,
      evaluatorVersion: env.GENERATION_ROUTE_EVALUATOR_VERSION,
      profiles: routeEvaluationProfiles,
    },
    identityCalibration: {
      profiles: identityCalibrationProfiles,
      blocker: identityCalibrationProfiles.length === 0
        ? "No active image route supports identity calibration."
        : null,
    },
    identityBootstrap: {
      state: bootstrapAuthority.state,
      allowed: bootstrapAuthority.allowed,
      nextIdentityVersion: bootstrapAuthority.nextVersion,
      blockers: bootstrapAuthority.blockers,
      profile: bootstrapProfile,
    },
    imageReadiness: {
      state: imageReadinessState,
      fingerprint: imageReadinessFingerprint,
      steps: {
        identity: identityBlocked
          ? canAdoptLivePortrait ? "action_required" : "blocked"
          : "complete",
        references: referencesBlocked
          ? canAdoptLivePortrait ? "action_required" : "blocked"
          : "complete",
        route: routeBlocked ? "platform_pending" : "complete",
      },
      repair: canAdoptLivePortrait && character.imageAssetId
        ? {
            kind: "adopt_live_portrait",
            sourceAssetId: character.imageAssetId,
          }
        : null,
      nextDeepLink: imageReadinessState === "route_pending"
        ? characterWorkspaceAnchorLink(
            characterId,
            "route_qualification_workbench",
          )
        : characterWorkspaceTabLink(characterId, "assets"),
    },
    readiness: {
      ready: visualBlockers.length === 0,
      qualificationPolicyVersion: CHARACTER_RELEASE_POLICY_VERSION,
      blockers: visualBlockers.map((blocker) => ({
        ...blocker,
        deepLink: visualBlockerDeepLink(characterId, blocker.code),
      })),
      productionDeepLink: characterWorkspaceTabLink(characterId, "assets"),
    },
  };
  return { visual, qualifiedRoute };
}
