import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { actorWithPermission } from "@/server/modules/admin-v2/shared/authority";
import { CHARACTER_RELEASE_POLICY_VERSION, validateCharacterReleaseSnapshot } from "./release-executor";
import { findOperationalGenerationRoute } from "./visual-authority";
import { env } from "@/server/lib/env";
import {
  characterQaAuthorityMatches,
} from "@idream/shared/admin";
import {
  characterReleaseSnapshotHash,
  characterVisualProfileSnapshotHash,
  referenceSetSnapshotHash,
} from "./release-snapshot";
import { toInputJson } from "../shared/prisma-json";
import { canonicalSha256 } from "../shared/canonical-json";
import {
  isCharacterProjectPhaseTransitionAllowed,
  isCharacterReleaseTransitionAllowed,
} from "../shared/state-transition-authority";
import { characterIdentityReviewEvidencePassed } from "../shared/creative-review-quality";
import {
  lockCharacterGenerationAuthority,
  lockCharacterMediaAssetAuthorities,
} from "./generation-authority-lock";
import {
  characterReferenceMediaAuthoritySelect,
  unavailableCharacterReferenceMediaIds,
} from "./reference-media-authority";
import { findLatestCharacterQaAuthorityRun } from "./qa-authority";
import {
  hasHydratableMediaBlobAuthority,
  isMediaAssetOperationalForAuthority,
} from "@/server/lib/media-asset-authority";
import {
  discoverDraftAssetPackSourceAssetIds,
  evaluateDraftAssetPackAuthority,
} from "./draft-asset-pack-authority";
import { draftAssetRouteEntries } from "./draft-asset-route-authority";

type DraftPackEntry = {
  assetId: string;
  runId: string | null;
  itemId: string | null;
  reviewDecisionId: string | null;
  generationJobId: string | null;
  generationRouteFingerprint: string | null;
  bootstrapIdentity: boolean;
  selectedFromProject: boolean;
};

function draftPackEntry(value: Prisma.JsonValue, key: string): DraftPackEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const field = (value as Record<string, unknown>)[key];
  if (typeof field === "string") {
    return {
      assetId: field,
      runId: null,
      itemId: null,
      reviewDecisionId: null,
      generationJobId: null,
      generationRouteFingerprint: null,
      bootstrapIdentity: false,
      selectedFromProject: true,
    };
  }
  if (!field || typeof field !== "object" || Array.isArray(field)) return null;
  const entry = field as Record<string, unknown>;
  if (typeof entry.assetId !== "string") return null;
  return {
    assetId: entry.assetId,
    runId: typeof entry.runId === "string" ? entry.runId : null,
    itemId: typeof entry.itemId === "string" ? entry.itemId : null,
    reviewDecisionId: typeof entry.reviewDecisionId === "string" ? entry.reviewDecisionId : null,
    generationJobId: typeof entry.generationJobId === "string" ? entry.generationJobId : null,
    generationRouteFingerprint:
      typeof entry.generationRouteFingerprint === "string"
        ? entry.generationRouteFingerprint
        : null,
    bootstrapIdentity: entry.bootstrapIdentity === true,
    selectedFromProject: true,
  };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function jsonStringArray(value: Prisma.JsonValue | null): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function referenceManifestEntries(value: Prisma.JsonValue | null) {
  return Array.isArray(value) ? value.map(record) : [];
}

export async function proposeCharacterRelease(input: {
  request: Request;
  characterId: string;
  expectedProjectVersion: number;
  qaRunId: string;
  reason: string;
  actor?: { readonly id: string; readonly role: string };
  requestId?: string;
}, db?: Prisma.TransactionClient) {
  const actor = input.actor ?? await actorWithPermission(input.request, "character.release.propose", { characterId: input.characterId });
  const execute = async (tx: Prisma.TransactionClient) => {
    await lockCharacterGenerationAuthority(tx, input.characterId);
    const project = await tx.characterProject.findFirst({
      where: { characterId: input.characterId },
    });
    if (!project) throw Errors.notFound("Character Project not found");
    if (project.version !== input.expectedProjectVersion) {
      throw Errors.conflict("Character Project changed before Release proposal");
    }
    const referenceAuthority = await tx.characterVisualProfile.findFirst({
      where: { characterId: input.characterId, status: "active" },
      select: {
        referenceSetRevisions: {
          where: { status: "active" },
          orderBy: { revision: "desc" },
          take: 1,
          select: {
            references: {
              select: { mediaAssetId: true },
              orderBy: { position: "asc" },
            },
          },
        },
      },
      orderBy: { version: "desc" },
    });
    const draftAssetIds = Object.values(
      draftAssetRouteEntries(project.draftAssetPack),
    ).map((entry) => entry.assetId);
    const sourceAssetIds = await discoverDraftAssetPackSourceAssetIds(
      tx,
      project.draftAssetPack,
    );
    const authorityLockedAssetIds = [
      ...(referenceAuthority?.referenceSetRevisions[0]?.references.map(
        (reference) => reference.mediaAssetId,
      ) ?? []),
      ...draftAssetIds,
      ...sourceAssetIds,
    ];
    await lockCharacterMediaAssetAuthorities(
      tx,
      authorityLockedAssetIds,
    );

    if (
      project.phase !== "qa" &&
      !isCharacterProjectPhaseTransitionAllowed(project.phase, "qa")
    ) {
      throw Errors.conflict("Character Project cannot enter QA from its present phase", {
        from: project.phase,
        to: "qa",
      });
    }
    const existing = await tx.characterRelease.findFirst({
      where: { projectId: project.id, status: { in: ["draft", "validating", "in_review", "approved"] } },
    });
    if (existing) throw Errors.conflict("Character Project already has an active candidate Release", { releaseId: existing.id });
    const character = await tx.character.findUnique({ where: { id: input.characterId } });
    const revision = await tx.characterRevision.findFirst({ where: { projectId: project.id }, orderBy: { revision: "desc" } });
    const qaRun = await tx.characterQaRun.findUnique({ where: { id: input.qaRunId } });
    const profile = await tx.characterVisualProfile.findFirst({ where: { characterId: input.characterId, status: "active" }, orderBy: { version: "desc" } });
    const referenceSet = profile ? await tx.referenceSetRevision.findFirst({
      where: { visualProfileId: profile.id, status: "active" },
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
      orderBy: { revision: "desc" },
    }) : null;
    const visualProfileHash = profile
      ? characterVisualProfileSnapshotHash(profile)
      : null;
    const referenceSetHash = referenceSet
      ? referenceSetSnapshotHash(referenceSet)
      : null;
    const route = profile ? await findOperationalGenerationRoute(tx, {
      style: profile.style,
      policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
      evaluatorVersion: env.GENERATION_ROUTE_EVALUATOR_VERSION,
      at: new Date(),
      requiredReferenceCount: referenceSet?.references.length ?? 0,
      requiredReferenceRoles:
        referenceSet?.references.map((reference) => reference.role) ?? [],
    }) : null;
    const exactDraftAssetPackAuthority =
      profile && referenceSet && route
        ? await evaluateDraftAssetPackAuthority(tx, {
            characterId: input.characterId,
            draftAssetPack: project.draftAssetPack,
            visualProfile: profile,
            referenceSet,
            currentRoute: route,
            authorityLockedAssetIds,
          })
        : null;
    const coverPackEntry = draftPackEntry(project.draftAssetPack, "character_cover");
    const draftAssetEntries = [
      {
        purpose: "character_cover",
        slotKey: "character_avatar",
        ...(coverPackEntry && (!project.draftImageAssetId || coverPackEntry.assetId === project.draftImageAssetId)
          ? coverPackEntry
          : {
              assetId: project.draftImageAssetId ?? character?.imageAssetId ?? null,
              runId: null,
              itemId: null,
              reviewDecisionId: null,
              generationJobId: null,
              generationRouteFingerprint: null,
              bootstrapIdentity: false,
              selectedFromProject: Boolean(project.draftImageAssetId),
            }),
      },
      { purpose: "character_hero", slotKey: "character_hero", ...draftPackEntry(project.draftAssetPack, "character_hero") },
      { purpose: "character_chat", slotKey: "character_chat", ...draftPackEntry(project.draftAssetPack, "character_chat") },
    ].filter((entry): entry is { purpose: string; slotKey: string } & DraftPackEntry => typeof entry.assetId === "string");
    const draftAssets = await tx.mediaAsset.findMany({
      where: { id: { in: [...new Set(draftAssetEntries.map((entry) => entry.assetId))] } },
    });
    const draftAssetById = new Map(draftAssets.map((asset) => [asset.id, asset]));
    const releaseImageAssetId = draftAssetEntries.find((entry) => entry.slotKey === "character_avatar")?.assetId ?? null;
    const releaseImageAsset = releaseImageAssetId ? draftAssetById.get(releaseImageAssetId) ?? null : null;
    const invalidPackEntries = draftAssetEntries.filter((entry) => {
      const asset = draftAssetById.get(entry.assetId);
      if (
        !asset ||
        asset.deletedAt ||
        asset.safetyStatus !== "passed" ||
        !isMediaAssetOperationalForAuthority(asset.metadata) ||
        !hasHydratableMediaBlobAuthority(asset)
      ) return true;
      return asset.characterId !== input.characterId;
    });
    const selectedEntries = draftAssetEntries.filter((entry) => entry.selectedFromProject);
    const selectedItems = await tx.contentProductionItem.findMany({
      where: { id: { in: selectedEntries.flatMap((entry) => entry.itemId ? [entry.itemId] : []) } },
      include: { batch: true, job: true },
    });
    const selectedItemById = new Map(selectedItems.map((item) => [item.id, item]));
    const latestDecisions = await tx.creativeReviewDecision.findMany({
      where: { runItemId: { in: selectedEntries.flatMap((entry) => entry.itemId ? [entry.itemId] : []) } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    const latestDecisionByItemId = new Map<string, (typeof latestDecisions)[number]>();
    for (const decision of latestDecisions) {
      if (!latestDecisionByItemId.has(decision.runItemId)) {
        latestDecisionByItemId.set(decision.runItemId, decision);
      }
    }
    const generationAttempts = await tx.generationAttempt.findMany({
      where: {
        requestId: {
          in: selectedEntries.flatMap((entry) => entry.generationJobId ? [entry.generationJobId] : []),
        },
        status: "succeeded",
      },
      orderBy: [{ requestId: "asc" }, { attemptNo: "desc" }],
    });
    const latestAttemptByJobId = new Map<string, (typeof generationAttempts)[number]>();
    for (const attempt of generationAttempts) {
      if (!latestAttemptByJobId.has(attempt.requestId)) {
        latestAttemptByJobId.set(attempt.requestId, attempt);
      }
    }
    const invalidLineageEntries = selectedEntries.filter((entry) => {
      if (!entry.runId || !entry.itemId || !entry.reviewDecisionId || !entry.generationJobId) return true;
      const item = selectedItemById.get(entry.itemId);
      const latestDecision = latestDecisionByItemId.get(entry.itemId);
      const asset = draftAssetById.get(entry.assetId);
      const job = item?.job ?? null;
      const latestAttempt = latestAttemptByJobId.get(entry.generationJobId);
      const sourceMeta = record(job?.sourceMeta);
      const manifestEntries = referenceManifestEntries(job?.referenceManifest ?? null);
      const manifestAssetIds = manifestEntries.flatMap((manifestEntry) =>
        typeof manifestEntry.mediaAssetId === "string" ? [manifestEntry.mediaAssetId] : []
      );
      const referenceAssetIds = jsonStringArray(job?.referenceAssetIds ?? null);
      const exactRouteFingerprintMatches =
        sourceMeta.generationRouteQualificationId === route?.id &&
        sourceMeta.generationRouteFingerprint === route?.routeFingerprint &&
        entry.generationRouteFingerprint === route?.routeFingerprint;
      const bootstrapAuthorityMatches = Boolean(
        entry.bootstrapIdentity &&
        entry.purpose === "character_cover" &&
        job &&
        profile &&
        referenceSet &&
        sourceMeta.bootstrapIdentity === true &&
        job.visualProfileId === null &&
        job.referenceSetRevisionId === null &&
        jsonStringArray(job.referenceAssetIds).length === 0 &&
        (!Array.isArray(job.referenceManifest) || job.referenceManifest.length === 0) &&
        profile.createdFrom === `identity_bootstrap:${entry.generationJobId}` &&
        referenceSet.createdFrom === `identity_bootstrap:${entry.generationJobId}` &&
        profile.evidenceState === "reviewed_bootstrap" &&
        record(profile.adapterRefs).bootstrapIdentity === true &&
        record(profile.adapterRefs).generationJobId === entry.generationJobId &&
        referenceSet.references.some((reference) => reference.mediaAssetId === entry.assetId),
      );
      const qualifiedIdentityRouteMatches = Boolean(
        !entry.bootstrapIdentity &&
        job &&
        profile &&
        referenceSet &&
        route &&
        latestAttempt &&
        job.visualProfileId === profile.id &&
        job.visualProfileVersion === profile.version &&
        job.referenceSetRevisionId === referenceSet.id &&
        referenceAssetIds.length > 0 &&
        manifestEntries.length > 0 &&
        canonicalSha256([...referenceAssetIds].sort()) === canonicalSha256([...manifestAssetIds].sort()) &&
        manifestEntries.every((manifestEntry) =>
          manifestEntry.referenceSetRevisionId === referenceSet.id &&
          manifestEntry.snapshotHash === referenceSet.snapshotHash
        ) &&
        sourceMeta.referenceSetRevisionId === referenceSet.id &&
        exactRouteFingerprintMatches &&
        job.profileId === route.generationProfileKey &&
        job.profileVersion === route.generationProfileVersion &&
        job.model === route.workflowKey &&
        latestAttempt.profileKey === route.generationProfileKey &&
        latestAttempt.profileVersion === route.generationProfileVersion &&
        latestAttempt.workflowKey === route.workflowKey &&
        latestAttempt.workflowVersion === route.workflowVersion,
      );
      return !item ||
        item.batchId !== entry.runId ||
        item.jobId !== entry.generationJobId ||
        item.mediaAssetId !== entry.assetId ||
        item.batch.targetType !== "character" ||
        item.batch.targetId !== input.characterId ||
        item.batch.purpose !== entry.purpose ||
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
        sourceMeta.purpose !== entry.purpose ||
        sourceMeta.targetType !== "character" ||
        sourceMeta.targetId !== input.characterId ||
        sourceMeta.bootstrapIdentity !== entry.bootstrapIdentity ||
        !job.profileId ||
        !job.profileVersion ||
        !job.model ||
        !job.provider ||
        !asset ||
        asset.sourceJobId !== job.id ||
        !latestAttempt ||
        latestAttempt.status !== "succeeded" ||
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
        (!bootstrapAuthorityMatches && !qualifiedIdentityRouteMatches);
    });
    const unavailableReferenceMediaIds = referenceSet
      ? unavailableCharacterReferenceMediaIds(
          referenceSet.references,
          input.characterId,
        )
      : [];
    const qaAuthoritySnapshot = revision ? {
      characterId: input.characterId,
      projectId: project.id,
      characterContentVersionId: revision.characterContentVersionId,
      projectVersion: project.version,
      visualProfileId: profile?.id ?? null,
      visualProfileVersion: profile?.version ?? null,
      visualProfileHash,
      referenceSetRevisionId: referenceSet?.id ?? null,
      referenceSetRevision: referenceSet?.revision ?? null,
      referenceSetHash,
      draftAssetPackHash: canonicalSha256(project.draftAssetPack),
    } : null;
    const latestQaRun = qaAuthoritySnapshot
      ? await findLatestCharacterQaAuthorityRun(tx, qaAuthoritySnapshot)
      : null;
    const blockers = [
      ...(!character ? ["character_missing"] : []),
      ...(!revision ? ["revision_missing"] : []),
      ...(!qaRun || qaRun.status !== "passed" ? ["character_qa_not_passed"] : []),
      ...(qaRun && qaAuthoritySnapshot &&
        !characterQaAuthorityMatches(qaRun, qaAuthoritySnapshot)
        ? ["character_qa_authority_mismatch"]
        : []),
      ...(qaRun && qaAuthoritySnapshot && latestQaRun?.id !== qaRun.id
        ? ["character_qa_not_latest_authority"]
        : []),
      ...(!profile?.immutableHash
        ? ["active_visual_profile_missing_or_unsealed"]
        : profile.immutableHash !== visualProfileHash
          ? ["active_visual_profile_hash_invalid"]
          : []),
      ...(!referenceSet?.snapshotHash || !referenceSet.references.length
        ? ["active_reference_set_missing_or_empty"]
        : referenceSet.snapshotHash !== referenceSetHash
          ? ["active_reference_set_hash_invalid"]
          : []),
      ...(unavailableReferenceMediaIds.length > 0
        ? ["active_reference_set_media_unavailable"]
        : []),
      ...(!route ? ["qualified_generation_route_missing"] : []),
      ...(!releaseImageAsset ||
        releaseImageAsset.deletedAt ||
        releaseImageAsset.safetyStatus !== "passed" ||
        !isMediaAssetOperationalForAuthority(releaseImageAsset.metadata) ||
        !hasHydratableMediaBlobAuthority(releaseImageAsset)
        ? ["approved_avatar_missing"]
        : []),
      ...(draftAssetEntries.length !== 3 ||
        selectedEntries.length !== 3 ||
        exactDraftAssetPackAuthority?.ready !== true
        ? ["approved_asset_pack_incomplete"]
        : []),
      ...(invalidPackEntries.length > 0 ||
        (exactDraftAssetPackAuthority?.invalidAssetPurposes.length ?? 0) > 0
        ? ["approved_asset_pack_invalid"]
        : []),
      ...(invalidLineageEntries.length > 0 ||
        (exactDraftAssetPackAuthority?.invalidLineagePurposes.length ?? 0) > 0
        ? ["approved_asset_pack_lineage_invalid"]
        : []),
    ];
    if (blockers.length > 0) throw Errors.conflict("Character is not ready to propose a Release", { blockers });
    const placementGenerationProvenance = draftAssetEntries.map((entry) => {
      const item = selectedItemById.get(entry.itemId!)!;
      const job = item.job!;
      const attempt = latestAttemptByJobId.get(job.id)!;
      return {
        slotKey: entry.slotKey,
        assetId: entry.assetId,
        runId: entry.runId,
        itemId: entry.itemId,
        reviewDecisionId: entry.reviewDecisionId,
        generationJobId: job.id,
        generationRouteFingerprint: entry.generationRouteFingerprint,
        bootstrapIdentity: entry.bootstrapIdentity,
        generationProfileKey: job.profileId,
        generationProfileVersion: job.profileVersion,
        workflowKey: job.model,
        workflowVersion: attempt.workflowVersion,
        visualProfileId: job.visualProfileId,
        visualProfileVersion: job.visualProfileVersion,
        referenceSetRevisionId: job.referenceSetRevisionId,
        referenceAssetIds: jsonStringArray(job.referenceAssetIds),
        referenceManifestHash: job.referenceManifest
          ? canonicalSha256(job.referenceManifest)
          : null,
        provider: job.provider,
        deliveredOutputCount: job.deliveredOutputCount,
        attemptId: attempt.id,
        attemptNo: attempt.attemptNo,
        completedAt: job.completedAt?.toISOString() ?? null,
      };
    });
    const generationProvenance = {
      schemaVersion: "character-release-generation-provenance-v2",
      policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
      requiredReleaseRoute: {
        routeFingerprint: route!.routeFingerprint,
        matrixKey: route!.matrixKey,
        generationProfileKey: route!.generationProfileKey,
        generationProfileVersion: route!.generationProfileVersion,
        workflowKey: route!.workflowKey,
        workflowVersion: route!.workflowVersion,
      },
      visualAuthority: {
        visualProfileId: profile!.id,
        visualProfileVersion: profile!.version,
        visualProfileHash: profile!.immutableHash,
        referenceSetRevisionId: referenceSet!.id,
        referenceSetHash: referenceSet!.snapshotHash,
      },
      placements: placementGenerationProvenance,
      characterQa: {
        status: "passed",
        qaRunId: qaRun!.id,
        evidenceHash: qaRun!.evidenceHash,
        characterId: qaRun!.characterId,
        projectId: qaRun!.projectId,
        characterContentVersionId: qaRun!.characterContentVersionId,
        projectVersion: qaRun!.projectVersion,
        visualProfileId: qaRun!.visualProfileId,
        visualProfileVersion: qaRun!.visualProfileVersion,
        visualProfileHash: qaRun!.visualProfileHash,
        referenceSetRevisionId: qaRun!.referenceSetRevisionId,
        referenceSetRevision: qaRun!.referenceSetRevision,
        referenceSetHash: qaRun!.referenceSetHash,
        draftAssetPackHash: qaRun!.draftAssetPackHash,
      },
    };
    const releasePlacementManifest = {
      schemaVersion: 2,
      placements: draftAssetEntries.map((entry) => ({
        slotKey: entry.slotKey,
        assetId: entry.assetId,
        slotVersion: 1,
        ...(entry.runId ? { runId: entry.runId } : {}),
        ...(entry.itemId ? { itemId: entry.itemId } : {}),
        ...(entry.reviewDecisionId ? { reviewDecisionId: entry.reviewDecisionId } : {}),
        ...(entry.generationJobId ? { generationJobId: entry.generationJobId } : {}),
        ...(entry.bootstrapIdentity ? { bootstrapIdentity: true } : {}),
      })),
    };
    const snapshot = {
      projectId: project.id,
      revisionId: revision!.id,
      characterContentVersionId: revision!.characterContentVersionId,
      visualProfileId: profile!.id,
      visualProfileVersion: profile!.version,
      referenceSetRevisionId: referenceSet!.id,
      generationProvenance,
      releasePlacementManifest,
    };
    const projectUpdated = await tx.characterProject.updateMany({
      where: {
        id: project.id,
        version: project.version,
        phase: project.phase,
      },
      data: { phase: "qa", version: { increment: 1 } },
    });
    if (projectUpdated.count !== 1) {
      throw Errors.conflict("Character Project changed before Release proposal");
    }
    const release = await tx.characterRelease.create({ data: {
      ...snapshot,
      generationProvenance: toInputJson(generationProvenance),
      releasePlacementManifest: toInputJson(releasePlacementManifest),
      snapshotHash: characterReleaseSnapshotHash(snapshot),
      status: "in_review",
      readiness: "unknown",
    } });
    await tx.adminAuditLog.create({ data: {
      actorId: actor.id,
      actorRole: actor.role,
      action: "character.release.proposed",
      targetType: "character_release",
      targetId: release.id,
      reason: input.reason,
      after: toInputJson({ characterId: input.characterId, releaseId: release.id, snapshotHash: release.snapshotHash, status: release.status }),
      requestId: input.requestId ?? input.request.headers.get("x-request-id"),
    } });
    await tx.adminCollaborationActivity.create({ data: { targetType: "character_release", targetId: release.id, kind: "status_change", actorId: actor.id, body: "Proposed immutable Character Release for review", metadata: toInputJson({ from: null, to: "in_review", characterId: input.characterId }), idempotencyKey: `character_release_proposed:${release.id}` } });
    await tx.mainOutboxEvent.create({ data: { eventType: "character.release.proposed.v2", aggregateType: "character_release", aggregateId: release.id, payload: toInputJson({ characterId: input.characterId, releaseId: release.id, snapshotHash: release.snapshotHash, version: release.version }) } });
    return release;
  };
  return db ? execute(db) : prisma.$transaction(execute);
}

export async function validateCharacterRelease(input: {
  request: Request;
  characterId: string;
  releaseId: string;
  expectedVersion: number;
  actor?: { readonly id: string; readonly role: string };
  requestId?: string;
}, db?: Prisma.TransactionClient) {
  const actor = input.actor ?? await actorWithPermission(input.request, "character.release.publish", { characterId: input.characterId });
  const execute = async (tx: Prisma.TransactionClient) => {
    const release = await tx.characterRelease.findUnique({ where: { id: input.releaseId } });
    if (!release) throw Errors.notFound("Character Release not found");
    const project = await tx.characterProject.findUnique({ where: { id: release.projectId } });
    if (!project || project.characterId !== input.characterId) throw Errors.notFound("Character Release not found for Character");
    if (release.version !== input.expectedVersion) throw Errors.conflict("Character Release changed before validation");
    if (release.status !== "approved") throw Errors.conflict("Only an approved Character Release can be validated");
    const validation = await validateCharacterReleaseSnapshot(tx, release, CHARACTER_RELEASE_POLICY_VERSION, new Date());
    const readiness = validation.failed.length === 0 ? "ready" : "blocked";
    await tx.characterRelease.update({ where: { id: release.id }, data: { readiness } });
    await tx.adminAuditLog.create({ data: {
      actorId: actor.id,
      actorRole: actor.role,
      action: "character.release.validated",
      targetType: "character_release",
      targetId: release.id,
      reason: `Release validation ${validation.run.result}`,
      before: toInputJson({ readiness: release.readiness }),
      after: toInputJson({ readiness, validationRunId: validation.run.id, snapshotHash: validation.run.snapshotHash, policyVersion: validation.run.policyVersion, failedChecks: validation.failed.map((check) => check.key) }),
      requestId: input.requestId ?? input.request.headers.get("x-request-id"),
    } });
    await tx.mainOutboxEvent.create({ data: {
      eventType: "character.release.validated.v2",
      aggregateType: "character_release",
      aggregateId: release.id,
      payload: toInputJson({ characterId: input.characterId, releaseId: release.id, validationRunId: validation.run.id, result: validation.run.result, snapshotHash: validation.run.snapshotHash, policyVersion: validation.run.policyVersion }),
    } });
    return {
      validationRunId: validation.run.id,
      result: validation.run.result,
      readiness,
      snapshotHash: validation.run.snapshotHash,
      policyVersion: validation.run.policyVersion,
      checks: validation.checks,
    };
  };
  return db ? execute(db) : prisma.$transaction(execute);
}

export async function reviewCharacterRelease(input: {
  request: Request;
  characterId: string;
  releaseId: string;
  expectedVersion: number;
  decision: "approved" | "changes_requested";
  reason: string;
  actor?: { readonly id: string; readonly role: string };
  requestId?: string;
}, db?: Prisma.TransactionClient) {
  const actor = input.actor ?? await actorWithPermission(input.request, "character.release.review", { characterId: input.characterId });
  const execute = async (tx: Prisma.TransactionClient) => {
    const release = await tx.characterRelease.findUnique({ where: { id: input.releaseId } });
    if (!release) throw Errors.notFound("Character Release not found");
    const project = await tx.characterProject.findUnique({ where: { id: release.projectId } });
    if (!project || project.characterId !== input.characterId) throw Errors.notFound("Character Release not found for Character");
    const status = input.decision === "approved" ? "approved" : "withdrawn";
    const projectPhase = input.decision === "approved" ? "launch_ready" : "producing";
    if (
      release.version !== input.expectedVersion ||
      !isCharacterReleaseTransitionAllowed(release.status, status) ||
      !isCharacterProjectPhaseTransitionAllowed(project.phase, projectPhase)
    ) {
      throw Errors.conflict("Release changed or transition is not allowed", {
        from: release.status,
        to: status,
        projectPhase: { from: project.phase, to: projectPhase },
      });
    }
    const releaseUpdated = await tx.characterRelease.updateMany({
      where: {
        id: release.id,
        version: release.version,
        status: release.status,
      },
      data: { status, version: { increment: 1 } },
    });
    const projectUpdated = await tx.characterProject.updateMany({
      where: {
        id: project.id,
        version: project.version,
        phase: project.phase,
      },
      data: { phase: projectPhase, version: { increment: 1 } },
    });
    if (releaseUpdated.count !== 1 || projectUpdated.count !== 1) {
      throw Errors.conflict("Release or Character Project changed during review");
    }
    const updated = await tx.characterRelease.findUniqueOrThrow({
      where: { id: release.id },
    });
    await tx.adminAuditLog.create({ data: {
      actorId: actor.id,
      actorRole: actor.role,
      action: `character.release.${input.decision}`,
      targetType: "character_release",
      targetId: release.id,
      reason: input.reason,
      before: toInputJson({ status: release.status, version: release.version }),
      after: toInputJson({ status: updated.status, version: updated.version, snapshotHash: updated.snapshotHash }),
      requestId: input.requestId ?? input.request.headers.get("x-request-id"),
    } });
    await tx.mainOutboxEvent.create({ data: { eventType: `character.release.${input.decision}.v2`, aggregateType: "character_release", aggregateId: release.id, payload: toInputJson({ characterId: input.characterId, releaseId: release.id, status: updated.status, version: updated.version }) } });
    return updated;
  };
  return db ? execute(db) : prisma.$transaction(execute);
}
