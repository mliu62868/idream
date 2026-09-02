import {
  CHARACTER_IDENTITY_APPROVAL_MIN_SCORE,
  characterImageQualificationSchema,
  type CharacterImageQualification,
  type CharacterImageReviewRequest,
} from "@idream/shared/admin";
import type { Prisma } from "@prisma/client";
import { inTransaction, prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import {
  hasHydratableMediaBlobAuthority,
  inspectOperatorUploadAuthority,
  isMediaAssetOperationalForAuthority,
} from "@/server/lib/media-asset-authority";
import { assertMediaAssetCustomerPublishable } from "@/server/lib/media-asset-authority-query";
import type { AdminActor } from "@/server/modules/admin-v2/shared/authority";
import { creativeReviewQuality } from "@/server/modules/admin-v2/shared/creative-review-quality";
import { mediaAssetAuthorityDependencies } from "@/server/modules/admin-v2/shared/media-asset-authority-dependencies";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import { draftAssetRouteEntries, type CharacterDraftAssetPurpose } from "./draft-asset-route-authority";
import {
  lockCharacterGenerationAuthority,
  lockCharacterMediaAssetAuthorities,
} from "./generation-authority-lock";
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
  if (!input.review) {
    blockers.push("review_pending");
    return { qualified: false, blockers } as const;
  }
  if (input.review.decision === "rejected") {
    blockers.push("review_rejected");
    return { qualified: false, blockers } as const;
  }
  const exactDecision =
    input.review.artifactId === input.assetId &&
    (
      input.pinnedReviewDecisionId === undefined ||
      input.pinnedReviewDecisionId === input.review.id
    );
  if (
    input.pinnedReviewDecisionId !== undefined &&
    input.pinnedReviewDecisionId !== input.review.id
  ) {
    blockers.push("review_authority_changed");
  }
  const expectedIdentity = input.bootstrapIdentity ? "unscored" : "passed";
  const commonEvidencePassed =
    exactDecision &&
    input.review.decision === "approved" &&
    input.review.identityConsistency === expectedIdentity &&
    (
      input.bootstrapIdentity ||
      (
        input.review.score !== null &&
        input.review.score >= CHARACTER_IDENTITY_APPROVAL_MIN_SCORE
      )
    );
  if (input.source === "operator_upload") {
    const evidence = importedReviewAuthority(input.review.evidence);
    const visualAuthorityMatches = Boolean(
      evidence &&
      input.currentVisualAuthority &&
      evidence.authority.characterId === input.characterId &&
      evidence.authority.assetId === input.assetId &&
      evidence.authority.visualProfileId ===
        input.currentVisualAuthority.visualProfileId &&
      evidence.authority.visualProfileVersion ===
        input.currentVisualAuthority.visualProfileVersion &&
      evidence.authority.visualProfileHash ===
        input.currentVisualAuthority.visualProfileHash &&
      evidence.authority.referenceSetRevisionId ===
        input.currentVisualAuthority.referenceSetRevisionId &&
      evidence.authority.referenceSetSnapshotHash ===
        input.currentVisualAuthority.referenceSetSnapshotHash,
    );
    if (input.currentVisualAuthority && evidence && !visualAuthorityMatches) {
      blockers.push("visual_authority_changed");
    }
    if (
      !commonEvidencePassed ||
      !evidence ||
      Object.values(evidence.quality).some((passed) => !passed)
    ) {
      blockers.push("review_evidence_incomplete");
    }
    return {
      qualified: blockers.length === 0 && visualAuthorityMatches,
      blockers: [...new Set(blockers)],
    } as const;
  }
  if (
    !commonEvidencePassed ||
    creativeReviewQuality(input.review.evidence) === null ||
    !Object.values(creativeReviewQuality(input.review.evidence) ?? {})
      .every(Boolean)
  ) {
    blockers.push("review_evidence_incomplete");
  }
  return {
    qualified: blockers.length === 0,
    blockers: [...new Set(blockers)],
  } as const;
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
    sourceAuthorityValid: source.sourceAuthorityValid,
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
  const selectedReviewAuthorityChanged = Boolean(
    facts.review && selectedPurposes.some((purpose) =>
      facts.selectedEntries[purpose]?.reviewDecisionId !== facts.review?.id
    ),
  );
  const releaseQualifiedPurposes = selectedPurposes.filter((purpose) => {
    const entry = facts.selectedEntries[purpose];
    if (
      !entry ||
      !selectablePurposes.includes(purpose) ||
      !facts.review ||
      entry.reviewDecisionId !== facts.review.id
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
  const state = facts.review?.decision === "rejected"
    ? "rejected" as const
    : releaseQualifiedPurposes.length > 0
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
    blockers: selectedReviewAuthorityChanged
      ? [...new Set([...reviewAuthority.blockers, "review_authority_changed" as const])]
      : reviewAuthority.blockers,
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
    throw Errors.conflict("Review this image before choosing it for Character operations", {
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
    [
      "reviewDecisionId",
      input.assertedReviewDecisionId,
      qualification.authority.reviewDecisionId,
    ],
  ] as const;
  const stale = assertions.find(([, asserted, canonical]) =>
    asserted !== undefined && asserted !== canonical
  );
  if (stale) {
    throw Errors.conflict("Character image Review authority changed before selection", {
      field: stale[0],
      asserted: stale[1],
      canonical: stale[2],
    });
  }
  if (!qualification.authority.reviewDecisionId) {
    throw Errors.conflict("Character image has no approved Review authority");
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
      reviewDecisionId: qualification.authority.reviewDecisionId,
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
  const review = input.review;
  if (
    review.decision === "approved" &&
    (
      review.identityConsistency !== "passed" ||
      review.score === undefined ||
      review.score < CHARACTER_IDENTITY_APPROVAL_MIN_SCORE ||
      Object.values(review.quality).some((passed) => !passed)
    )
  ) {
    throw Errors.badRequest(
      "An imported Character image approval requires complete Review evidence",
    );
  }
  return inTransaction(db, async (tx) => {
    await lockCharacterGenerationAuthority(tx, input.characterId);
    await lockCharacterMediaAssetAuthorities(tx, [input.assetId]);
    const asset = await tx.mediaAsset.findUnique({ where: { id: input.assetId } });
    const linkedItem = asset
      ? await tx.contentProductionItem.findFirst({
          where: { mediaAssetId: asset.id },
          select: { id: true },
        })
      : null;
    const uploadAuthority = asset ? inspectOperatorUploadAuthority(asset) : null;
    if (
      !asset ||
      asset.characterId !== input.characterId ||
      asset.type !== "image" ||
      asset.deletedAt !== null ||
      asset.safetyStatus !== "passed" ||
      platformPurpose(asset) !== "character_library" ||
      linkedItem !== null ||
      uploadAuthority?.publishable !== true
    ) {
      throw Errors.badRequest(
        "Only an available operator-uploaded Character library image can use this Review path",
      );
    }
    const visualAuthority = await currentVisualAuthority(tx, input.characterId);
    if (!visualAuthority) {
      throw Errors.conflict(
        "Publish a sealed Character visual identity before reviewing imported images",
        { blocker: "visual_authority_missing" },
      );
    }
    const latest = await tx.creativeReviewDecision.findFirst({
      where: { artifactId: asset.id, runItemId: null },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    if (latest?.id !== review.supersedesDecisionId) {
      throw Errors.conflict(
        "Character image Review authority changed before this decision was recorded",
        {
          expectedSupersedesDecisionId:
            review.supersedesDecisionId ?? null,
          latestDecisionId: latest?.id ?? null,
        },
      );
    }
    if (latest) {
      const dependencies = await mediaAssetAuthorityDependencies(tx, asset.id);
      if (dependencies.length > 0) {
        throw Errors.conflict(
          "Remove this image from Character placement and serving before replacing its Review decision",
          { assetId: asset.id, dependencies },
        );
      }
    }
    await assertMediaAssetCustomerPublishable(tx, asset);
    const decision = await tx.creativeReviewDecision.create({
      data: {
        runItemId: null,
        artifactId: asset.id,
        supersedesDecisionId: latest?.id ?? null,
        decision: review.decision,
        identityConsistency: review.identityConsistency,
        score: review.score,
        reason: review.reason,
        evidence: toInputJson({
          quality: review.quality,
          characterImageImport: {
            schemaVersion: CHARACTER_IMAGE_IMPORT_REVIEW_EVIDENCE_SCHEMA,
            source: "operator_upload",
            characterId: input.characterId,
            assetId: asset.id,
            ...visualAuthority,
          },
        }),
        reviewerId: input.actor.id,
      },
    });
    await tx.adminAuditLog.create({
      data: {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: "character.image.review_decided",
        targetType: "media_asset",
        targetId: asset.id,
        reason: review.reason,
        ...(latest
          ? { before: toInputJson({ decisionId: latest.id, decision: latest.decision }) }
          : {}),
        after: toInputJson({
          decisionId: decision.id,
          supersedesDecisionId: decision.supersedesDecisionId,
          decision: decision.decision,
          identityConsistency: decision.identityConsistency,
          score: decision.score,
          visualAuthority,
        }),
        requestId: input.requestId,
      },
    });
    await tx.mainOutboxEvent.create({
      data: {
        eventType: "character.image.review_decided.v1",
        aggregateType: "character",
        aggregateId: input.characterId,
        payload: toInputJson({
          characterId: input.characterId,
          assetId: asset.id,
          decisionId: decision.id,
          supersedesDecisionId: decision.supersedesDecisionId,
          decision: decision.decision,
        }),
      },
    });
    const qualification = (
      await characterImageQualifications(tx, input.characterId, [asset])
    ).get(asset.id);
    if (!qualification) {
      throw Errors.internal("Character image qualification was not projected");
    }
    return {
      characterId: input.characterId,
      assetId: asset.id,
      decisionId: decision.id,
      qualification,
    };
  });
}
