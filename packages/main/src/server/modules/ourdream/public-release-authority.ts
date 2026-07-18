import type { Prisma, PrismaClient } from "@prisma/client";
import { evaluateMediaAssetCustomerPublishability } from "@/server/lib/media-asset-authority";
import { characterReleaseSnapshotHash } from "@/server/modules/admin-v2/characters/release-snapshot";
import {
  PUBLIC_CATALOG_EDITORIAL_IMPORT_POLICY_VERSION,
  PUBLIC_CATALOG_QUALIFICATION_SCHEMA_VERSION,
} from "./public-catalog-qualification";

export const EDITORIAL_RELEASE_PROVENANCE_SCHEMA_VERSION =
  "character-release-editorial-import-v1";
export const EDITORIAL_RELEASE_MANIFEST_KIND = "editorial_import";

export type EditorialReleaseAuthorityFailureCode =
  | "release_missing"
  | "release_not_published"
  | "release_not_ready"
  | "release_not_legacy"
  | "release_snapshot_mismatch"
  | "editorial_identity_authority_present"
  | "project_character_mismatch"
  | "revision_content_mismatch"
  | "character_not_public_official"
  | "serving_projection_mismatch"
  | "provenance_mismatch"
  | "manifest_mismatch"
  | "qualification_mismatch"
  | "asset_missing"
  | "asset_character_mismatch"
  | "asset_not_publishable";

export interface EditorialReleaseAuthorityCheck {
  readonly code: EditorialReleaseAuthorityFailureCode;
  readonly passed: boolean;
  readonly evidence: Readonly<Record<string, unknown>>;
}

export interface EditorialReleaseAuthorityResult {
  readonly releaseId: string;
  readonly characterId: string | null;
  readonly assetId: string | null;
  readonly valid: boolean;
  readonly repairable: boolean;
  readonly checks: readonly EditorialReleaseAuthorityCheck[];
  readonly failures: readonly EditorialReleaseAuthorityCheck[];
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nonBlankString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function check(
  code: EditorialReleaseAuthorityFailureCode,
  passed: boolean,
  evidence: Record<string, unknown>,
): EditorialReleaseAuthorityCheck {
  return { code, passed, evidence };
}

export async function evaluateEditorialReleaseAuthorityInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    readonly releaseId: string;
    readonly projectionState?: "live" | "paused";
  },
): Promise<EditorialReleaseAuthorityResult> {
  const release = await tx.characterRelease.findUnique({
    where: { id: input.releaseId },
  });
  if (!release) {
    const missing = check("release_missing", false, {
      releaseId: input.releaseId,
    });
    return {
      releaseId: input.releaseId,
      characterId: null,
      assetId: null,
      valid: false,
      repairable: false,
      checks: [missing],
      failures: [missing],
    };
  }

  const provenance = record(release.generationProvenance);
  const manifest = record(release.releasePlacementManifest);
  const placements = Array.isArray(manifest.placements)
    ? manifest.placements.map(record)
    : [];
  const avatarPlacements = placements.filter(
    (placement) => placement.slotKey === "character_avatar",
  );
  const avatarAssetId =
    avatarPlacements.length === 1
      ? nonBlankString(avatarPlacements[0]?.assetId)
      : null;
  const sourceAssetId = nonBlankString(provenance.sourceAssetId);
  const dataset = nonBlankString(provenance.dataset);

  const project = await tx.characterProject.findUnique({
    where: { id: release.projectId },
  });
  const characterId = project?.characterId ?? null;
  const revision = await tx.characterRevision.findUnique({
    where: { id: release.revisionId },
  });
  const content = await tx.characterContentVersion.findUnique({
    where: { id: release.characterContentVersionId },
  });
  const character = characterId
    ? await tx.character.findUnique({ where: { id: characterId } })
    : null;
  const serving = characterId
    ? await tx.characterServing.findUnique({
        where: { characterId },
      })
    : null;
  const qualification = await tx.publicCatalogQualification.findUnique({
    where: { releaseId: release.id },
  });
  const asset = avatarAssetId
    ? await tx.mediaAsset.findUnique({ where: { id: avatarAssetId } })
    : null;
  const assetMetadata = record(asset?.metadata);
  const qualificationEvidence = record(qualification?.evidence);
  const qualificationChecks = record(qualificationEvidence.checks);
  const publishability = evaluateMediaAssetCustomerPublishability({
    metadata: asset?.metadata,
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
  const projectionState = input.projectionState ?? "live";
  const expectedCharacterStatus =
    projectionState === "live" ? "approved" : "archived";
  const expectedCharacterVisibility =
    projectionState === "live" ? "public" : "private";
  const checks: EditorialReleaseAuthorityCheck[] = [
    check(
      "release_not_published",
      release.status === "published" && release.publishedAt !== null,
      {
        status: release.status,
        publishedAt: release.publishedAt?.toISOString() ?? null,
      },
    ),
    check("release_not_ready", release.readiness === "ready", {
      readiness: release.readiness,
    }),
    check("release_not_legacy", release.legacy, {
      legacy: release.legacy,
    }),
    check(
      "release_snapshot_mismatch",
      release.snapshotHash === canonicalSnapshotHash,
      {
        snapshotHash: release.snapshotHash,
        canonicalSnapshotHash,
      },
    ),
    check(
      "editorial_identity_authority_present",
      release.visualProfileId === null &&
        release.visualProfileVersion === null &&
        release.referenceSetRevisionId === null,
      {
        visualProfileId: release.visualProfileId,
        visualProfileVersion: release.visualProfileVersion,
        referenceSetRevisionId: release.referenceSetRevisionId,
      },
    ),
    check(
      "project_character_mismatch",
      Boolean(project && characterId),
      {
        projectId: project?.id ?? null,
        characterId,
      },
    ),
    check(
      "revision_content_mismatch",
      Boolean(
        revision &&
          content &&
          revision.projectId === release.projectId &&
          revision.characterContentVersionId ===
            release.characterContentVersionId &&
          content.characterId === characterId,
      ),
      {
        revisionId: revision?.id ?? null,
        contentVersionId: content?.id ?? null,
      },
    ),
    check(
      "character_not_public_official",
      Boolean(
        character &&
          character.source === "official" &&
          character.status === expectedCharacterStatus &&
          character.visibility === expectedCharacterVisibility &&
          character.deletedAt === null &&
          character.imageAssetId === avatarAssetId,
      ),
      {
        source: character?.source ?? null,
        status: character?.status ?? null,
        visibility: character?.visibility ?? null,
        deletedAt: character?.deletedAt?.toISOString() ?? null,
        characterImageAssetId: character?.imageAssetId ?? null,
        expectedStatus: expectedCharacterStatus,
        expectedVisibility: expectedCharacterVisibility,
      },
    ),
    check(
      "serving_projection_mismatch",
      Boolean(
        serving &&
          serving.state === projectionState &&
          serving.currentReleaseId === release.id,
      ),
      {
        servingState: serving?.state ?? null,
        currentReleaseId: serving?.currentReleaseId ?? null,
      },
    ),
    check(
      "provenance_mismatch",
      provenance.schemaVersion ===
          EDITORIAL_RELEASE_PROVENANCE_SCHEMA_VERSION &&
        nonBlankString(provenance.recordId) === characterId &&
        sourceAssetId !== null &&
        dataset !== null &&
        assetMetadata.seedSource === dataset,
      {
        schemaVersion: provenance.schemaVersion ?? null,
        recordId: provenance.recordId ?? null,
        sourceAssetId,
        dataset,
        assetSeedSource: assetMetadata.seedSource ?? null,
      },
    ),
    check(
      "manifest_mismatch",
      manifest.schemaVersion === 1 &&
        manifest.kind === EDITORIAL_RELEASE_MANIFEST_KIND &&
        placements.length === 1 &&
        avatarAssetId !== null &&
        avatarAssetId === sourceAssetId &&
        avatarPlacements[0]?.slotVersion === 1,
      {
        schemaVersion: manifest.schemaVersion ?? null,
        kind: manifest.kind ?? null,
        placementCount: placements.length,
        avatarPlacementCount: avatarPlacements.length,
        avatarAssetId,
        sourceAssetId,
      },
    ),
    check(
      "qualification_mismatch",
      Boolean(
        qualification &&
          qualification.kind === "editorial_import" &&
          qualification.validationRunId === null &&
          qualification.revokedAt === null &&
          qualification.releaseSnapshotHash === release.snapshotHash &&
          qualificationEvidence.schemaVersion ===
            PUBLIC_CATALOG_QUALIFICATION_SCHEMA_VERSION &&
          qualificationEvidence.policyVersion ===
            PUBLIC_CATALOG_EDITORIAL_IMPORT_POLICY_VERSION &&
          qualificationEvidence.characterId === characterId &&
          qualificationEvidence.sourceAssetId === avatarAssetId &&
          qualificationChecks.exactSeedRecord === true &&
          qualificationChecks.nonSynthetic === true &&
          qualificationChecks.safetyPassed === true &&
          qualificationChecks.publicPack === true &&
          qualificationChecks.imageAvailable === true,
      ),
      {
        qualificationId: qualification?.id ?? null,
        kind: qualification?.kind ?? null,
        validationRunId: qualification?.validationRunId ?? null,
        revokedAt: qualification?.revokedAt?.toISOString() ?? null,
        releaseSnapshotHash:
          qualification?.releaseSnapshotHash ?? null,
        evidenceSchemaVersion:
          qualificationEvidence.schemaVersion ?? null,
        evidencePolicyVersion:
          qualificationEvidence.policyVersion ?? null,
      },
    ),
    check("asset_missing", asset !== null, {
      assetId: avatarAssetId,
    }),
    check(
      "asset_character_mismatch",
      Boolean(asset && asset.characterId === characterId),
      {
        assetId: asset?.id ?? avatarAssetId,
        assetCharacterId: asset?.characterId ?? null,
        expectedCharacterId: characterId,
      },
    ),
    check(
      "asset_not_publishable",
      Boolean(
        asset &&
          asset.type === "image" &&
          asset.deletedAt === null &&
          asset.visibility === "public_pack" &&
          asset.safetyStatus === "passed" &&
          nonBlankString(asset.url) !== null &&
          publishability.publishable,
      ),
      {
        assetId: asset?.id ?? avatarAssetId,
        type: asset?.type ?? null,
        deletedAt: asset?.deletedAt?.toISOString() ?? null,
        visibility: asset?.visibility ?? null,
        safetyStatus: asset?.safetyStatus ?? null,
        hasUrl: nonBlankString(asset?.url) !== null,
        publishabilityReasons: publishability.reasons,
      },
    ),
  ];
  const failures = checks.filter((item) => !item.passed);
  const repairableCodes = new Set<EditorialReleaseAuthorityFailureCode>([
    "release_not_ready",
    "asset_character_mismatch",
  ]);
  return {
    releaseId: release.id,
    characterId,
    assetId: avatarAssetId,
    valid: failures.length === 0,
    repairable:
      failures.length > 0 &&
      failures.every((item) => repairableCodes.has(item.code)) &&
      (asset?.characterId === null ||
        asset?.characterId === characterId) &&
      release.readiness === "stale",
    checks,
    failures,
  };
}

export async function evaluateEditorialReleaseAuthority(
  db: PrismaClient,
  input: {
    readonly releaseId: string;
    readonly projectionState?: "live" | "paused";
  },
) {
  return db.$transaction((tx) =>
    evaluateEditorialReleaseAuthorityInTransaction(tx, input),
  );
}
