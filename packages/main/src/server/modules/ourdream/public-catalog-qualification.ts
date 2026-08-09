import type { Prisma, PrismaClient } from "@prisma/client";
import { evaluateMediaAssetCustomerPublishability } from "@/server/lib/media-asset-authority";
import { officialEditorialContentIdentity } from "@/server/modules/admin-v2/shared/character-content-identity";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import { CHARACTER_RELEASE_POLICY_VERSION } from "@/server/modules/admin-v2/characters/character-release-contract";
import { characterReleaseSnapshotHash } from "@/server/modules/admin-v2/characters/release-snapshot";
import {
  transitionCharacterRelease,
  transitionCharacterServing,
} from "@/server/modules/admin-v2/characters/transition";

export const PUBLIC_CATALOG_QUALIFICATION_SCHEMA_VERSION =
  "public-catalog-qualification-v1";
export const PUBLIC_CATALOG_EDITORIAL_IMPORT_POLICY_VERSION =
  "public-catalog-editorial-import-v1";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function attachExistingModernQualification(
  tx: Prisma.TransactionClient,
  release: {
    id: string;
    snapshotHash: string;
    legacy: boolean;
    readiness: string;
    status: string;
    generationProvenance: Prisma.JsonValue;
  },
) {
  if (
    release.legacy ||
    release.readiness !== "ready" ||
    release.status !== "published" ||
    record(release.generationProvenance).schemaVersion !==
      "character-release-generation-provenance-v2"
  ) {
    return null;
  }
  const validation = await tx.releaseValidationRun.findFirst({
    where: {
      releaseId: release.id,
      snapshotHash: release.snapshotHash,
      policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
      result: "passed",
      finishedAt: { not: null },
    },
    orderBy: [{ finishedAt: "desc" }, { id: "desc" }],
  });
  if (!validation) return null;
  return tx.publicCatalogQualification.upsert({
    where: { releaseId: release.id },
    update: {},
    create: {
      id: `catalog-qualification:${release.id}`,
      releaseId: release.id,
      releaseSnapshotHash: release.snapshotHash,
      kind: "generated_release",
      validationRunId: validation.id,
      evidence: {
        schemaVersion: PUBLIC_CATALOG_QUALIFICATION_SCHEMA_VERSION,
        policyVersion: validation.policyVersion,
        validationRunId: validation.id,
        attachedFromExistingRelease: true,
      },
      qualifiedAt: validation.finishedAt ?? undefined,
    },
  });
}

export async function ensureOfficialEditorialCatalogQualification(
  db: PrismaClient,
  input: {
    characterId: string;
    expectedAssetId: string;
    expectedSeedSource: string;
  },
) {
  return db.$transaction(async (tx) => {
    const character = await tx.character.findUnique({
      where: { id: input.characterId },
      include: {
        imageAsset: true,
        serving: {
          include: {
            currentRelease: {
              include: { publicCatalogQualification: true },
            },
          },
        },
      },
    });
    if (
      !character ||
      character.source !== "official" ||
      character.status !== "approved" ||
      character.visibility !== "public" ||
      character.deletedAt !== null
    ) {
      throw new Error(
        `Official editorial import ${input.characterId} is not a public approved Character`,
      );
    }
    const asset = character.imageAsset;
    const assetMetadata = record(asset?.metadata);
    const publishability = evaluateMediaAssetCustomerPublishability({
      metadata: asset?.metadata,
    });
    if (
      !asset ||
      asset.id !== input.expectedAssetId ||
      assetMetadata.seedSource !== input.expectedSeedSource ||
      asset.type !== "image" ||
      asset.deletedAt !== null ||
      asset.visibility !== "public_pack" ||
      asset.safetyStatus !== "passed" ||
      !asset.url ||
      !publishability.publishable
    ) {
      throw new Error(
        `Official editorial import ${input.characterId} lacks its exact publishable seed asset`,
      );
    }

    const { snapshot: contentSnapshot, contentHash } =
      officialEditorialContentIdentity(character);
    const currentRelease = character.serving?.currentRelease ?? null;
    const currentReleaseContent = currentRelease
      ? await tx.characterContentVersion.findUnique({
          where: { id: currentRelease.characterContentVersionId },
          select: { contentHash: true },
        })
      : null;
    const currentQualification =
      currentRelease?.publicCatalogQualification ?? null;
    const currentProvenance = record(currentRelease?.generationProvenance);
    const currentQualificationEvidence = record(
      currentQualification?.evidence,
    );
    if (
      currentRelease?.status === "published" &&
      currentRelease.publishedAt !== null &&
      currentRelease.readiness === "ready" &&
      currentRelease.legacy &&
      currentProvenance.schemaVersion ===
        "character-release-editorial-import-v1" &&
      currentProvenance.recordId === character.id &&
      currentProvenance.sourceAssetId === asset.id &&
      currentQualification &&
      currentQualification.kind === "editorial_import" &&
      currentQualification.validationRunId === null &&
      currentQualification.revokedAt === null &&
      currentQualification.releaseSnapshotHash ===
        currentRelease.snapshotHash &&
      currentQualificationEvidence.schemaVersion ===
        PUBLIC_CATALOG_QUALIFICATION_SCHEMA_VERSION &&
      currentQualificationEvidence.policyVersion ===
        PUBLIC_CATALOG_EDITORIAL_IMPORT_POLICY_VERSION &&
      currentReleaseContent?.contentHash === contentHash
    ) {
      return {
        releaseId: currentRelease.id,
        qualificationId: currentQualification.id,
        kind: currentQualification.kind,
        replayed: true,
      };
    }
    if (
      currentRelease &&
      currentReleaseContent?.contentHash === contentHash
    ) {
      const attached = await attachExistingModernQualification(
        tx,
        currentRelease,
      );
      if (attached) {
        return {
          releaseId: currentRelease.id,
          qualificationId: attached.id,
          kind: attached.kind,
          replayed: true,
        };
      }
    }

    const existingContent = await tx.characterContentVersion.findUnique({
      where: {
        characterId_contentHash: {
          characterId: character.id,
          contentHash,
        },
      },
    });
    const latestContentVersion = existingContent
      ? null
      : await tx.characterContentVersion.aggregate({
          where: { characterId: character.id },
          _max: { version: true },
        });
    const content =
      existingContent ??
      await tx.characterContentVersion.create({
        data: {
          id: `editorial-content:${character.id}:${contentHash.slice(0, 16)}`,
          characterId: character.id,
          version: (latestContentVersion?._max.version ?? 0) + 1,
          contentHash,
          personaSnapshot: toInputJson(contentSnapshot.persona),
          openingSnapshot: toInputJson(contentSnapshot.opening),
          appearanceSnapshot: toInputJson(contentSnapshot.appearance),
          sourceType: "official_editorial_import",
          sourceId: character.id,
        },
      });
    const project = await tx.characterProject.upsert({
      where: { id: `editorial-project:${character.id}` },
      update: {},
      create: {
        id: `editorial-project:${character.id}`,
        characterId: character.id,
        phase: "live_management",
        audience: {
          source: "official_editorial_import",
          state: "published",
        },
        successCriteria: [],
      },
    });
    const revisionId =
      `editorial-revision:${character.id}:${contentHash.slice(0, 16)}`;
    const existingRevision = await tx.characterRevision.findUnique({
      where: { id: revisionId },
    });
    const latestRevision = existingRevision
      ? null
      : await tx.characterRevision.aggregate({
          where: { projectId: project.id },
          _max: { revision: true },
        });
    const revision =
      existingRevision ??
      await tx.characterRevision.create({
        data: {
          id: revisionId,
          projectId: project.id,
          revision: (latestRevision?._max.revision ?? 0) + 1,
          characterContentVersionId: content.id,
          projectSnapshot: {
            source: "official_editorial_import",
            characterId: character.id,
            contentHash,
          },
        },
      });
    const generationProvenance = {
      schemaVersion: "character-release-editorial-import-v1",
      dataset: input.expectedSeedSource,
      recordId: character.id,
      sourceAssetId: asset.id,
    };
    const releasePlacementManifest = {
      schemaVersion: 1,
      kind: "editorial_import",
      placements: [
        {
          slotKey: "character_avatar",
          assetId: asset.id,
          slotVersion: 1,
        },
      ],
    };
    const snapshotHash = characterReleaseSnapshotHash({
      projectId: project.id,
      revisionId: revision.id,
      characterContentVersionId: content.id,
      visualProfileId: null,
      visualProfileVersion: null,
      referenceSetRevisionId: null,
      generationProvenance,
      releasePlacementManifest,
    });
    const releaseId =
      `editorial-release:${character.id}:${snapshotHash.slice(0, 16)}`;
    const release = await tx.characterRelease.upsert({
      where: { id: releaseId },
      update: {},
      create: {
        id: releaseId,
        projectId: project.id,
        revisionId: revision.id,
        characterContentVersionId: content.id,
        generationProvenance: toInputJson(generationProvenance),
        releasePlacementManifest: toInputJson(releasePlacementManifest),
        snapshotHash,
        readiness: "ready",
        legacy: true,
        status: "published",
        publishedAt: new Date(),
      },
    });
    const qualification = await tx.publicCatalogQualification.upsert({
      where: { releaseId: release.id },
      update: {},
      create: {
        id: `catalog-qualification:${release.id}`,
        releaseId: release.id,
        releaseSnapshotHash: release.snapshotHash,
        kind: "editorial_import",
        evidence: {
          schemaVersion: PUBLIC_CATALOG_QUALIFICATION_SCHEMA_VERSION,
          policyVersion: PUBLIC_CATALOG_EDITORIAL_IMPORT_POLICY_VERSION,
          characterId: character.id,
          sourceAssetId: asset.id,
          checks: {
            exactSeedRecord: true,
            nonSynthetic: true,
            safetyPassed: true,
            publicPack: true,
            imageAvailable: true,
          },
        },
      },
    });
    if (
      currentRelease &&
      currentRelease.id !== release.id &&
      currentRelease.status === "published"
    ) {
      await transitionCharacterRelease(tx, {
        releaseId: currentRelease.id,
        to: "superseded",
        expectedVersion: currentRelease.version,
      });
    }
    if (character.serving) {
      await transitionCharacterServing(tx, {
        servingId: character.serving.id,
        to: "live",
        expectedVersion: character.serving.version,
        data: {
          currentReleaseId: release.id,
          scheduledReleaseId: null,
          scheduledAt: null,
        },
      });
    } else {
      await tx.characterServing.create({
        data: {
          characterId: character.id,
          currentReleaseId: release.id,
          state: "live",
        },
      });
    }
    return {
      releaseId: release.id,
      qualificationId: qualification.id,
      kind: qualification.kind,
      replayed: false,
    };
  });
}
