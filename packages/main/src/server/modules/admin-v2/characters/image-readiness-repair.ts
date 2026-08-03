import type { Prisma } from "@prisma/client";
import {
  CHARACTER_CANONICAL_PORTRAIT_IDENTITY_PROMPT,
  type CharacterImageReadinessRepairRequest,
} from "@idream/shared/admin";
import { env } from "@/server/lib/env";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import {
  hasHydratableMediaBlobAuthority,
  isMediaAssetOperationalForAuthority,
} from "@/server/lib/media-asset-authority";
import { providers } from "@/server/providers";
import type { AdminActor } from "@/server/modules/admin-v2/shared/authority";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import {
  evaluateEditorialReleaseAuthorityInTransaction,
} from "@/server/modules/ourdream/public-release-authority";
import { draftAssetRouteEntries } from "./draft-asset-route-authority";
import { invalidateCharacterDraftAssetPack } from "./draft-asset-authority";
import {
  lockCharacterGenerationAndMediaAssetAuthorities,
} from "./generation-authority-lock";
import {
  characterImageReadinessFingerprint,
  inspectCharacterImageGenerationSource,
  type CharacterImageAssetAuthority,
} from "./image-readiness-authority";
import { canonicalSha256 } from "../shared/canonical-json";
import { CHARACTER_RELEASE_POLICY_VERSION } from "./release-executor";
import {
  characterVisualProfileSnapshotHash,
  referenceSetSnapshotHash,
} from "./release-snapshot";
import { findOperationalGenerationRoute } from "./visual-authority";
import { characterReferenceAuthorityFrom } from "./reference-authority";
import { characterWorkspaceTabLink } from "./character-deep-link";
import { CHARACTER_STYLES, isCatalogMember } from "@idream/shared/catalog";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string =>
        typeof item === "string" && item.trim().length > 0
      )
    : [];
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function visualStyle(value: unknown) {
  return isCatalogMember(CHARACTER_STYLES, value) ? value : "realistic";
}

export const EDITORIAL_VISUAL_IDENTITY_REPAIR_VERSION = 2;

export function buildEditorialPortraitIdentity(input: {
  readonly characterName: string;
  readonly characterStyle: unknown;
  readonly appearanceSnapshot: unknown;
  /**
   * Narrative copy is accepted only to make the trust boundary explicit:
   * biography, premise, and scene text must never become visual identity.
   */
  readonly narrativeDescription?: string | null;
}) {
  const appearance = record(input.appearanceSnapshot);
  const structuredAppearance = record(appearance.structured);
  const identityAnchor = text(appearance.identityAnchor);
  const stableTraits = stringArray(appearance.stableTraits);
  const referenceDirection = text(appearance.referenceDirection);
  const style = visualStyle(appearance.style || input.characterStyle);
  const structuredFaceTraits = record(
    appearance.faceTraits ?? structuredAppearance.faceTraits,
  );
  const structuredHairTraits = record(
    appearance.hairTraits ?? structuredAppearance.hairTraits,
  );
  const structuredBodyTraits = record(
    appearance.bodyTraits ?? structuredAppearance.bodyTraits,
  );
  const structuredSignatureTraits = record(
    appearance.signatureTraits ?? structuredAppearance.signatureTraits,
  );
  const identityPrompt = [
    input.characterName.trim(),
    CHARACTER_CANONICAL_PORTRAIT_IDENTITY_PROMPT,
    identityAnchor ? `Visual identity anchor: ${identityAnchor}` : "",
    stableTraits.length > 0
      ? `Stable visual traits: ${stableTraits.join(", ")}`
      : "",
  ].filter(Boolean).join(". ");

  return {
    style,
    identityPrompt,
    negativeIdentityPrompt: [
      "different person",
      "identity drift",
      "changed facial geometry",
      "changed age",
      "changed skin tone",
      "multiple people",
      "duplicate face",
      "text",
      "watermark",
      "contact sheet",
    ].join(", "),
    faceTraits: {
      ...structuredFaceTraits,
      ...(identityAnchor ? { identityAnchor } : {}),
      canonicalPortraitAuthority: true,
      stableTraits,
      preservedDimensions: [
        "facial geometry",
        "eyes",
        "nose",
        "lips",
        "skin tone",
        "age presentation",
      ],
      source: "canonical_portrait",
    },
    hairTraits: {
      ...structuredHairTraits,
      preservedDimensions: [
        "hairline",
        "hair color",
        "hair length",
        "hair texture",
      ],
      source: "canonical_portrait",
    },
    bodyTraits: {
      ...structuredBodyTraits,
      preservedDimensions: ["body proportions", "silhouette"],
      source: "canonical_portrait",
    },
    signatureTraits: {
      ...structuredSignatureTraits,
      ...(referenceDirection ? { referenceDirection } : {}),
      preservedDimensions: ["visible signature marks"],
      source: "canonical_portrait",
    },
    styleTraits: {
      style,
      characterName: input.characterName.trim(),
    },
  };
}

export type PreparedCharacterImageReadinessSource = {
  readonly assetId: string;
  readonly sourceAuthority: CharacterImageAssetAuthority;
  readonly sourceAuthorityFingerprint: string;
  readonly storageKey: string | null;
  readonly contentType: string | null;
};

export async function prepareCharacterImageReadinessSource(
  characterId: string,
): Promise<PreparedCharacterImageReadinessSource> {
  const character = await prisma.character.findUnique({
    where: { id: characterId },
    include: { imageAsset: true },
  });
  if (!character) throw Errors.notFound("Character not found");
  if (!character.imageAssetId || !character.imageAsset) {
    throw Errors.conflict(
      "A live portrait is required before image production can be prepared",
    );
  }
  const asset = character.imageAsset;
  const source = await inspectCharacterImageGenerationSource(asset);
  if (!source.materializable) {
    throw Errors.conflict(
      "The live portrait can be displayed but cannot be materialized for image production",
      { assetId: asset.id },
    );
  }
  let storageKey: string | null = null;
  let contentType: string | null = null;
  if (source.bundled) {
    const assetKey = canonicalSha256(asset.id).slice(0, 16);
    storageKey =
      `official-editorial/${assetKey}/${source.bundled.contentSha256}${source.bundled.extension}`;
    const stored = await providers.blob.putPrivate({
      key: storageKey,
      body: source.bundled.bytes,
      contentType: source.bundled.contentType,
    });
    if (!stored.ok) {
      throw Errors.unavailable(
        "The live portrait could not be stored for image production",
        {
          assetId: asset.id,
          providerCode: stored.error.code,
        },
      );
    }
    storageKey = stored.data.key;
    contentType = source.bundled.contentType;
  }
  return {
    assetId: asset.id,
    sourceAuthority: source.authority,
    sourceAuthorityFingerprint: canonicalSha256(source.authority),
    storageKey,
    contentType,
  };
}

export async function repairLegacyEditorialVisualIdentity(input: {
  readonly characterId: string;
  readonly actorId: string;
  readonly requestId: string;
  readonly tx: Prisma.TransactionClient;
}) {
  await lockCharacterGenerationAndMediaAssetAuthorities(
    input.tx,
    input.characterId,
    [],
  );
  const discovered = await input.tx.characterVisualProfile.findFirst({
    where: { characterId: input.characterId, status: "active" },
    orderBy: { version: "desc" },
    include: {
      referenceSetRevisions: {
        where: { status: "active" },
        orderBy: { revision: "desc" },
        take: 1,
        include: {
          references: { orderBy: { position: "asc" } },
        },
      },
    },
  });
  if (!discovered) throw Errors.notFound("Active Visual Identity not found");
  const discoveredAdapterRefs = record(discovered.adapterRefs);
  if (discoveredAdapterRefs.authority !== "editorial_live_portrait") {
    throw Errors.conflict(
      "Only a legacy editorial portrait identity can use this repair",
    );
  }
  const discoveredFaceTraits = record(discovered.faceTraits);
  if (
    discoveredFaceTraits.canonicalPortraitAuthority === true &&
    record(discoveredAdapterRefs.identityPromptRepair).version ===
      EDITORIAL_VISUAL_IDENTITY_REPAIR_VERSION
  ) {
    return {
      state: "already_repaired" as const,
      characterId: input.characterId,
      visualProfileId: discovered.id,
      visualProfileVersion: discovered.version,
    };
  }
  const discoveredReferenceSet =
    discovered.referenceSetRevisions[0] ?? null;
  // 参考图与锚点都取自 active Reference Set（唯一权威）；anchors 是 refs 的子集，取 refs 即全集。
  const discoveredAssetIds = [
    ...new Set(characterReferenceAuthorityFrom(discoveredReferenceSet)?.refs ?? []),
  ];
  if (discoveredAssetIds.length === 0) {
    throw Errors.conflict(
      "The legacy editorial identity has no portrait authority to preserve",
    );
  }
  await lockCharacterGenerationAndMediaAssetAuthorities(
    input.tx,
    input.characterId,
    discoveredAssetIds,
  );
  const [character, current, mediaAssets, project] = await Promise.all([
    input.tx.character.findUnique({
      where: { id: input.characterId },
      select: {
        id: true,
        name: true,
        description: true,
        style: true,
        appearance: true,
      },
    }),
    input.tx.characterVisualProfile.findFirst({
      where: { characterId: input.characterId, status: "active" },
      orderBy: { version: "desc" },
      include: {
        referenceSetRevisions: {
          where: { status: "active" },
          orderBy: { revision: "desc" },
          take: 1,
          include: {
            references: { orderBy: { position: "asc" } },
          },
        },
      },
    }),
    input.tx.mediaAsset.findMany({
      where: { id: { in: discoveredAssetIds } },
      select: {
        id: true,
        characterId: true,
        type: true,
        deletedAt: true,
        safetyStatus: true,
        metadata: true,
      },
    }),
    input.tx.characterProject.findFirst({
      where: { characterId: input.characterId },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      select: { id: true },
    }),
  ]);
  if (!character || !current) {
    throw Errors.conflict(
      "The Character identity authority changed during editorial repair",
    );
  }
  if (current.id !== discovered.id) {
    throw Errors.conflict(
      "The active Visual Identity changed during editorial repair",
    );
  }
  const currentReferenceSet = current.referenceSetRevisions[0] ?? null;
  if ((currentReferenceSet?.id ?? null) !== (discoveredReferenceSet?.id ?? null)) {
    throw Errors.conflict(
      "The active Reference Set changed during editorial repair",
    );
  }
  const mediaById = new Map(mediaAssets.map((asset) => [asset.id, asset]));
  const invalidAssetIds = discoveredAssetIds.filter((assetId) => {
    const asset = mediaById.get(assetId);
    return (
      !asset ||
      asset.characterId !== input.characterId ||
      asset.type !== "image" ||
      asset.deletedAt !== null ||
      asset.safetyStatus !== "passed" ||
      !isMediaAssetOperationalForAuthority(asset.metadata)
    );
  });
  if (invalidAssetIds.length > 0) {
    throw Errors.conflict(
      "The legacy editorial portrait authority is unavailable or unsafe",
      { assetIds: invalidAssetIds },
    );
  }
  if (project) {
    const activeRelease = await input.tx.characterRelease.findFirst({
      where: {
        projectId: project.id,
        status: { in: ["draft", "validating", "in_review", "approved"] },
      },
      select: { id: true, status: true },
    });
    if (activeRelease) {
      throw Errors.conflict(
        "Withdraw or finish the active Character Release before repairing Visual Identity",
        {
          releaseId: activeRelease.id,
          releaseStatus: activeRelease.status,
        },
      );
    }
  }
  const currentAdapterRefs = record(current.adapterRefs);
  const sourceContentVersionId = text(
    currentAdapterRefs.sourceContentVersionId,
  );
  const content = sourceContentVersionId
    ? await input.tx.characterContentVersion.findUnique({
        where: { id: sourceContentVersionId },
      })
    : await input.tx.characterContentVersion.findFirst({
        where: { characterId: input.characterId },
        orderBy: { version: "desc" },
      });
  const identity = buildEditorialPortraitIdentity({
    characterName: character.name,
    characterStyle: current.style || character.style,
    appearanceSnapshot: content?.appearanceSnapshot ?? character.appearance,
    narrativeDescription:
      text(record(content?.personaSnapshot).description) ||
      character.description,
  });
  const version = current.version + 1;
  // 锚点与参考图都来自 active Reference Set。没有它就是没有可保留的身份权威——
  // 此前从影子列重建 references 会凭空造出一个 role 布局，掩盖「参考集缺失」这个真问题。
  const anchorAssetIds = [
    ...(characterReferenceAuthorityFrom(currentReferenceSet)?.anchors ?? []),
  ];
  const references = currentReferenceSet
    ? currentReferenceSet.references.map((reference) => ({
        mediaAssetId: reference.mediaAssetId,
        position: reference.position,
        role: reference.role,
        weight: reference.weight,
        crop: reference.crop,
        qualityScore: reference.qualityScore,
        identityScore: reference.identityScore,
        selectionReason: reference.selectionReason,
      }))
    : [];
  if (anchorAssetIds.length === 0 || references.length === 0) {
    throw Errors.conflict(
      "The legacy editorial identity is missing its sealed portrait references",
    );
  }
  const referenceAssetIds = references.map(
    (reference) => reference.mediaAssetId,
  );
  const profileSnapshot = {
    version,
    style: identity.style,
    identityPrompt: identity.identityPrompt,
    negativeIdentityPrompt: identity.negativeIdentityPrompt,
    faceTraits: identity.faceTraits,
    hairTraits: identity.hairTraits,
    bodyTraits: identity.bodyTraits,
    signatureTraits: identity.signatureTraits,
    styleTraits: identity.styleTraits,
    anchorAssetIds,
    referenceAssetIds,
  };
  const archived = await input.tx.characterVisualProfile.updateMany({
    where: {
      id: current.id,
      characterId: input.characterId,
      status: "active",
    },
    data: { status: "archived" },
  });
  if (archived.count !== 1) {
    throw Errors.conflict(
      "The legacy editorial identity changed before it could be archived",
    );
  }
  const created = await input.tx.characterVisualProfile.create({
    data: {
      characterId: input.characterId,
      version,
      status: "active",
      style: identity.style,
      identityPrompt: identity.identityPrompt,
      negativeIdentityPrompt: identity.negativeIdentityPrompt,
      faceTraits: toInputJson(identity.faceTraits),
      hairTraits: toInputJson(identity.hairTraits),
      bodyTraits: toInputJson(identity.bodyTraits),
      signatureTraits: toInputJson(identity.signatureTraits),
      styleTraits: toInputJson(identity.styleTraits),
      anchorAssetIds: toInputJson(anchorAssetIds),
      defaultSeed: current.defaultSeed,
      adapterRefs: toInputJson({
        ...currentAdapterRefs,
        identityPromptRepair: {
          version: EDITORIAL_VISUAL_IDENTITY_REPAIR_VERSION,
          repairedFromVisualProfileId: current.id,
          source: "canonical_editorial_portrait",
        },
      }),
      qualityScore: current.qualityScore,
      consistencyScore: current.consistencyScore,
      immutableHash: characterVisualProfileSnapshotHash(profileSnapshot),
      evidenceState: "qualified",
      createdFrom: `editorial_visual_identity_repair:${current.id}`,
    },
  });
  const selectorVersion = "editorial-visual-identity-repair-v1";
  const referenceSet = await input.tx.referenceSetRevision.create({
    data: {
      visualProfileId: created.id,
      revision: 1,
      status: "active",
      selectorVersion,
      createdFrom: `editorial_visual_identity_repair:${current.id}`,
      snapshotHash: referenceSetSnapshotHash({
        visualProfileId: created.id,
        revision: 1,
        selectorVersion,
        references,
      }),
      references: {
        create: references.map((reference) => ({
          mediaAssetId: reference.mediaAssetId,
          position: reference.position,
          role: reference.role,
          weight: reference.weight,
          ...(reference.crop === null
            ? {}
            : { crop: toInputJson(reference.crop) }),
          qualityScore: reference.qualityScore,
          identityScore: reference.identityScore,
          selectionReason: reference.selectionReason,
          selectorVersion,
        })),
      },
    },
  });
  await input.tx.referenceCandidate.createMany({
    data: references.map((reference) => ({
      visualProfileId: created.id,
      mediaAssetId: reference.mediaAssetId,
      sourceJobId: null,
      proposedRole: reference.role,
      qualityScore: reference.qualityScore,
      identityScore: reference.identityScore,
      source: "editorial_visual_identity_repair",
      status: "promoted",
      promotedRevisionId: referenceSet.id,
    })),
  });
  await input.tx.characterLook.updateMany({
    where: {
      characterId: input.characterId,
      visualProfileId: current.id,
      status: "active",
    },
    data: { status: "needs_rebase" },
  });
  const invalidatedDraftAssets =
    await invalidateCharacterDraftAssetPack(input.tx, input.characterId);
  await input.tx.adminAuditLog.create({
    data: {
      actorId: input.actorId,
      actorRole: "system",
      action: "character.visual_identity.editorial_prompt_repaired",
      targetType: "character",
      targetId: input.characterId,
      reason:
        "Replace legacy narrative identity text with canonical portrait authority",
      before: toInputJson({
        visualProfileId: current.id,
        version: current.version,
        identityPrompt: current.identityPrompt,
      }),
      after: toInputJson({
        visualProfileId: created.id,
        version: created.version,
        identityPrompt: created.identityPrompt,
        referenceSetRevisionId: referenceSet.id,
        invalidatedDraftAssetPackProjectId:
          invalidatedDraftAssets?.projectId ?? null,
      }),
      requestId: input.requestId,
    },
  });
  await input.tx.mainOutboxEvent.create({
    data: {
      eventType: "character.visual_identity.editorial_prompt_repaired.v1",
      aggregateType: "character",
      aggregateId: input.characterId,
      payload: toInputJson({
        characterId: input.characterId,
        previousVisualProfileId: current.id,
        visualProfileId: created.id,
        visualProfileVersion: created.version,
        referenceSetRevisionId: referenceSet.id,
      }),
    },
  });
  return {
    state: "repaired" as const,
    characterId: input.characterId,
    previousVisualProfileId: current.id,
    visualProfileId: created.id,
    visualProfileVersion: created.version,
    referenceSetRevisionId: referenceSet.id,
  };
}

async function attachPreparedGenerationBlob(
  tx: Prisma.TransactionClient,
  asset: {
    readonly id: string;
    readonly url: string;
    readonly storageKey: string | null;
    readonly contentType: string | null;
    readonly metadata: Prisma.JsonValue;
  },
  prepared: PreparedCharacterImageReadinessSource,
) {
  if (hasHydratableMediaBlobAuthority(asset)) return;
  if (!prepared.storageKey) {
    throw Errors.conflict(
      "The live portrait has no prepared image-production bytes",
      { assetId: asset.id },
    );
  }
  const updated = await tx.mediaAsset.updateMany({
    where: {
      id: asset.id,
      storageKey: null,
      url: asset.url,
    },
    data: {
      storageKey: prepared.storageKey,
      contentType: prepared.contentType,
    },
  });
  if (updated.count !== 1) {
    throw Errors.conflict(
      "The live portrait changed while its image-production bytes were being attached",
      { assetId: asset.id },
    );
  }
}

export async function repairCharacterImageReadiness(input: {
  readonly characterId: string;
  readonly actor: AdminActor;
  readonly requestId: string;
  readonly request: CharacterImageReadinessRepairRequest;
  readonly prepared: PreparedCharacterImageReadinessSource;
  readonly tx: Prisma.TransactionClient;
}) {
  if (
    input.request.confirmation !==
      `PREPARE IMAGE PRODUCTION ${input.characterId}`
  ) {
    throw Errors.badRequest(
      "Confirmation did not match the Character image-readiness repair",
    );
  }
  const initialCharacter = await input.tx.character.findUnique({
    where: { id: input.characterId },
    select: { imageAssetId: true },
  });
  if (!initialCharacter) throw Errors.notFound("Character not found");
  await lockCharacterGenerationAndMediaAssetAuthorities(
    input.tx,
    input.characterId,
    initialCharacter.imageAssetId ? [initialCharacter.imageAssetId] : [],
  );

  // Prisma's pg transaction adapter uses one client connection. Keep reads
  // sequential after the authority lock so no query is issued while that
  // client is already executing another query.
  const character = await input.tx.character.findUnique({
    where: { id: input.characterId },
    include: { imageAsset: true },
  });
  if (!character) throw Errors.notFound("Character not found");
  if (character.imageAssetId !== initialCharacter.imageAssetId) {
    throw Errors.conflict(
      "The live portrait changed while image readiness was being repaired",
      {
        expectedAssetId: initialCharacter.imageAssetId,
        currentAssetId: character.imageAssetId,
      },
    );
  }
  const project = await input.tx.characterProject.findFirst({
    where: { characterId: input.characterId },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
  });
  const serving = await input.tx.characterServing.findUnique({
    where: { characterId: input.characterId },
  });
  const activeIdentity = await input.tx.characterVisualProfile.findFirst({
    where: { characterId: input.characterId, status: "active" },
    orderBy: [{ version: "desc" }, { id: "desc" }],
  });
  const activeLookCount = await input.tx.characterLook.count({
    where: {
      characterId: input.characterId,
      status: { in: ["active", "needs_rebase"] },
    },
  });
  if (!project || !serving) {
    throw Errors.notFound("Character Project authority is incomplete");
  }
  if (project.version !== input.request.entityVersion) {
    throw Errors.conflict(
      "Character Project changed before image production was prepared",
      {
        expectedVersion: input.request.entityVersion,
        currentVersion: project.version,
      },
    );
  }
  if (!serving.currentReleaseId || serving.state !== "live") {
    throw Errors.conflict(
      "Only a currently live editorial Character can adopt its live portrait",
    );
  }
  const currentRelease = await input.tx.characterRelease.findUnique({
    where: { id: serving.currentReleaseId },
  });
  if (!currentRelease) {
    throw Errors.conflict("The live Character Release is unavailable");
  }
  const activeReferenceSet = activeIdentity
    ? await input.tx.referenceSetRevision.findFirst({
        where: { visualProfileId: activeIdentity.id, status: "active" },
        orderBy: [{ revision: "desc" }, { id: "desc" }],
      })
    : null;
  const currentImageSource = character.imageAsset
    ? await inspectCharacterImageGenerationSource(character.imageAsset)
    : null;
  if (
    !currentImageSource ||
    character.imageAssetId !== input.prepared.assetId ||
    canonicalSha256(currentImageSource.authority) !==
      input.prepared.sourceAuthorityFingerprint
  ) {
    throw Errors.conflict(
      "The live portrait source changed while image production was being prepared",
      {
        preparedAssetId: input.prepared.assetId,
        currentAssetId: character.imageAssetId,
      },
    );
  }
  const fingerprint = characterImageReadinessFingerprint({
    characterId: character.id,
    characterImageAssetId: character.imageAssetId,
    sourceAsset: currentImageSource.authority,
    projectId: project.id,
    projectVersion: project.version,
    draftImageAssetId: project.draftImageAssetId,
    draftAssetPack: project.draftAssetPack,
    serving: {
      currentReleaseId: serving.currentReleaseId,
      scheduledReleaseId: serving.scheduledReleaseId,
      version: serving.version,
    },
    currentRelease: {
      id: currentRelease.id,
      version: currentRelease.version,
      snapshotHash: currentRelease.snapshotHash,
    },
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
  if (fingerprint !== input.request.expectedReadinessFingerprint) {
    throw Errors.conflict(
      "Image-production readiness changed after this workspace was loaded",
      {
        submittedFingerprint:
          input.request.expectedReadinessFingerprint,
        currentFingerprint: fingerprint,
      },
    );
  }
  if (
    project.draftImageAssetId !== null ||
    Object.keys(draftAssetRouteEntries(project.draftAssetPack)).length > 0
  ) {
    throw Errors.conflict(
      "Existing draft role images require manual review before adopting the live portrait",
    );
  }
  const candidateRelease = await input.tx.characterRelease.findFirst({
    where: {
      projectId: project.id,
      id: { not: currentRelease.id },
      status: { in: ["draft", "validating", "in_review", "approved"] },
    },
    select: { id: true, status: true },
  });
  if (candidateRelease || serving.scheduledReleaseId) {
    throw Errors.conflict(
      "Finish the active or scheduled Character Release before repairing image readiness",
      {
        candidateReleaseId: candidateRelease?.id ?? null,
        scheduledReleaseId: serving.scheduledReleaseId,
      },
    );
  }
  if (activeIdentity || activeReferenceSet || activeLookCount > 0) {
    throw Errors.conflict(
      "Existing modern identity authority requires manual visual review",
      {
        activeIdentityId: activeIdentity?.id ?? null,
        activeReferenceSetId: activeReferenceSet?.id ?? null,
        activeLookCount,
      },
    );
  }
  if (
    !character.imageAssetId ||
    !character.imageAsset ||
    currentRelease.legacy !== true ||
    currentRelease.status !== "published"
  ) {
    throw Errors.conflict(
      "A published legacy editorial portrait is required for automatic repair",
    );
  }
  const asset = character.imageAsset;
  if (
    asset.type !== "image" ||
    asset.deletedAt !== null ||
    asset.safetyStatus !== "passed" ||
    !isMediaAssetOperationalForAuthority(asset.metadata)
  ) {
    throw Errors.conflict(
      "The live portrait is unavailable for image-production authority",
    );
  }
  if (asset.characterId === null) {
    const references = await input.tx.character.findMany({
      where: { imageAssetId: asset.id },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    if (
      references.length !== 1 ||
      references[0]?.id !== input.characterId
    ) {
      throw Errors.conflict(
        "The live portrait is shared and cannot become this Character's identity authority",
      );
    }
    const claimed = await input.tx.mediaAsset.updateMany({
      where: { id: asset.id, characterId: null },
      data: { characterId: input.characterId },
    });
    if (claimed.count !== 1) {
      throw Errors.conflict(
        "The live portrait changed while image readiness was being repaired",
      );
    }
  } else if (asset.characterId !== input.characterId) {
    throw Errors.conflict(
      "The live portrait belongs to another Character",
    );
  }
  const editorialAuthority =
    await evaluateEditorialReleaseAuthorityInTransaction(input.tx, {
      releaseId: currentRelease.id,
    });
  if (!editorialAuthority.valid) {
    throw Errors.conflict(
      "The live editorial Release failed exact authority verification",
      {
        failureCodes: editorialAuthority.failures.map((failure) =>
          failure.code
        ),
      },
    );
  }
  if (
    editorialAuthority.characterId !== input.characterId ||
    editorialAuthority.assetId !== asset.id
  ) {
    throw Errors.conflict(
      "The live portrait does not match the editorial Release authority",
    );
  }
  await attachPreparedGenerationBlob(input.tx, asset, input.prepared);
  const content = await input.tx.characterContentVersion.findUnique({
    where: { id: currentRelease.characterContentVersionId },
  });
  if (!content || content.characterId !== input.characterId) {
    throw Errors.conflict(
      "The live Character content snapshot is unavailable",
    );
  }

  const persona = record(content.personaSnapshot);
  const {
    style,
    identityPrompt,
    negativeIdentityPrompt,
    faceTraits,
    hairTraits,
    bodyTraits,
    signatureTraits,
    styleTraits,
  } = buildEditorialPortraitIdentity({
    characterName: text(persona.name) || character.name,
    characterStyle: character.style,
    appearanceSnapshot: content.appearanceSnapshot,
    narrativeDescription:
      text(persona.description) || character.description,
  });
  const latestProfile = await input.tx.characterVisualProfile.aggregate({
    where: { characterId: input.characterId },
    _max: { version: true },
  });
  const visualProfileVersion = (latestProfile._max.version ?? 0) + 1;
  const profileSnapshot = {
    version: visualProfileVersion,
    style,
    identityPrompt,
    negativeIdentityPrompt,
    faceTraits,
    hairTraits,
    bodyTraits,
    signatureTraits,
    styleTraits,
    anchorAssetIds: [asset.id],
    referenceAssetIds: [asset.id],
  };
  const visualProfile = await input.tx.characterVisualProfile.create({
    data: {
      characterId: input.characterId,
      version: visualProfileVersion,
      status: "active",
      style,
      identityPrompt,
      negativeIdentityPrompt,
      faceTraits: toInputJson(faceTraits),
      hairTraits: toInputJson(hairTraits),
      bodyTraits: toInputJson(bodyTraits),
      signatureTraits: toInputJson(signatureTraits),
      styleTraits: toInputJson(styleTraits),
      anchorAssetIds: toInputJson([asset.id]),
      defaultSeed: null,
      adapterRefs: toInputJson({
        authority: "editorial_live_portrait",
        sourceReleaseId: currentRelease.id,
        sourceContentVersionId: content.id,
        sourceAssetId: asset.id,
      }),
      immutableHash: characterVisualProfileSnapshotHash(profileSnapshot),
      // This portrait has already passed the published editorial Release
      // authority checks above. Keep the evidence state inside the persisted
      // database contract; provenance remains explicit in adapterRefs and
      // createdFrom.
      evidenceState: "qualified",
      createdFrom: `editorial_live_portrait:${currentRelease.id}`,
    },
  });
  const references = [{
    mediaAssetId: asset.id,
    position: 0,
    role: "primary_face",
    weight: 1,
  }];
  const selectorVersion = "editorial-live-portrait-v1";
  const referenceSet = await input.tx.referenceSetRevision.create({
    data: {
      visualProfileId: visualProfile.id,
      revision: 1,
      status: "active",
      selectorVersion,
      createdFrom: `editorial_live_portrait:${currentRelease.id}`,
      snapshotHash: referenceSetSnapshotHash({
        visualProfileId: visualProfile.id,
        revision: 1,
        selectorVersion,
        references,
      }),
      references: {
        create: references.map((reference) => ({
          ...reference,
          selectorVersion,
          selectionReason: input.request.reason,
        })),
      },
    },
  });
  await input.tx.referenceCandidate.create({
    data: {
      visualProfileId: visualProfile.id,
      mediaAssetId: asset.id,
      sourceJobId: null,
      proposedRole: "primary_face",
      qualityScore: null,
      identityScore: null,
      source: "editorial_live_portrait",
      status: "promoted",
      promotedRevisionId: referenceSet.id,
    },
  });
  const updatedProject = await input.tx.characterProject.updateMany({
    where: { id: project.id, version: project.version },
    data: { version: { increment: 1 } },
  });
  if (updatedProject.count !== 1) {
    throw Errors.conflict(
      "Character Project changed during image-readiness repair",
    );
  }
  const repairedAt = new Date();
  const route = await findOperationalGenerationRoute(input.tx, {
    style,
    policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
    evaluatorVersion: env.GENERATION_ROUTE_EVALUATOR_VERSION,
    at: repairedAt,
    requiredReferenceCount: 1,
    requiredReferenceRoles: ["primary_face"],
  });
  const state = route ? "ready" as const : "route_pending" as const;
  await input.tx.adminAuditLog.create({
    data: {
      actorId: input.actor.id,
      actorRole: input.actor.role,
      action: "character.image_readiness.repaired",
      targetType: "character_project",
      targetId: project.id,
      reason: input.request.reason,
      before: toInputJson({
        projectVersion: project.version,
        readinessFingerprint: fingerprint,
        activeIdentityId: null,
        activeReferenceSetId: null,
        liveReleaseId: currentRelease.id,
        liveAssetId: asset.id,
      }),
      after: toInputJson({
        projectVersion: project.version + 1,
        visualProfileId: visualProfile.id,
        visualProfileVersion: visualProfile.version,
        referenceSetRevisionId: referenceSet.id,
        referenceSetRevision: referenceSet.revision,
        routeQualificationId: route?.id ?? null,
        state,
      }),
      requestId: input.requestId,
    },
  });
  await input.tx.adminCollaborationActivity.create({
    data: {
      targetType: "character_project",
      targetId: project.id,
      kind: "status_change",
      actorId: input.actor.id,
      body: "Prepared the live editorial portrait for future image production",
      metadata: toInputJson({
        characterId: input.characterId,
        visualProfileId: visualProfile.id,
        referenceSetRevisionId: referenceSet.id,
        liveReleaseUnchanged: true,
        state,
      }),
      idempotencyKey:
        `character_image_readiness:${input.requestId}`,
    },
  });
  await input.tx.mainOutboxEvent.create({
    data: {
      eventType: "character.image_readiness.repaired.v1",
      aggregateType: "character",
      aggregateId: input.characterId,
      status: "delivered",
      deliveredAt: repairedAt,
      payload: toInputJson({
        characterId: input.characterId,
        projectId: project.id,
        projectVersion: project.version + 1,
        visualProfileId: visualProfile.id,
        referenceSetRevisionId: referenceSet.id,
        sourceReleaseId: currentRelease.id,
        sourceAssetId: asset.id,
        state,
      }),
    },
  });
  return {
    characterId: input.characterId,
    projectVersion: project.version + 1,
    state,
    action: "adopted_live_portrait" as const,
    visualProfileId: visualProfile.id,
    visualProfileVersion: visualProfile.version,
    referenceSetRevisionId: referenceSet.id,
    referenceSetRevision: referenceSet.revision,
    routeQualificationId: route?.id ?? null,
    routeFingerprint: route?.routeFingerprint ?? null,
    remainingBlockers: route ? [] : ["generation_route_unqualified"],
    deepLink: characterWorkspaceTabLink(input.characterId, "assets"),
  };
}
