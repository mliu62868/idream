import { resolveMediaAssetAuthorityMap } from "@/server/lib/media-asset-authority-query";
import {
  characterImageQualificationSchema,
  type CharacterImageQualification,
  type CharacterImageReviewRequest,
} from "@idream/shared/admin";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import {
  hasHydratableMediaBlobAuthority,
  inspectOperatorUploadAuthority,
  isMediaAssetOperationalForAuthority,
} from "@/server/lib/media-asset-authority";
import type { AdminActor } from "@/server/modules/admin-v2/shared/authority";
import { creativeReviewQuality } from "@/server/modules/admin-v2/shared/creative-review-quality";
import { draftAssetRouteEntries, type CharacterDraftAssetPurpose } from "./draft-asset-route-authority";
import {
  characterVisualProfileSnapshotHash,
  referenceSetSnapshotHash,
} from "./release-snapshot";

export const CHARACTER_IMAGE_IMPORT_REVIEW_EVIDENCE_SCHEMA =
  "character-image-import-review-v1";

type CharacterImageDatabase = Prisma.TransactionClient | typeof prisma;

type CharacterImageAsset = Prisma.MediaAssetGetPayload<Record<string, never>>;
type CharacterImageItem = Prisma.ContentProductionItemGetPayload<{
  include: { batch: true; job: true };
}>;
type CharacterImageDecision = Prisma.CreativeReviewDecisionGetPayload<
  Record<string, never>
>;

type CurrentVisualAuthority = {
  readonly visualProfileId: string;
  readonly visualProfileVersion: number;
  readonly visualProfileHash: string;
  readonly referenceSetRevisionId: string;
  readonly referenceSetSnapshotHash: string;
};

type QualificationFacts = {
  readonly asset: CharacterImageAsset;
  readonly item: CharacterImageItem | null;
  readonly review: CharacterImageDecision | null;
  readonly customerPublishable: boolean;
  readonly currentVisualAuthority: CurrentVisualAuthority | null;
  readonly selectedEntries: ReturnType<typeof draftAssetRouteEntries>;
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function platformPurpose(asset: { readonly metadata: unknown }) {
  const metadata = record(asset.metadata);
  const platformAsset = record(metadata.platformAsset);
  return typeof platformAsset.purpose === "string"
    ? platformAsset.purpose
    : typeof metadata.purpose === "string"
      ? metadata.purpose
      : null;
}

export function isCharacterLibraryOperatorUpload(asset: {
  readonly id: string;
  readonly characterId: string | null;
  readonly sourceJobId: string | null;
  readonly storageKey: string | null;
  readonly url: string;
  readonly metadata: unknown;
}) {
  return asset.characterId !== null &&
    asset.sourceJobId === null &&
    platformPurpose(asset) === "character_library" &&
    inspectOperatorUploadAuthority(asset)?.publishable === true;
}

function generatedBootstrapIdentity(item: CharacterImageItem | null) {
  return record(item?.job?.sourceMeta).bootstrapIdentity === true;
}

function importedReviewAuthority(value: unknown) {
  const evidence = record(value);
  const authority = record(evidence.characterImageImport);
  const quality = creativeReviewQuality(evidence.quality);
  if (
    quality === null ||
    authority.schemaVersion !== CHARACTER_IMAGE_IMPORT_REVIEW_EVIDENCE_SCHEMA ||
    authority.source !== "operator_upload" ||
    typeof authority.characterId !== "string" ||
    typeof authority.assetId !== "string" ||
    typeof authority.visualProfileId !== "string" ||
    typeof authority.visualProfileVersion !== "number" ||
    typeof authority.visualProfileHash !== "string" ||
    typeof authority.referenceSetRevisionId !== "string" ||
    typeof authority.referenceSetSnapshotHash !== "string"
  ) {
    return null;
  }
  return { quality, authority };
}

function reviewDto(
  source: CharacterImageQualification["source"],
  review: CharacterImageDecision | null,
) {
  if (!review) return null;
  const quality = source === "operator_upload"
    ? importedReviewAuthority(review.evidence)?.quality ?? null
    : creativeReviewQuality(review.evidence);
  return {
    id: review.id,
    decision: review.decision === "rejected" ? "rejected" as const : "approved" as const,
    identityConsistency:
      review.identityConsistency === "failed"
        ? "failed" as const
        : review.identityConsistency === "unscored"
          ? "unscored" as const
          : "passed" as const,
    score: review.score,
    quality,
    reason: review.reason,
    createdAt: review.createdAt.toISOString(),
  };
}

export function evaluateCharacterImageReviewAuthority(input: {
  readonly source: CharacterImageQualification["source"];
  readonly characterId: string;
  readonly assetId: string;
  readonly assetAvailable: boolean;
  readonly sourceAuthorityValid: boolean;
  readonly bootstrapIdentity: boolean;
  readonly review: {
    readonly id: string;
    readonly artifactId: string;
    readonly decision: string;
    readonly identityConsistency: string;
    readonly score: number | null;
    readonly evidence: unknown;
  } | null;
  readonly pinnedReviewDecisionId?: string | null;
  readonly currentVisualAuthority: CurrentVisualAuthority | null;
}) {
  const blockers: CharacterImageQualification["blockers"][number][] = [];
  if (!input.assetAvailable) blockers.push("asset_unavailable");
  if (!input.sourceAuthorityValid) blockers.push("source_authority_invalid");
  if (input.source === "operator_upload" && !input.currentVisualAuthority) {
    blockers.push("visual_authority_missing");
  }
  // 采用素材本身就是运营的质量选择；历史人工评分不再决定素材能否使用。
  // 自动拦截、所属角色、真实来源和可读取的文件仍由 Main 校验。
  return { qualified: blockers.length === 0, blockers } as const;
}

function sourceFacts(facts: QualificationFacts) {
  const uploadAuthority = inspectOperatorUploadAuthority(facts.asset);
  const operatorUploadDeclared = uploadAuthority !== null ||
    record(facts.asset.metadata).source === "admin_asset_upload";
  if (operatorUploadDeclared) {
    return {
      source: "operator_upload" as const,
      sourceAuthorityValid:
        facts.item === null && isCharacterLibraryOperatorUpload(facts.asset),
      purposes: [
        "character_cover",
        "character_hero",
        "character_chat",
      ] as const,
      bootstrapIdentity: false,
    };
  }
  if (facts.asset.sourceJobId) {
    const item = facts.item;
    const job = item?.job ?? null;
    const purpose = item?.batch.purpose;
    const characterPurpose =
      purpose === "character_cover" ||
      purpose === "character_hero" ||
      purpose === "character_chat"
        ? purpose
        : null;
    return {
      source: "generation" as const,
      sourceAuthorityValid: Boolean(
        item &&
        job &&
        characterPurpose &&
        facts.asset.characterId === item.batch.targetId &&
        item.batch.targetType === "character" &&
        item.mediaAssetId === facts.asset.id &&
        item.jobId === facts.asset.sourceJobId &&
        job.id === facts.asset.sourceJobId &&
        job.characterId === facts.asset.characterId &&
        job.status === "completed" &&
        job.mode === "image" &&
        job.sourceType === "content_production_item" &&
        job.sourceId === item.id,
      ),
      purposes: characterPurpose ? [characterPurpose] : [],
      bootstrapIdentity: generatedBootstrapIdentity(item),
    };
  }
  return {
    source: "legacy" as const,
    sourceAuthorityValid: false,
    purposes: [] as CharacterDraftAssetPurpose[],
    bootstrapIdentity: false,
  };
}

function qualifyCharacterImage(facts: QualificationFacts) {
  const source = sourceFacts(facts);
  const assetAvailable =
    facts.asset.deletedAt === null &&
    facts.asset.type === "image" &&
    facts.asset.safetyStatus === "passed" &&
    isMediaAssetOperationalForAuthority(facts.asset.metadata) &&
    hasHydratableMediaBlobAuthority(facts.asset);
  const reviewAuthority = evaluateCharacterImageReviewAuthority({
    source: source.source,
    characterId: facts.asset.characterId ?? "",
    assetId: facts.asset.id,
    assetAvailable,
    sourceAuthorityValid: source.sourceAuthorityValid && facts.customerPublishable,
    bootstrapIdentity: source.bootstrapIdentity,
    review: facts.review,
    currentVisualAuthority: facts.currentVisualAuthority,
  });
  const selectablePurposes = reviewAuthority.qualified
    ? [...source.purposes]
    : [];
  const selectedPurposes = Object.entries(facts.selectedEntries).flatMap(
    ([purpose, entry]) =>
      entry?.assetId === facts.asset.id
        ? [purpose as CharacterDraftAssetPurpose]
        : [],
  );
  const releaseQualifiedPurposes = selectedPurposes.filter((purpose) => {
    const entry = facts.selectedEntries[purpose];
    if (
      !entry ||
      !selectablePurposes.includes(purpose)
    ) {
      return false;
    }
    if (source.source === "operator_upload") {
      return entry.runId === null &&
        entry.itemId === null &&
        entry.generationJobId === null;
    }
    return Boolean(
      facts.item &&
      entry.runId === facts.item.batchId &&
      entry.itemId === facts.item.id &&
      entry.generationJobId === facts.item.jobId,
    );
  });
  const state = releaseQualifiedPurposes.length > 0
      ? "release_qualified" as const
      : selectedPurposes.length > 0
        ? "selected" as const
        : selectablePurposes.length > 0
          ? "selectable" as const
          : "candidate" as const;
  return characterImageQualificationSchema.parse({
    source: source.source,
    state,
    selectablePurposes,
    selectedPurposes,
    releaseQualifiedPurposes,
    blockers: reviewAuthority.blockers,
    authority: {
      runId: source.source === "generation" ? facts.item?.batchId ?? null : null,
      itemId: source.source === "generation" ? facts.item?.id ?? null : null,
      reviewDecisionId: facts.review?.id ?? null,
      generationJobId:
        source.source === "generation" ? facts.item?.jobId ?? null : null,
    },
    review: reviewDto(source.source, facts.review),
  });
}

async function currentVisualAuthority(
  db: CharacterImageDatabase,
  characterId: string,
): Promise<CurrentVisualAuthority | null> {
  const profile = await db.characterVisualProfile.findFirst({
    where: { characterId, status: "active" },
    orderBy: { version: "desc" },
  });
  if (
    !profile?.immutableHash ||
    profile.immutableHash !== characterVisualProfileSnapshotHash(profile)
  ) {
    return null;
  }
  const referenceSet = await db.referenceSetRevision.findFirst({
    where: { visualProfileId: profile.id, status: "active" },
    orderBy: { revision: "desc" },
    include: {
      references: { orderBy: { position: "asc" } },
    },
  });
  if (
    !referenceSet?.snapshotHash ||
    referenceSet.references.length === 0 ||
    referenceSet.snapshotHash !== referenceSetSnapshotHash(referenceSet)
  ) {
    return null;
  }
  return {
    visualProfileId: profile.id,
    visualProfileVersion: profile.version,
    visualProfileHash: profile.immutableHash,
    referenceSetRevisionId: referenceSet.id,
    referenceSetSnapshotHash: referenceSet.snapshotHash,
  };
}

async function loadQualificationFacts(
  db: CharacterImageDatabase,
  characterId: string,
  assets: readonly CharacterImageAsset[],
) {
  const assetIds = assets.map((asset) => asset.id);
  if (assetIds.length === 0) return [];
  const items = await db.contentProductionItem.findMany({
    where: { mediaAssetId: { in: assetIds } },
    include: { batch: true, job: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const itemByAssetId = new Map<string, CharacterImageItem>();
  for (const item of items) {
    if (item.mediaAssetId && !itemByAssetId.has(item.mediaAssetId)) {
      itemByAssetId.set(item.mediaAssetId, item);
    }
  }
  const itemIds = items.map((item) => item.id);
  const decisions = await db.creativeReviewDecision.findMany({
    where: {
      OR: [
        ...(itemIds.length > 0 ? [{ runItemId: { in: itemIds } }] : []),
        { runItemId: null, artifactId: { in: assetIds } },
      ],
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const generatedDecisionByItemId = new Map<string, CharacterImageDecision>();
  const uploadDecisionByAssetId = new Map<string, CharacterImageDecision>();
  for (const decision of decisions) {
    if (decision.runItemId) {
      if (!generatedDecisionByItemId.has(decision.runItemId)) {
        generatedDecisionByItemId.set(decision.runItemId, decision);
      }
    } else if (!uploadDecisionByAssetId.has(decision.artifactId)) {
      uploadDecisionByAssetId.set(decision.artifactId, decision);
    }
  }
  // This module also runs inside interactive transactions. Keep reads serial:
  // one Prisma transaction adapter owns one pg client.
  const visualAuthority = await currentVisualAuthority(db, characterId);
  const project = await db.characterProject.findFirst({
    where: { characterId },
    orderBy: { updatedAt: "desc" },
    select: { draftAssetPack: true },
  });
  const selectedEntries = draftAssetRouteEntries(project?.draftAssetPack ?? {});
  const publishability = await resolveMediaAssetAuthorityMap(db, assets);
  return assets.map((asset) => {
    const item = itemByAssetId.get(asset.id) ?? null;
    const source = asset.sourceJobId ? "generation" : "operator_upload";
    const review = source === "generation" && item
      ? generatedDecisionByItemId.get(item.id) ?? null
      : uploadDecisionByAssetId.get(asset.id) ?? null;
    return {
      asset,
      item,
      review,
      customerPublishable: publishability.get(asset.id)?.publishable === true,
      currentVisualAuthority: visualAuthority,
      selectedEntries,
    } satisfies QualificationFacts;
  });
}

export async function characterImageQualifications(
  db: CharacterImageDatabase,
  characterId: string,
  assets: readonly CharacterImageAsset[],
) {
  const facts = await loadQualificationFacts(db, characterId, assets);
  return new Map(
    facts.map((entry) => [entry.asset.id, qualifyCharacterImage(entry)] as const),
  );
}

export async function resolveSelectableCharacterImage(
  tx: Prisma.TransactionClient,
  input: {
    readonly characterId: string;
    readonly assetId: string;
    readonly purpose: CharacterDraftAssetPurpose;
    readonly assertedRunId?: string;
    readonly assertedItemId?: string;
    readonly assertedReviewDecisionId?: string;
  },
) {
  const asset = await tx.mediaAsset.findUnique({ where: { id: input.assetId } });
  if (!asset || asset.characterId !== input.characterId) {
    throw Errors.badRequest("Choose an image from this Character's library");
  }
  const facts = (await loadQualificationFacts(tx, input.characterId, [asset]))[0];
  if (!facts) throw Errors.notFound("Character image qualification not found");
  const qualification = qualifyCharacterImage(facts);
  if (!qualification.selectablePurposes.includes(input.purpose)) {
    throw Errors.conflict("图片不可采用，请检查文件、来源和用途", {
      assetId: asset.id,
      purpose: input.purpose,
      state: qualification.state,
      blockers: qualification.blockers.includes("purpose_mismatch")
        ? qualification.blockers
        : [...qualification.blockers, "purpose_mismatch"],
    });
  }
  const assertions = [
    ["runId", input.assertedRunId, qualification.authority.runId],
    ["itemId", input.assertedItemId, qualification.authority.itemId],
  ] as const;
  const stale = assertions.find(([, asserted, canonical]) =>
    asserted !== undefined && asserted !== canonical
  );
  if (stale) {
    throw Errors.conflict("Character image source changed before selection", {
      field: stale[0],
      asserted: stale[1],
      canonical: stale[2],
    });
  }
  const sourceMeta = record(facts.item?.job?.sourceMeta);
  return {
    asset,
    qualification,
    entry: {
      assetId: asset.id,
      ...(qualification.authority.runId
        ? { runId: qualification.authority.runId }
        : {}),
      ...(qualification.authority.itemId
        ? { itemId: qualification.authority.itemId }
        : {}),
      ...(qualification.authority.reviewDecisionId
        ? { reviewDecisionId: qualification.authority.reviewDecisionId }
        : {}),
      ...(qualification.authority.generationJobId
        ? { generationJobId: qualification.authority.generationJobId }
        : {}),
      ...(typeof sourceMeta.generationRouteFingerprint === "string"
        ? { generationRouteFingerprint: sourceMeta.generationRouteFingerprint }
        : {}),
      ...(sourceMeta.bootstrapIdentity === true
        ? { bootstrapIdentity: true }
        : {}),
    },
  };
}

export async function reviewImportedCharacterImage(
  input: {
    readonly characterId: string;
    readonly assetId: string;
    readonly actor: AdminActor;
    readonly review: CharacterImageReviewRequest;
    readonly requestId: string;
  },
  db?: Prisma.TransactionClient,
) {
  void input;
  void db;
  throw Errors.conflict("Manual asset reviews are retired; select the image directly", {
    code: "manual_asset_review_retired",
  });
}
