// SPEC: Visual Passport 编辑器 —— 角色视觉身份档案（CharacterVisualProfile）的版本列表 +
//       铸造新 active 版本。
// INTENT: 不复用 ourdream/service.ts 的 createActiveCharacterVisualProfileVersion —— 那条路
//         通过 buildCharacterIdentityPrompt 从角色资料重新派生 identityPrompt 且不接受显式覆盖；
//         而本编辑器的目的恰恰是让运营直接编辑 identityPrompt/negativeIdentityPrompt/traits/style/seed。
// INVARIANTS:
//   - 读用 content.read；写用 content.official.write（与官方角色 CMS 的视觉身份编辑同一把权限）。
//   - POST 要求 confirmation===`${characterId}:visual-profile`。
//   - 锚点只读继承当前 active Visual Profile；参考图只读继承当前 active Reference Set，
//     避免已从 Rn 清退的历史图被带入 Vn+1。
//   - archive 旧 active 与创建新 active 必须在同一事务内完成。
import type { Prisma } from "@prisma/client";
import type { CharacterVisualProfileCreateRequest } from "@idream/shared/admin";
import { parseSingleContinuousFrameEvidence } from "@idream/shared/media/generated-image-sanity";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { isMediaAssetOperationalForAuthority } from "@/server/lib/media-asset-authority";
import {
  IDENTITY_ASSEMBLER_VERSION,
  assembleIdentityPrompt,
  toTraitRecord,
  traitsHashOf,
  type IdentityTraits,
} from "@/server/modules/ourdream/identity-assembler";
import { invalidateCharacterDraftAssetPack } from "../characters/draft-asset-authority";
import {
  lockCharacterGenerationAuthority,
  lockCharacterMediaAssetAuthorities,
} from "../characters/generation-authority-lock";
import { characterReferenceAuthorityFrom } from "../characters/reference-authority";
import {
  characterVisualProfileSnapshotHash,
  referenceSetSnapshotHash,
} from "../characters/release-snapshot";
import type { AdminActor } from "../shared/authority";
import { creativeReviewQualityPassed } from "../shared/creative-review-quality";
import { toInputJson } from "../shared/prisma-json";
import { contentAuditData } from "./audit";

// 注：faceTraits/hairTraits/bodyTraits/signatureTraits/styleTraits 额外纳入 select ——
// 面板要求"当前 active 的 traits 只读 JSON 视图"，而这些字段正是 traits 本体。
// adapterRefs 只用于服务端计算 identitySource/identityStale，响应前会被剥离——
// 面板不展示 LoRA/adapter 之类的生成模型接线细节，只展示派生出的只读徽标。
const visualProfileSelect = {
  id: true,
  version: true,
  status: true,
  style: true,
  identityPrompt: true,
  negativeIdentityPrompt: true,
  faceTraits: true,
  hairTraits: true,
  bodyTraits: true,
  signatureTraits: true,
  styleTraits: true,
  defaultSeed: true,
  anchorAssetIds: true,
  qualityScore: true,
  consistencyScore: true,
  createdFrom: true,
  createdAt: true,
  adapterRefs: true,
} as const;

type SelectedVisualProfile = Prisma.CharacterVisualProfileGetPayload<{
  select: typeof visualProfileSelect;
}>;

function jsonStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function reviewedIdentityCandidate(
  tx: Prisma.TransactionClient,
  input: {
    readonly characterId: string;
    readonly authority: NonNullable<
      CharacterVisualProfileCreateRequest["candidateAuthority"]
    >;
  },
) {
  const item = await tx.contentProductionItem.findFirst({
    where: {
      id: input.authority.itemId,
      batchId: input.authority.runId,
      mediaAssetId: input.authority.assetId,
    },
    include: { batch: true, mediaAsset: true, job: true },
  });
  const experiment = jsonRecord(item?.job?.sourceMeta).identityExperiment;
  if (
    !item ||
    item.batch.purpose !== "identity_calibration" ||
    item.batch.targetType !== "character" ||
    item.batch.targetId !== input.characterId ||
    item.status !== "approved" ||
    !item.mediaAsset ||
    item.mediaAsset.characterId !== input.characterId ||
    item.mediaAsset.type !== "image" ||
    item.mediaAsset.deletedAt !== null ||
    item.mediaAsset.safetyStatus !== "passed" ||
    !isMediaAssetOperationalForAuthority(item.mediaAsset.metadata) ||
    !item.job ||
    item.job.status !== "completed" ||
    item.job.characterId !== input.characterId ||
    item.job.sourceType !== "content_production_item" ||
    item.job.sourceId !== item.id ||
    item.mediaAsset.sourceJobId !== item.job.id ||
    experiment === null ||
    typeof experiment !== "object" ||
    Array.isArray(experiment)
  ) {
    throw Errors.conflict(
      "The selected image is not a completed identity-calibration candidate for this Character",
      { deepLink: `/admin/characters/${input.characterId}?tab=visual` },
    );
  }
  const decision = await tx.creativeReviewDecision.findFirst({
    where: {
      id: input.authority.reviewDecisionId,
      runItemId: item.id,
      artifactId: item.mediaAsset.id,
    },
  });
  const latestDecision = await tx.creativeReviewDecision.findFirst({
    where: { runItemId: item.id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true },
  });
  if (
    !decision ||
    latestDecision?.id !== decision.id ||
    decision.decision !== "approved" ||
    decision.identityConsistency !== "unscored" ||
    !creativeReviewQualityPassed(decision.evidence)
  ) {
    throw Errors.conflict(
      "The identity candidate requires the latest approved identity-defining review with complete visible evidence",
      { deepLink: `/admin/characters/${input.characterId}?tab=visual` },
    );
  }
  const assetQuality = jsonRecord(item.mediaAsset.metadata).quality;
  const decisionEvidence = jsonRecord(decision.evidence);
  if (
    !parseSingleContinuousFrameEvidence(assetQuality) ||
    !parseSingleContinuousFrameEvidence(decisionEvidence.automaticComposition)
  ) {
    throw Errors.conflict(
      "The identity candidate requires current system and human review evidence before activation",
      {
        code: "identity_candidate_evidence_incomplete",
        deepLink: `/admin/characters/${input.characterId}?tab=visual`,
      },
    );
  }
  const existingPromotion = await tx.referenceCandidate.findFirst({
    where: {
      mediaAssetId: item.mediaAsset.id,
      sourceJobId: item.job.id,
      status: "promoted",
    },
    select: { visualProfileId: true },
  });
  if (existingPromotion) {
    throw Errors.conflict("This identity-calibration candidate has already been promoted", {
      visualProfileId: existingPromotion.visualProfileId,
      deepLink: `/admin/characters/${input.characterId}?tab=visual`,
    });
  }
  return { item, decision };
}

function currentTraitsOf(profile: SelectedVisualProfile): IdentityTraits {
  return {
    face: toTraitRecord(profile.faceTraits),
    hair: toTraitRecord(profile.hairTraits),
    body: toTraitRecord(profile.bodyTraits),
    signature: toTraitRecord(profile.signatureTraits),
    style: toTraitRecord(profile.styleTraits),
  };
}

// adapterRefs.identity 缺失（历史行 / 未接线）视为 manual，恒不 stale——保守默认，不倒扣历史数据。
function visualProfileDTO(profile: SelectedVisualProfile) {
  const { adapterRefs, createdAt, ...rest } = profile;
  const identity =
    adapterRefs && typeof adapterRefs === "object" && "identity" in adapterRefs
      ? (adapterRefs as { identity?: unknown }).identity
      : undefined;
  const source =
    identity &&
    typeof identity === "object" &&
    (identity as { source?: unknown }).source === "derived"
      ? "derived"
      : "manual";
  const storedHash =
    identity &&
    typeof identity === "object" &&
    typeof (identity as { traitsHash?: unknown }).traitsHash === "string"
      ? (identity as { traitsHash: string }).traitsHash
      : undefined;
  const identityStale =
    source === "derived" && storedHash !== undefined
      ? traitsHashOf(currentTraitsOf(profile)) !== storedHash
      : false;
  return {
    ...rest,
    createdAt: createdAt.toISOString(),
    identitySource: source as "derived" | "manual",
    identityStale,
  };
}

export async function listCharacterVisualProfiles(characterId: string) {
  const character = await prisma.character.findUnique({
    where: { id: characterId },
    select: { id: true },
  });
  if (!character) throw Errors.notFound("Character not found");

  const items = await prisma.characterVisualProfile.findMany({
    where: { characterId },
    orderBy: { version: "desc" },
    select: visualProfileSelect,
  });
  return { items: items.map(visualProfileDTO) };
}

export async function createCharacterVisualProfile(input: {
  tx: Prisma.TransactionClient;
  request: Request;
  actor: AdminActor;
  characterId: string;
  body: CharacterVisualProfileCreateRequest;
}) {
  const { tx, request, actor, characterId, body } = input;
  if (body.confirmation !== `${characterId}:visual-profile`) {
    throw Errors.badRequest("Confirmation did not match visual profile target");
  }

  await lockCharacterGenerationAuthority(tx, characterId);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`character-identity-bootstrap:${characterId}`}))`;
  const project = await tx.characterProject.findFirst({
    where: { characterId },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    select: { id: true },
  });
  const activeRelease = project
    ? await tx.characterRelease.findFirst({
        where: {
          projectId: project.id,
          status: { in: ["draft", "validating", "in_review", "approved"] },
        },
        select: { id: true, status: true },
      })
    : null;
  if (activeRelease) {
    throw Errors.conflict(
      "Withdraw or finish the active Character Release before creating a new Visual Identity version",
      {
        releaseId: activeRelease.id,
        releaseStatus: activeRelease.status,
        deepLink: `/admin/characters/${characterId}?tab=release`,
      },
    );
  }
  const discoveredCharacter = await tx.character.findUnique({
    where: { id: characterId },
    select: { id: true, imageAssetId: true },
  });
  if (!discoveredCharacter) throw Errors.notFound("Character not found");
  const discoveredActive = await tx.characterVisualProfile.findFirst({
    where: { characterId, status: "active" },
    orderBy: { version: "desc" },
  });
  const discoveredAnchorAssetIds = discoveredActive
    ? jsonStringArray(discoveredActive.anchorAssetIds)
    : [];
  const discoveredReferenceSet = discoveredActive
    ? await tx.referenceSetRevision.findFirst({
        where: { visualProfileId: discoveredActive.id, status: "active" },
        select: {
          id: true,
          references: { select: { mediaAssetId: true }, orderBy: { position: "asc" } },
        },
        orderBy: { revision: "desc" },
      })
    : null;
  // 参考集只认 active Reference Set；没有它就是没有参考集，不再回退读 profile 影子列
  // （下面的 fallbackImageAssetId 会用角色主图兜底，与 inherited 阶段口径一致）。
  const discoveredReferenceAssetIds = discoveredReferenceSet
    ? discoveredReferenceSet.references.map((reference) => reference.mediaAssetId)
    : [];
  const discoveredFallbackImageAssetId =
    !body.candidateAuthority &&
    discoveredAnchorAssetIds.length === 0 &&
    discoveredReferenceAssetIds.length === 0
      ? discoveredCharacter.imageAssetId
      : null;
  const discoveredMediaAssetIds = body.candidateAuthority
    ? [body.candidateAuthority.assetId]
    : [
        ...new Set([
          ...discoveredAnchorAssetIds,
          ...discoveredReferenceAssetIds,
          ...(discoveredFallbackImageAssetId ? [discoveredFallbackImageAssetId] : []),
        ]),
      ];
  await lockCharacterMediaAssetAuthorities(tx, discoveredMediaAssetIds);

  const character = await tx.character.findUnique({
    where: { id: characterId },
    select: { id: true, imageAssetId: true },
  });
  if (!character) throw Errors.notFound("Character not found");
  const active = await tx.characterVisualProfile.findFirst({
    where: { characterId, status: "active" },
    orderBy: { version: "desc" },
  });
  if ((active?.id ?? null) !== (discoveredActive?.id ?? null)) {
    throw Errors.conflict(
      "Visual Identity authority changed while its media assets were being locked",
      { deepLink: `/admin/characters/${characterId}?tab=visual` },
    );
  }
  const activeReferenceSet = active
    ? await tx.referenceSetRevision.findFirst({
        where: { visualProfileId: active.id, status: "active" },
        select: {
          id: true,
          revision: true,
          selectorVersion: true,
          references: {
            select: {
              mediaAssetId: true, role: true, position: true,
              weight: true, qualityScore: true,
            },
            orderBy: { position: "asc" },
          },
        },
        orderBy: { revision: "desc" },
      })
    : null;
  if ((activeReferenceSet?.id ?? null) !== (discoveredReferenceSet?.id ?? null)) {
    throw Errors.conflict(
      "Reference Set authority changed while its media assets were being locked",
      { deepLink: `/admin/characters/${characterId}?tab=visual` },
    );
  }
  // 锚点与参考图都取自 active Reference Set（唯一权威）。没有 revision 就是没有可继承的参考集，
  // 交给下面的主图兜底。
  const inheritedAuthority = characterReferenceAuthorityFrom(activeReferenceSet);
  const activeAnchorAssetIds = [...(inheritedAuthority?.anchors ?? [])];
  const inheritedReferenceAssetIds = [...(inheritedAuthority?.refs ?? [])];
  const fallbackImageAssetId =
    !body.candidateAuthority &&
    activeAnchorAssetIds.length === 0 && inheritedReferenceAssetIds.length === 0
      ? character.imageAssetId
      : null;
  const inheritedMediaAssetIds = body.candidateAuthority
    ? [body.candidateAuthority.assetId]
    : [
        ...new Set([
          ...activeAnchorAssetIds,
          ...inheritedReferenceAssetIds,
          ...(fallbackImageAssetId ? [fallbackImageAssetId] : []),
        ]),
      ];
  const discoveredMediaAssetIdSet = new Set(discoveredMediaAssetIds);
  if (inheritedMediaAssetIds.some((assetId) => !discoveredMediaAssetIdSet.has(assetId))) {
    throw Errors.conflict(
      "Character image authority changed while its media assets were being locked",
      { deepLink: `/admin/characters/${characterId}?tab=assets` },
    );
  }
  const inheritedMediaAssets = inheritedMediaAssetIds.length > 0
    ? await tx.mediaAsset.findMany({
        where: { id: { in: inheritedMediaAssetIds } },
        select: {
          id: true,
          characterId: true,
          type: true,
          deletedAt: true,
          safetyStatus: true,
          metadata: true,
        },
      })
    : [];
  const inheritedMediaAssetById = new Map(
    inheritedMediaAssets.map((asset) => [asset.id, asset] as const),
  );
  if (fallbackImageAssetId) {
    const fallbackAsset = inheritedMediaAssetById.get(fallbackImageAssetId);
    const fallbackOperational =
      fallbackAsset?.type === "image" &&
      fallbackAsset.deletedAt === null &&
      fallbackAsset.safetyStatus === "passed" &&
      isMediaAssetOperationalForAuthority(fallbackAsset.metadata);
    if (fallbackAsset?.characterId === null && fallbackOperational) {
      const characterReferences = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "characters"
        WHERE "imageAssetId" = ${fallbackImageAssetId}
        ORDER BY "id"
        FOR UPDATE
      `;
      if (
        characterReferences.length !== 1 ||
        characterReferences[0]?.id !== characterId
      ) {
        throw Errors.conflict(
          "The current Character image is shared and cannot become this Character's identity authority",
          { deepLink: `/admin/characters/${characterId}?tab=assets` },
        );
      }
      const claimed = await tx.mediaAsset.updateMany({
        where: { id: fallbackImageAssetId, characterId: null },
        data: { characterId },
      });
      if (claimed.count !== 1) {
        throw Errors.conflict(
          "The current Character image changed while identity ownership was being repaired",
          { deepLink: `/admin/characters/${characterId}?tab=assets` },
        );
      }
      inheritedMediaAssetById.set(fallbackImageAssetId, {
        ...fallbackAsset,
        characterId,
      });
    }
  }
  const invalidInheritedAssetIds = inheritedMediaAssetIds.filter((assetId) => {
    const asset = inheritedMediaAssetById.get(assetId);
    return (
      !asset ||
      asset.characterId !== characterId ||
      asset.type !== "image" ||
      asset.deletedAt !== null ||
      asset.safetyStatus !== "passed" ||
      !isMediaAssetOperationalForAuthority(asset.metadata)
    );
  });
  if (invalidInheritedAssetIds.length > 0) {
    throw Errors.conflict(
      "Repair archived, unsafe, unavailable, or foreign identity media before creating a new Visual Identity version",
      {
        assetIds: invalidInheritedAssetIds,
        deepLink: `/admin/characters/${characterId}?tab=assets`,
      },
    );
  }
  const candidate = body.candidateAuthority
    ? await reviewedIdentityCandidate(tx, {
        characterId,
        authority: body.candidateAuthority,
      })
    : null;
  const inheritedAnchorAssetIds = candidate
    ? [candidate.item.mediaAsset!.id]
    : activeAnchorAssetIds.length > 0
      ? activeAnchorAssetIds
      : fallbackImageAssetId
        ? [fallbackImageAssetId]
        : [];
  if (inheritedAnchorAssetIds.length === 0 && inheritedReferenceAssetIds.length === 0) {
    throw Errors.conflict(
      "Establish a reviewed portrait anchor in Character Assets before creating identity versions",
      { deepLink: `/admin/characters/${characterId}?tab=assets` },
    );
  }
  if (active) {
    await tx.characterVisualProfile.updateMany({
      where: { characterId, status: "active" },
      data: { status: "archived" },
    });
  }
  // 锚点（候选图池）继承 active identity；参考集本身由下面的 nextReferences 建成新的
  // Reference Set revision，profile 上不再留副本。
  const anchorAssetIds = inheritedAnchorAssetIds;
  const version = (active?.version ?? 0) + 1;

  const faceTraits = body.faceTraits ?? active?.faceTraits ?? {};
  const hairTraits = body.hairTraits ?? active?.hairTraits ?? {};
  const bodyTraits = body.bodyTraits ?? active?.bodyTraits ?? {};
  const signatureTraits = body.signatureTraits ?? active?.signatureTraits ?? {};
  const styleTraits = body.styleTraits ?? active?.styleTraits ?? {};

  // identityPrompt 显式给出 → 原样存 + manual（运营意志优先，不强制重派生）；
  // 缺省 → 由当前 traits（body 覆盖，缺省继承 active）派生 + derived，traitsHash 一并落盘
  // 供后续读时做 staleness 自检（见 visualProfileDTO）。
  const traits: IdentityTraits = {
    face: toTraitRecord(faceTraits),
    hair: toTraitRecord(hairTraits),
    body: toTraitRecord(bodyTraits),
    signature: toTraitRecord(signatureTraits),
    style: toTraitRecord(styleTraits),
  };
  const derived = assembleIdentityPrompt(traits);
  const identityPrompt = body.identityPrompt ?? derived.identityPrompt;
  const negativeIdentityPrompt =
    body.negativeIdentityPrompt ?? active?.negativeIdentityPrompt ?? null;
  const style = body.style ?? active?.style ?? "realistic";
  const source = body.identityPrompt ? "manual" : "derived";
  const traitsHash = body.identityPrompt ? traitsHashOf(traits) : derived.traitsHash;

  const created = await tx.characterVisualProfile.create({
    data: {
      characterId,
      version,
      status: "active",
      style,
      identityPrompt,
      negativeIdentityPrompt,
      faceTraits: toInputJson(faceTraits),
      hairTraits: toInputJson(hairTraits),
      bodyTraits: toInputJson(bodyTraits),
      signatureTraits: toInputJson(signatureTraits),
      styleTraits: toInputJson(styleTraits),
      anchorAssetIds: toInputJson(anchorAssetIds),
      defaultSeed:
        body.defaultSeed ?? candidate?.item.job!.seed ?? active?.defaultSeed ?? null,
      adapterRefs: toInputJson({
        identity: {
          traitsHash,
          assemblerVersion: IDENTITY_ASSEMBLER_VERSION,
          source,
        },
        ...(candidate ? {
          identityCalibration: {
            runId: candidate.item.batch.id,
            itemId: candidate.item.id,
            reviewDecisionId: candidate.decision.id,
            generationJobId: candidate.item.job!.id,
          },
        } : {}),
      }),
      immutableHash: characterVisualProfileSnapshotHash({
        version,
        style,
        identityPrompt,
        negativeIdentityPrompt,
        faceTraits: toInputJson(faceTraits),
        hairTraits: toInputJson(hairTraits),
        bodyTraits: toInputJson(bodyTraits),
        signatureTraits: toInputJson(signatureTraits),
        styleTraits: toInputJson(styleTraits),
      }),
      evidenceState: candidate ? "reviewed_bootstrap" : "candidate",
      createdFrom: candidate
        ? `identity_calibration:${candidate.item.job!.id}`
        : "admin_passport_edit",
    },
    select: visualProfileSelect,
  });
  // INVARIANT: 每个 Visual Identity 版本都必须带一个 active Reference Set。
  // 只改提示词不该改图，所以原样继承上一版的 references（role/position/weight 全部照搬）；
  // 连上一版都没有时，用已校验过的锚点（含角色主图兜底）建首版。
  const inheritedRows = activeReferenceSet?.references ?? [];
  const nextReferences = candidate
    ? [{
        mediaAssetId: candidate.item.mediaAsset!.id,
        position: 0,
        role: "primary_face",
        weight: 1,
        qualityScore: candidate.decision.score,
      }]
    : inheritedRows.length > 0
      ? inheritedRows.map((reference) => ({ ...reference }))
      : anchorAssetIds.map((mediaAssetId, index) => ({
          mediaAssetId,
          position: index,
          role: index === 0 ? "primary_face" : "identity_anchor",
          weight: 1,
          qualityScore: null,
        }));
  const selectorVersion = candidate
    ? "identity-calibration-v1"
    : inheritedRows.length > 0
      ? activeReferenceSet!.selectorVersion
      : "identity-anchor-v1";
  const createdFrom = candidate
    ? `identity_calibration:${candidate.item.job!.id}`
    : inheritedRows.length > 0
      ? `identity_version_inherit:${activeReferenceSet!.id}`
      : "identity_anchor_bootstrap";
  const referenceSet = await tx.referenceSetRevision.create({
    data: {
      visualProfileId: created.id,
      revision: 1,
      status: "active",
      selectorVersion,
      createdFrom,
      snapshotHash: referenceSetSnapshotHash({
        visualProfileId: created.id,
        revision: 1,
        selectorVersion,
        references: nextReferences,
      }),
      references: {
        create: nextReferences.map((reference) => ({
          ...reference,
          selectorVersion,
          selectionReason: body.reason,
        })),
      },
    },
  });
  if (candidate) {
    const mediaAssetId = candidate.item.mediaAsset!.id;
    await tx.referenceCandidate.create({
      data: {
        visualProfileId: created.id,
        mediaAssetId,
        sourceJobId: candidate.item.job!.id,
        proposedRole: "primary_face",
        qualityScore: candidate.decision.score,
        identityScore: null,
        source: "identity_calibration",
        status: "promoted",
        promotedRevisionId: referenceSet.id,
      },
    });
  }
  const invalidatedDraftAssets = await invalidateCharacterDraftAssetPack(tx, characterId);
  await tx.adminAuditLog.create({
    data: contentAuditData(request, actor, {
      action: "content.visual_profile.create",
      targetType: "character",
      targetId: characterId,
      reason: body.reason,
      before: invalidatedDraftAssets ? {
        draftAssetPackProjectId: invalidatedDraftAssets.projectId,
        draftAssetPackVersion: invalidatedDraftAssets.previousVersion,
        draftAssetPurposes: invalidatedDraftAssets.invalidatedPurposes,
        draftAssetIds: invalidatedDraftAssets.invalidatedAssetIds,
      } : undefined,
      after: {
        visualProfileId: created.id,
        version: created.version,
        status: created.status,
        candidateAuthority: body.candidateAuthority ?? null,
        draftAssetPackVersion: invalidatedDraftAssets?.nextVersion ?? null,
      },
    }),
  });
  return { item: visualProfileDTO(created) };
}
