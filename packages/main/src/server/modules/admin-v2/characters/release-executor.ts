import type { Prisma, PrismaClient } from "@prisma/client";
import { env } from "@/server/lib/env";
import {
  evaluateMediaAssetCustomerPublishability,
  hasHydratableMediaBlobAuthority,
  nonSyntheticMediaAssetWhere,
} from "@/server/lib/media-asset-authority";
import { claimControlPlaneCommand } from "../shared/control-plane-command";
import { transitionControlPlaneCommandAttempt } from "../shared/control-plane-command-attempt";
import { transitionControlPlaneCommand } from "../shared/control-plane-command-transition";
import { toInputJson } from "../shared/prisma-json";
import {
  characterReleaseSnapshotHash,
  characterVisualProfileSnapshotHash,
  referenceSetSnapshotHash,
} from "./release-snapshot";
import { canonicalSha256 } from "../shared/canonical-json";
import { releaseMonitorDueAt } from "./release-monitor";
import {
  isCharacterProjectPhaseTransitionAllowed,
  isCharacterReleaseTransitionAllowed,
  isCharacterServingTransitionAllowed,
} from "../shared/state-transition-authority";
import { characterIdentityReviewEvidencePassed } from "../shared/creative-review-quality";
import {
  characterQaAuthorityMatches,
  characterQaProvenanceMatchesRun,
  parseCharacterReleaseAssetManifest,
} from "@idream/shared/admin";
import {
  lockCharacterGenerationAuthority,
  lockCharacterMediaAssetAuthorities,
} from "./generation-authority-lock";
import {
  characterReferenceMediaAuthoritySelect,
  unavailableCharacterReferenceMediaIds,
} from "./reference-media-authority";
import { findLatestCharacterQaAuthorityRun } from "./qa-authority";
import { PUBLIC_CATALOG_QUALIFICATION_SCHEMA_VERSION } from "@/server/modules/ourdream/public-catalog-qualification";
import { evaluateEditorialReleaseAuthorityInTransaction } from "@/server/modules/ourdream/public-release-authority";
import {
  evaluateEffectiveGenerationRouteAuthority,
  isOperatorSingleImageRoute,
} from "./generation-route-authority";
import {
  transitionCharacterProject,
  transitionCharacterRelease,
  transitionCharacterServing,
} from "./transition";

export const CHARACTER_RELEASE_POLICY_VERSION = "character-release-policy-v2";

// paused is an operator hold: an existing schedule remains durable and becomes
// eligible after resume. retired is terminal and cannot accept new schedules.
const SCHEDULABLE_SERVING_STATES = new Set(["inactive", "live"]);

type ReleaseCommandType =
  | "character.release.schedule"
  | "character.release.publish"
  | "character.release.rollback"
  | "character.serving.pause"
  | "character.serving.resume"
  | "character.serving.retire";

interface ExecuteReleaseCommandInput {
  readonly commandId: string;
  readonly workerId: string;
  readonly now?: Date;
  readonly leaseMs?: number;
  readonly policyVersion?: string;
  readonly afterClaim?: (commandId: string) => Promise<void>;
}

interface ReleaseCommandResult {
  readonly status: "succeeded" | "failed";
  readonly commandId: string;
  readonly releaseId: string;
  readonly errorCode?: string;
}

interface ValidationCheck {
  readonly key: string;
  readonly passed: boolean;
  readonly evidence: Record<string, unknown>;
}

class ReleaseCommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly evidence: Record<string, unknown> = {},
    readonly rollbackTransaction = false,
  ) {
    super(message);
    this.name = "ReleaseCommandError";
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function reasonFromPayload(value: Prisma.JsonValue): string {
  const payload = record(value);
  if (typeof payload.reason === "string") return payload.reason;
  const reason = payload.reason;
  if (reason && typeof reason === "object" && !Array.isArray(reason)) {
    const input = reason as Record<string, unknown>;
    return [input.code, input.summary, input.details]
      .filter((item): item is string => typeof item === "string")
      .join(": ");
  }
  return "Character Release command";
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

interface ReleasePlacement {
  readonly slotKey: string;
  readonly assetId: string;
  readonly runId: string | null;
  readonly itemId: string | null;
  readonly reviewDecisionId: string | null;
  readonly generationJobId: string | null;
  readonly bootstrapIdentity: boolean;
}

function releasePlacements(value: Prisma.JsonValue): ReleasePlacement[] {
  const placements = record(value).placements;
  if (!Array.isArray(placements)) return [];
  return placements.flatMap((item) => {
    const placement = record(item);
    const slotKey = stringValue(placement.slotKey);
    const assetId = stringValue(placement.assetId);
    if (!slotKey || !assetId) return [];
    return [{
      slotKey,
      assetId,
      runId: stringValue(placement.runId),
      itemId: stringValue(placement.itemId),
      reviewDecisionId: stringValue(placement.reviewDecisionId),
      generationJobId: stringValue(placement.generationJobId),
      bootstrapIdentity: placement.bootstrapIdentity === true,
    }];
  });
}

function jsonStringArray(value: Prisma.JsonValue | null): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function referenceManifestEntries(value: Prisma.JsonValue | null) {
  return Array.isArray(value) ? value.map(record) : [];
}

function requiredReleaseRoute(value: Prisma.JsonValue) {
  const provenance = record(value);
  return record(provenance.requiredReleaseRoute);
}

function hasCanonicalRequiredReleaseRoute(
  route: Record<string, unknown>,
) {
  const positiveVersion = (value: unknown) =>
    (typeof value === "number" && Number.isInteger(value) && value > 0) ||
    (typeof value === "string" &&
      value.trim().length > 0 &&
      value !== "unavailable");
  return stringValue(route.routeFingerprint) !== null &&
    stringValue(route.matrixKey) !== null &&
    stringValue(route.generationProfileKey) !== null &&
    positiveVersion(route.generationProfileVersion) &&
    stringValue(route.workflowKey) !== null &&
    positiveVersion(route.workflowVersion);
}

function placementAssetId(value: Prisma.JsonValue): string | null {
  return releasePlacements(value).find((item) => item.slotKey === "character_avatar")?.assetId ?? null;
}

function releasedCharacterProjection(content: {
  personaSnapshot: Prisma.JsonValue;
  openingSnapshot: Prisma.JsonValue;
  appearanceSnapshot: Prisma.JsonValue;
}) {
  const persona = record(content.personaSnapshot);
  const opening = record(content.openingSnapshot);
  const appearance = record(content.appearanceSnapshot);
  const name = stringValue(persona.name);
  const description = stringValue(persona.characterPromise) ?? stringValue(persona.description);
  const age = typeof persona.age === "number" && Number.isInteger(persona.age) && persona.age >= 18
    ? persona.age
    : null;
  const gender = stringValue(persona.gender);
  const relationship = stringValue(persona.relationshipArchetype);
  const style = stringValue(appearance.style);
  const firstMessage = stringValue(opening.firstMessage);
  if (!name || !description || age === null || !gender || !relationship || !style || !firstMessage) {
    throw new ReleaseCommandError(
      "release_content_projection_incomplete",
      "Release content cannot produce the complete serving projection",
      { name: Boolean(name), description: Boolean(description), age, gender, relationship, style, firstMessage: Boolean(firstMessage) },
    );
  }
  const systemPrompt = stringValue(persona.systemPrompt) ?? [
    stringValue(persona.personality),
    stringValue(persona.tone),
    stringValue(persona.backstory),
  ].filter((value): value is string => value !== null).join("\n\n");
  if (!systemPrompt) {
    throw new ReleaseCommandError(
      "release_content_projection_incomplete",
      "Release content has no serving system prompt",
    );
  }
  return {
    name,
    age,
    description,
    systemPrompt,
    style,
    gender,
    relationship,
    appearance: toInputJson(appearance),
    advancedDetails: toInputJson({ ...persona, ...opening }),
  };
}

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
  const revision = await tx.characterRevision.findUnique({
    where: { id: release.revisionId },
  });
  const content = await tx.characterContentVersion.findUnique({
    where: { id: release.characterContentVersionId },
  });
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
  const provenance = record(release.generationProvenance);
  const releaseRoute = requiredReleaseRoute(release.generationProvenance);
  const routeFingerprint = stringValue(releaseRoute.routeFingerprint);
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
  const characterQa = record(provenance.characterQa);
  const strictCharacterQa =
    release.legacy === false &&
    provenance.schemaVersion ===
      "character-release-generation-provenance-v2" &&
    provenance.policyVersion === CHARACTER_RELEASE_POLICY_VERSION &&
    policyVersion === CHARACTER_RELEASE_POLICY_VERSION &&
    hasCanonicalRequiredReleaseRoute(releaseRoute);
  const characterQaRunId = stringValue(characterQa.qaRunId);
  const characterQaRun = characterQaRunId
    ? await tx.characterQaRun.findUnique({ where: { id: characterQaRunId } })
    : null;
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
  const avatarAssetId = placementAssetId(release.releasePlacementManifest);
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
  const expectedPurposeBySlot: Record<string, string> = {
    character_avatar: "character_cover",
    character_hero: "character_hero",
    character_chat: "character_chat",
  };
  const rawPlacementProvenance = Array.isArray(provenance.placements)
    ? provenance.placements.map(record)
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
            pinned: stringValue(pinned?.provider),
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
      item.batch.purpose !== expectedPurposeBySlot[placement.slotKey] ||
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
    const sourceMeta = record(job?.sourceMeta);
    const manifestEntries = referenceManifestEntries(job?.referenceManifest ?? null);
    const manifestAssetIds = manifestEntries.flatMap((manifestEntry) =>
      typeof manifestEntry.mediaAssetId === "string" ? [manifestEntry.mediaAssetId] : []
    );
    const referenceAssetIds = jsonStringArray(job?.referenceAssetIds ?? null);
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
      sourceMeta.purpose === expectedPurposeBySlot[placement.slotKey] &&
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
      record(profile.adapterRefs).bootstrapIdentity === true &&
      record(profile.adapterRefs).generationJobId === job.id &&
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
  const persona = content ? record(content.personaSnapshot) : {};
  const opening = content ? record(content.openingSnapshot) : {};
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
      passed: project !== null,
      evidence: {
        projectId: release.projectId,
        characterId: project?.characterId ?? null,
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
      key: "persona_complete",
      passed:
        content !== null &&
        (stringValue(persona.systemPrompt) !== null ||
          stringValue(persona.description) !== null),
      evidence: {
        characterContentVersionId: release.characterContentVersionId,
      },
    },
    {
      key: "opening_complete",
      passed: content !== null && stringValue(opening.firstMessage) !== null,
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
        characterQaRun.evidenceHash === stringValue(characterQa.evidenceHash) &&
        latestCharacterQaRun?.id === characterQaRun.id &&
        (!strictCharacterQa || (
          characterQaProvenanceMatchesRun(characterQa, characterQaRun) &&
          characterQaAuthorityMatches(characterQaRun, {
            characterId: project?.characterId ?? null,
            projectId: release.projectId,
            characterContentVersionId: release.characterContentVersionId,
            projectVersion: characterQaRun.projectVersion,
            visualProfileId: release.visualProfileId,
            visualProfileVersion: release.visualProfileVersion,
            visualProfileHash: currentVisualHash,
            referenceSetRevisionId: release.referenceSetRevisionId,
            referenceSetRevision: referenceSet?.revision ?? null,
            referenceSetHash: currentReferenceHash,
            draftAssetPackHash: characterQaRun.draftAssetPackHash,
          })
        )),
      evidence: {
        status: characterQa.status ?? null,
        qaRunId: characterQaRunId,
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
  const run = await tx.releaseValidationRun.create({
    data: {
      releaseId: release.id,
      snapshotHash: canonicalSnapshotHash,
      policyVersion,
      result: failed.length === 0 ? "passed" : "failed",
      startedAt: now,
      finishedAt: now,
    },
  });
  await tx.releaseCheckResult.createMany({
    data: checks.map((check) => ({
      validationRunId: run.id,
      checkKey: check.key,
      result: check.passed ? "passed" : "failed",
      evidence: toInputJson(check.evidence),
      checkedAt: now,
    })),
  });
  return { run, checks, failed, project, content, avatarAssetId };
}

async function finishAttempt(
  tx: Prisma.TransactionClient,
  command: { id: string; attemptCount: number },
  status: "succeeded" | "failed",
  now: Date,
  error?: Record<string, unknown>,
) {
  await transitionControlPlaneCommandAttempt(tx, {
    commandId: command.id,
    attemptNo: command.attemptCount,
    to: status,
    data: {
      finishedAt: now,
      error: error ? toInputJson(error) : undefined,
    },
  });
}

async function failCommand(
  tx: Prisma.TransactionClient,
  command: { id: string; attemptCount: number; leaseOwner: string | null },
  error: ReleaseCommandError,
  now: Date,
) {
  const errorBody = {
    code: error.code,
    message: error.message,
    ...error.evidence,
  };
  await transitionControlPlaneCommand(tx, {
    commandId: command.id,
    to: "failed",
    expected: { from: "running", leaseOwner: command.leaseOwner, attemptCount: command.attemptCount },
    data: {
      error: toInputJson(errorBody),
      needsReconciliation: false,
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      finishedAt: now,
    },
  });
  await finishAttempt(tx, command, "failed", now, errorBody);
}

async function appendExecutionEvidence(
  tx: Prisma.TransactionClient,
  input: {
    command: {
      id: string;
      actorId: string;
      requestPayload: Prisma.JsonValue;
      requestHash: string;
      requestId: string;
      attemptCount: number;
    };
    commandType: ReleaseCommandType;
    releaseId: string;
    characterId: string;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
    eventType: string;
    now: Date;
    result: Record<string, unknown>;
  },
) {
  const actor = await tx.user.findUnique({
    where: { id: input.command.actorId },
    select: { role: true },
  });
  const reason = reasonFromPayload(input.command.requestPayload);
  await tx.characterReleaseEvent.create({
    data: {
      releaseId: input.releaseId,
      characterId: input.characterId,
      type: input.eventType,
      actorId: input.command.actorId,
      commandId: input.command.id,
      reason,
      fromState: toInputJson(input.before),
      toState: toInputJson(input.after),
      evidence: toInputJson({
        requestHash: input.command.requestHash,
        policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
      }),
      occurredAt: input.now,
    },
  });
  await tx.adminAuditLog.create({
    data: {
      actorId: input.command.actorId,
      actorRole: actor?.role ?? "unknown",
      action: `${input.commandType}.executed`,
      targetType: "character_release",
      targetId: input.releaseId,
      reason,
      before: toInputJson(input.before),
      after: toInputJson(input.after),
      requestId: input.command.id,
    },
  });
  await tx.mainOutboxEvent.create({
    data: {
      eventType: `${input.eventType}.v2`,
      aggregateType: "character_release",
      aggregateId: input.releaseId,
      payload: toInputJson({
        commandId: input.command.id,
        characterId: input.characterId,
        releaseId: input.releaseId,
        occurredAt: input.now.toISOString(),
        ...input.result,
      }),
    },
  });
  await transitionControlPlaneCommand(tx, {
    commandId: input.command.id,
    to: "succeeded",
    expected: { from: "running", attemptCount: input.command.attemptCount },
    data: {
      result: toInputJson({
        ...input.result,
        releaseId: input.releaseId,
        verificationState: "passed",
      }),
      needsReconciliation: false,
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      finishedAt: input.now,
    },
  });
  await finishAttempt(tx, input.command, "succeeded", input.now);
}

async function executeSchedule(
  tx: Prisma.TransactionClient,
  command: Awaited<
    ReturnType<
      Prisma.TransactionClient["controlPlaneCommand"]["findUniqueOrThrow"]
    >
  >,
  policyVersion: string,
  now: Date,
) {
  const release = await tx.characterRelease.findUnique({
    where: { id: command.targetId },
  });
  if (!release)
    throw new ReleaseCommandError(
      "release_not_found",
      "Release does not exist",
    );
  if (
    release.version !== command.expectedVersion ||
    !isCharacterReleaseTransitionAllowed(release.status, "published")
  ) {
    throw new ReleaseCommandError(
      "release_version_conflict",
      "Only the expected approved Release can be scheduled",
    );
  }
  const validation = await validateCharacterReleaseSnapshot(tx, release, policyVersion, now);
  if (validation.failed.length > 0) {
    await tx.characterRelease.update({
      where: { id: release.id },
      data: { readiness: "blocked" },
    });
    throw new ReleaseCommandError(
      "release_validation_failed",
      "Release validation failed",
      {
        blockers: validation.failed.map((item) => item.key),
        validationRunId: validation.run.id,
      },
    );
  }
  const payload = record(command.requestPayload);
  const scheduledAtText = stringValue(payload.scheduledAt);
  const scheduledAt = scheduledAtText ? new Date(scheduledAtText) : null;
  if (
    !scheduledAt ||
    !Number.isFinite(scheduledAt.getTime()) ||
    scheduledAt <= now
  ) {
    throw new ReleaseCommandError(
      "invalid_schedule_time",
      "scheduledAt must be a future ISO timestamp",
    );
  }
  const serving = await tx.characterServing.findUnique({
    where: { characterId: validation.project?.characterId ?? "" },
  });
  if (!serving || serving.currentReleaseId === release.id) {
    throw new ReleaseCommandError(
      "serving_conflict",
      "Release is already current or CharacterServing is missing",
    );
  }
  if (!SCHEDULABLE_SERVING_STATES.has(serving.state)) {
    throw new ReleaseCommandError(
      "serving_not_schedulable",
      "Only inactive or live CharacterServing can accept a Release schedule",
      { servingState: serving.state },
    );
  }
  const updated = await tx.characterServing.updateMany({
    where: { id: serving.id, version: serving.version },
    data: {
      scheduledReleaseId: release.id,
      scheduledAt,
      version: { increment: 1 },
    },
  });
  if (updated.count !== 1)
    throw new ReleaseCommandError(
      "serving_version_conflict",
      "CharacterServing changed while scheduling",
    );
  await tx.characterRelease.update({
    where: { id: release.id },
    data: { readiness: "ready" },
  });
  await appendExecutionEvidence(tx, {
    command,
    commandType: "character.release.schedule",
    releaseId: release.id,
    characterId: validation.project?.characterId ?? "",
    before: { serving },
    after: {
      scheduledReleaseId: release.id,
      scheduledAt: scheduledAt.toISOString(),
      servingVersion: serving.version + 1,
    },
    eventType: "character.release.scheduled",
    now,
    result: {
      scheduledAt: scheduledAt.toISOString(),
      validationRunId: validation.run.id,
    },
  });
  return release.id;
}

async function publishRelease(
  tx: Prisma.TransactionClient,
  command: Awaited<
    ReturnType<
      Prisma.TransactionClient["controlPlaneCommand"]["findUniqueOrThrow"]
    >
  >,
  release: Awaited<
    ReturnType<
      Prisma.TransactionClient["characterRelease"]["findUniqueOrThrow"]
    >
  >,
  policyVersion: string,
  now: Date,
) {
  if (
    release.version !== command.expectedVersion ||
    release.status !== "approved"
  ) {
    throw new ReleaseCommandError(
      "release_version_conflict",
      "Only the expected approved Release can be published",
    );
  }
  const project = await tx.characterProject.findUnique({
    where: { id: release.projectId },
  });
  const characterId = project?.characterId;
  if (!project || !characterId)
    throw new ReleaseCommandError(
      "project_missing",
      "Release Project is missing",
    );
  if (
    project.phase !== "live_management" &&
    !isCharacterProjectPhaseTransitionAllowed(
      project.phase,
      "live_management",
    )
  ) {
    throw new ReleaseCommandError(
      "project_phase_conflict",
      "Character Project cannot enter live management from its present phase",
      { projectPhase: project.phase },
    );
  }
  const validation = await validateCharacterReleaseSnapshot(tx, release, policyVersion, now);
  if (validation.failed.length > 0) {
    await tx.characterRelease.update({
      where: { id: release.id },
      data: { readiness: "blocked" },
    });
    throw new ReleaseCommandError(
      "release_validation_failed",
      "Release validation failed",
      {
        blockers: validation.failed.map((item) => item.key),
        validationRunId: validation.run.id,
      },
    );
  }
  const serving = await tx.characterServing.findUnique({
    where: { characterId },
  });
  if (!serving)
    throw new ReleaseCommandError(
      "serving_missing",
      "CharacterServing is missing",
    );
  const payload = record(command.requestPayload);
  if (payload.trigger === "scheduled_release_due") {
    const scheduledRelease = record(payload.scheduledRelease);
    const servingId = stringValue(scheduledRelease.servingId);
    const releaseId = stringValue(scheduledRelease.releaseId);
    const scheduledAtText = stringValue(scheduledRelease.scheduledAt);
    const scheduledAt = scheduledAtText ? new Date(scheduledAtText) : null;
    const servingVersion = scheduledRelease.servingVersion;
    const occurrenceIsCurrent =
      servingId === serving.id &&
      releaseId === release.id &&
      typeof servingVersion === "number" &&
      Number.isInteger(servingVersion) &&
      servingVersion === serving.version &&
      scheduledAt !== null &&
      Number.isFinite(scheduledAt.getTime()) &&
      scheduledAt.getTime() <= now.getTime() &&
      serving.scheduledReleaseId === release.id &&
      serving.scheduledAt?.getTime() === scheduledAt.getTime();
    if (!occurrenceIsCurrent) {
      throw new ReleaseCommandError(
        "scheduled_release_occurrence_changed",
        "The scheduled Release occurrence changed before publish execution",
        {
          expected: {
            servingId,
            servingVersion,
            releaseId,
            scheduledAt: scheduledAtText,
          },
          actual: {
            servingId: serving.id,
            servingVersion: serving.version,
            releaseId: serving.scheduledReleaseId,
            scheduledAt: serving.scheduledAt?.toISOString() ?? null,
          },
        },
      );
    }
  }
  if (serving.currentReleaseId === release.id) {
    throw new ReleaseCommandError(
      "release_already_current",
      "Release is already current",
    );
  }
  if (serving.scheduledReleaseId && serving.scheduledReleaseId !== release.id) {
    throw new ReleaseCommandError(
      "scheduled_release_conflict",
      "Another Release is scheduled",
    );
  }
  if (!isCharacterServingTransitionAllowed(serving.state, "live")) {
    throw new ReleaseCommandError(
      "serving_state_conflict",
      "CharacterServing cannot become live from its present state",
      { servingState: serving.state },
    );
  }
  await transitionCharacterServing(tx, {
    servingId: serving.id,
    to: "live",
    expected: {
      from: serving.state as "inactive" | "live",
      version: serving.version,
      currentReleaseId: serving.currentReleaseId,
    },
    data: {
      currentReleaseId: release.id,
      scheduledReleaseId: null,
      scheduledAt: null,
    },
  });
  if (serving.currentReleaseId) {
    const currentRelease = await tx.characterRelease.findUnique({
      where: { id: serving.currentReleaseId },
      select: { status: true, version: true },
    });
    if (
      currentRelease &&
      !isCharacterReleaseTransitionAllowed(currentRelease.status, "superseded")
    ) {
      throw new ReleaseCommandError(
        "current_release_transition_invalid",
        "Current Release cannot be superseded from its present state",
        { releaseId: serving.currentReleaseId, status: currentRelease.status },
        true,
      );
    }
    await transitionCharacterRelease(tx, {
      releaseId: serving.currentReleaseId,
      to: "superseded",
      expected: { from: "published", version: currentRelease!.version },
    });
  }
  await transitionCharacterRelease(tx, {
    releaseId: release.id,
    to: "published",
    expected: { from: "approved", version: release.version },
    data: {
      readiness: "ready",
      publishedAt: now,
      supersedesId: serving.currentReleaseId,
    },
  });
  if (project.phase !== "live_management") {
    await transitionCharacterProject(tx, {
      projectId: project.id,
      to: "live_management",
      expected: {
        from: project.phase as "idea" | "launch_ready",
        version: project.version,
      },
    });
  }
  const publishedAssetIds = [
    ...new Set(
      releasePlacements(release.releasePlacementManifest).map(
        (placement) => placement.assetId,
      ),
    ),
  ];
  const promotedAssets = await tx.mediaAsset.updateMany({
    where: {
      id: { in: publishedAssetIds },
      type: "image",
      deletedAt: null,
      safetyStatus: "passed",
      AND: [
        {
          OR: [{ characterId }, { characterId: null }],
        },
        nonSyntheticMediaAssetWhere,
      ],
    },
    data: { visibility: "public_pack" },
  });
  if (promotedAssets.count !== publishedAssetIds.length) {
    throw new ReleaseCommandError(
      "release_asset_promotion_failed",
      "Every published Release asset must become customer-readable",
      {
        expectedAssetIds: publishedAssetIds,
        promotedCount: promotedAssets.count,
      },
      true,
    );
  }
  await tx.character.update({
    where: { id: characterId },
    data: {
      ...releasedCharacterProjection(validation.content!),
      status: "approved",
      visibility: "public",
      imageAssetId: validation.avatarAssetId,
    },
  });
  // Keep the write order compatible with databases that still have the
  // original statement-time qualification trigger: the Release assets and
  // Character avatar projection must exist before qualification is inserted.
  // The current migration also checks the complete cross-row invariant at
  // transaction commit, so partial publication still cannot escape atomically.
  const publicQualification = await tx.publicCatalogQualification.upsert({
    where: { releaseId: release.id },
    update: {},
    create: {
      id: `catalog-qualification:${release.id}`,
      releaseId: release.id,
      releaseSnapshotHash: release.snapshotHash,
      kind: "generated_release",
      validationRunId: validation.run.id,
      evidence: {
        schemaVersion: PUBLIC_CATALOG_QUALIFICATION_SCHEMA_VERSION,
        policyVersion: validation.run.policyVersion,
        validationRunId: validation.run.id,
        commandId: command.id,
      },
      qualifiedAt: validation.run.finishedAt ?? now,
    },
  });
  if (
    publicQualification.revokedAt !== null ||
    publicQualification.kind !== "generated_release"
  ) {
    throw new ReleaseCommandError(
      "public_catalog_qualification_conflict",
      "Release public qualification is revoked or has a conflicting provenance kind",
      { qualificationId: publicQualification.id },
      true,
    );
  }
  for (const window of ["24h", "72h"] as const) {
    await tx.releaseMonitor.upsert({
      where: { releaseId_window: { releaseId: release.id, window } },
      create: {
        releaseId: release.id,
        window,
        status: "pending",
        baseline: {},
        observed: {},
        verification: { state: "pending" },
        startedAt: now,
        dueAt: releaseMonitorDueAt(now, window),
      },
      update: {},
    });
  }
  await appendExecutionEvidence(tx, {
    command,
    commandType: command.commandType as ReleaseCommandType,
    releaseId: release.id,
    characterId,
    before: {
      serving,
      releaseStatus: release.status,
      releaseVersion: release.version,
    },
    after: {
      currentReleaseId: release.id,
      servingState: "live",
      releaseStatus: "published",
      releaseVersion: release.version + 1,
    },
    eventType:
      command.commandType === "character.release.rollback"
        ? "character.release.rolled_back"
        : "character.release.published",
    now,
    result: {
      validationRunId: validation.run.id,
      previousReleaseId: serving.currentReleaseId,
    },
  });
  return release.id;
}

async function executeRollback(
  tx: Prisma.TransactionClient,
  command: Awaited<
    ReturnType<
      Prisma.TransactionClient["controlPlaneCommand"]["findUniqueOrThrow"]
    >
  >,
  policyVersion: string,
  now: Date,
) {
  const serving = await tx.characterServing.findUnique({
    where: { characterId: command.targetId },
  });
  if (!serving || serving.version !== command.expectedVersion) {
    throw new ReleaseCommandError(
      "serving_version_conflict",
      "CharacterServing version changed before rollback",
    );
  }
  const sourceReleaseId = stringValue(
    record(command.requestPayload).sourceReleaseId,
  );
  if (!sourceReleaseId)
    throw new ReleaseCommandError(
      "rollback_source_missing",
      "sourceReleaseId is required",
    );
  const source = await tx.characterRelease.findUnique({
    where: { id: sourceReleaseId },
  });
  if (!source)
    throw new ReleaseCommandError(
      "rollback_source_not_found",
      "Rollback source Release does not exist",
    );
  if (source.status !== "superseded") {
    throw new ReleaseCommandError(
      "rollback_source_not_superseded",
      "Rollback source must be a previously published superseded Release",
    );
  }
  const project = await tx.characterProject.findUnique({
    where: { id: source.projectId },
  });
  if (!project || project.characterId !== command.targetId) {
    throw new ReleaseCommandError(
      "rollback_source_character_mismatch",
      "Rollback source belongs to another Character",
    );
  }
  const rollbackId = `rollback:${command.id}`;
  const rollback = await tx.characterRelease.create({
    data: {
      id: rollbackId,
      projectId: source.projectId,
      revisionId: source.revisionId,
      characterContentVersionId: source.characterContentVersionId,
      visualProfileId: source.visualProfileId,
      visualProfileVersion: source.visualProfileVersion,
      referenceSetRevisionId: source.referenceSetRevisionId,
      generationProvenance: toInputJson(source.generationProvenance),
      releasePlacementManifest: toInputJson(source.releasePlacementManifest),
      snapshotHash: source.snapshotHash,
      readiness: "unknown",
      legacy: false,
      status: "approved",
      rollbackOfReleaseId: source.id,
      version: 1,
    },
  });
  const rollbackCommand = {
    ...command,
    targetId: rollback.id,
    expectedVersion: rollback.version,
  };
  return publishRelease(tx, rollbackCommand, rollback, policyVersion, now);
}

async function executeServingState(
  tx: Prisma.TransactionClient,
  command: Awaited<
    ReturnType<
      Prisma.TransactionClient["controlPlaneCommand"]["findUniqueOrThrow"]
    >
  >,
  policyVersion: string,
  now: Date,
) {
  await lockCharacterGenerationAuthority(tx, command.targetId);
  const character = await tx.character.findFirst({
    where: {
      id: command.targetId,
      deletedAt: null,
      status: { not: "removed" },
    },
    select: { id: true },
  });
  if (!character) {
    throw new ReleaseCommandError(
      "serving_character_unavailable",
      "Archived or removed Characters cannot change serving state",
    );
  }
  const serving = await tx.characterServing.findUnique({
    where: { characterId: command.targetId },
  });
  if (
    !serving ||
    serving.version !== command.expectedVersion ||
    !serving.currentReleaseId
  ) {
    throw new ReleaseCommandError(
      "serving_version_conflict",
      "CharacterServing changed or has no current Release",
    );
  }
  const release = await tx.characterRelease.findUnique({
    where: { id: serving.currentReleaseId },
  });
  const project = release
    ? await tx.characterProject.findUnique({ where: { id: release.projectId } })
    : null;
  if (
    !release ||
    release.status !== "published" ||
    release.publishedAt === null ||
    project?.characterId !== command.targetId
  ) {
    throw new ReleaseCommandError(
      "serving_pointer_invalid",
      "Current pointer is not a published Release for this Character",
    );
  }
  const pausing = command.commandType === "character.serving.pause";
  const retiring = command.commandType === "character.serving.retire";
  const expectedState = pausing || retiring ? "live" : "paused";
  const nextState = retiring ? "retired" : pausing ? "paused" : "live";
  if (
    serving.state !== expectedState ||
    !isCharacterServingTransitionAllowed(serving.state, nextState)
  ) {
    throw new ReleaseCommandError(
      "serving_state_conflict",
      `Serving must be ${expectedState} before ${nextState}`,
    );
  }
  if (
    retiring &&
    project.phase !== "live_management"
  ) {
    throw new ReleaseCommandError(
      "project_phase_conflict",
      "Character Project must be in live management before retirement",
      { projectPhase: project.phase },
    );
  }
  const resuming = !pausing && !retiring;
  let resumeEvidence: Record<string, unknown> | null = null;
  if (resuming) {
    if (release.legacy) {
      const authority =
        await evaluateEditorialReleaseAuthorityInTransaction(tx, {
          releaseId: release.id,
          projectionState: "paused",
        });
      // INTENT: editorial Releases have no generated validation run that can
      // independently clear a hard readiness block. Resume may heal only the
      // known false-staleness shape (the exact authority is otherwise intact
      // and readiness alone is `stale`). `blocked` and `unknown` always require
      // an explicit authority repair/review workflow.
      const staleReadinessOnly =
        release.readiness === "stale" &&
        authority.failures.length === 1 &&
        authority.failures[0]?.code === "release_not_ready";
      if (!authority.valid && !staleReadinessOnly) {
        throw new ReleaseCommandError(
          "serving_resume_qualification_invalid",
          "Character Serving cannot resume because its editorial Release authority drifted",
          {
            blockers: authority.failures.map((item) => item.code),
            authorityKind: "editorial_import",
          },
        );
      }
      const qualification =
        await tx.publicCatalogQualification.findUniqueOrThrow({
          where: { releaseId: release.id },
          select: { id: true },
        });
      resumeEvidence = {
        authorityKind: "editorial_import",
        qualificationId: qualification.id,
        validationRunId: null,
      };
    } else {
      const validation = await validateCharacterReleaseSnapshot(
        tx,
        release,
        policyVersion,
        now,
      );
      if (validation.failed.length > 0) {
        throw new ReleaseCommandError(
          "serving_resume_validation_failed",
          "Character Serving cannot resume because the current Release authority drifted",
          {
            blockers: validation.failed.map((item) => item.key),
            validationRunId: validation.run.id,
          },
        );
      }
      const qualification = await tx.publicCatalogQualification.findUnique({
        where: { releaseId: release.id },
        include: { validationRun: true },
      });
      const qualificationEvidence = record(qualification?.evidence);
      const pinnedValidation = qualification?.validationRun ?? null;
      if (
        !qualification ||
        qualification.kind !== "generated_release" ||
        qualification.validationRunId === null ||
        qualification.revokedAt !== null ||
        qualification.releaseSnapshotHash !== release.snapshotHash ||
        qualificationEvidence.schemaVersion !==
          PUBLIC_CATALOG_QUALIFICATION_SCHEMA_VERSION ||
        qualificationEvidence.policyVersion !== policyVersion ||
        !pinnedValidation ||
        pinnedValidation.releaseId !== release.id ||
        pinnedValidation.snapshotHash !== release.snapshotHash ||
        pinnedValidation.policyVersion !== policyVersion ||
        pinnedValidation.result !== "passed" ||
        pinnedValidation.finishedAt === null
      ) {
        throw new ReleaseCommandError(
          "serving_resume_qualification_invalid",
          "Character Serving cannot resume without its exact current generated Release qualification",
          {
            qualificationId: qualification?.id ?? null,
            qualificationKind: qualification?.kind ?? null,
            validationRunId: qualification?.validationRunId ?? null,
          },
        );
      }
      resumeEvidence = {
        authorityKind: "generated_release",
        qualificationId: qualification.id,
        qualificationValidationRunId: qualification.validationRunId,
        resumeValidationRunId: validation.run.id,
      };
    }
    if (release.readiness !== "ready") {
      const restored = await tx.characterRelease.updateMany({
        where: {
          id: release.id,
          version: release.version,
          readiness: release.readiness,
        },
        data: {
          readiness: "ready",
          version: { increment: 1 },
        },
      });
      if (restored.count !== 1) {
        throw new ReleaseCommandError(
          "release_version_conflict",
          "Current Release changed while restoring resume readiness",
          {},
          true,
        );
      }
    }
  }
  const resumeAssetId = pausing || retiring
    ? null
    : placementAssetId(release.releasePlacementManifest);
  if (!pausing && !retiring && !resumeAssetId) {
    throw new ReleaseCommandError(
      "serving_projection_manifest_missing",
      "Published Release has no character avatar manifest",
    );
  }
  await transitionCharacterServing(tx, {
    servingId: serving.id,
    to: nextState,
    expected: {
      from: expectedState,
      version: serving.version,
    },
    data: {
      ...(retiring
        ? {
            scheduledReleaseId: null,
            scheduledAt: null,
          }
        : {}),
    },
  });
  await tx.character.update({
    where: { id: command.targetId },
    data: pausing || retiring
      ? { status: "archived", visibility: "private" }
      : {
          status: "approved",
          visibility: "public",
          imageAssetId: resumeAssetId,
        },
  });
  if (retiring) {
    await transitionCharacterProject(tx, {
      projectId: project.id,
      to: "retired",
      expected: {
        from: project.phase as "idea" | "planned" | "producing" | "qa" | "launch_ready" | "live_management",
        version: project.version,
      },
      data: { activeKey: null },
    });
  }
  await appendExecutionEvidence(tx, {
    command,
    commandType: command.commandType as ReleaseCommandType,
    releaseId: release.id,
    characterId: command.targetId,
    before: {
      servingState: serving.state,
      servingVersion: serving.version,
      releaseReadiness: release.readiness,
      releaseVersion: release.version,
      scheduledReleaseId: serving.scheduledReleaseId,
      scheduledAt: serving.scheduledAt?.toISOString() ?? null,
    },
    after: {
      servingState: nextState,
      servingVersion: serving.version + 1,
      releaseReadiness:
        resuming ? "ready" : release.readiness,
      releaseVersion:
        resuming && release.readiness !== "ready"
          ? release.version + 1
          : release.version,
      resumeEvidence,
      retired: retiring,
      scheduledReleaseId: retiring ? null : serving.scheduledReleaseId,
      scheduledAt: retiring
        ? null
        : serving.scheduledAt?.toISOString() ?? null,
      cancelledScheduledReleaseId: retiring
        ? serving.scheduledReleaseId
        : null,
    },
    eventType: retiring
      ? "character.serving.retired"
      : pausing
        ? "character.serving.paused"
        : "character.serving.resumed",
    now,
    result: {
      servingState: nextState,
      releaseReadiness:
        resuming ? "ready" : release.readiness,
      releaseVersion:
        resuming && release.readiness !== "ready"
          ? release.version + 1
          : release.version,
      resumeEvidence,
      retired: retiring,
      cancelledScheduledReleaseId: retiring
        ? serving.scheduledReleaseId
        : null,
    },
  });
  return release.id;
}

export async function executeCharacterReleaseCommand(
  db: PrismaClient,
  input: ExecuteReleaseCommandInput,
): Promise<ReleaseCommandResult> {
  const now = input.now ?? new Date();
  const existing = await db.controlPlaneCommand.findUnique({
    where: { id: input.commandId },
  });
  if (!existing) {
    return {
      status: "failed",
      commandId: input.commandId,
      releaseId: "",
      errorCode: "command_not_found",
    };
  }
  if (existing.status === "succeeded") {
    return {
      status: "succeeded",
      commandId: existing.id,
      releaseId:
        stringValue(record(existing.result).releaseId) ?? existing.targetId,
    };
  }
  const supported: readonly ReleaseCommandType[] = [
    "character.release.schedule",
    "character.release.publish",
    "character.release.rollback",
    "character.serving.pause",
    "character.serving.resume",
    "character.serving.retire",
  ];
  if (!supported.includes(existing.commandType as ReleaseCommandType)) {
    return {
      status: "failed",
      commandId: existing.id,
      releaseId: existing.targetId,
      errorCode: "unsupported_command",
    };
  }
  const claimed = await claimControlPlaneCommand(db, {
    commandId: input.commandId,
    workerId: input.workerId,
    leaseMs: input.leaseMs ?? 30_000,
    now,
  });
  if (!claimed) {
    return {
      status: "failed",
      commandId: existing.id,
      releaseId: existing.targetId,
      errorCode: "command_not_claimable",
    };
  }

  await input.afterClaim?.(claimed.id);

  try {
    return await db.$transaction(async (tx) => {
      const command = await tx.controlPlaneCommand.findUniqueOrThrow({
        where: { id: claimed.id },
      });
      try {
        const releaseId =
          command.commandType === "character.release.schedule"
            ? await executeSchedule(
                tx,
                command,
                input.policyVersion ?? CHARACTER_RELEASE_POLICY_VERSION,
                now,
              )
            : command.commandType === "character.serving.pause" ||
                command.commandType === "character.serving.resume" ||
                command.commandType === "character.serving.retire"
              ? await executeServingState(
                  tx,
                  command,
                  input.policyVersion ?? CHARACTER_RELEASE_POLICY_VERSION,
                  now,
                )
              : command.commandType === "character.release.rollback"
                ? await executeRollback(
                    tx,
                    command,
                    input.policyVersion ?? CHARACTER_RELEASE_POLICY_VERSION,
                    now,
                  )
                : await publishRelease(
                    tx,
                    command,
                    await tx.characterRelease.findUniqueOrThrow({
                      where: { id: command.targetId },
                    }),
                    input.policyVersion ?? CHARACTER_RELEASE_POLICY_VERSION,
                    now,
                  );
        return {
          status: "succeeded" as const,
          commandId: command.id,
          releaseId,
        };
      } catch (error) {
        if (
          !(error instanceof ReleaseCommandError) ||
          error.rollbackTransaction
        )
          throw error;
        const domainError = error;
        await failCommand(tx, command, domainError, now);
        return {
          status: "failed" as const,
          commandId: command.id,
          releaseId: command.targetId,
          errorCode: domainError.code,
        };
      }
    });
  } catch (error) {
    const domainError =
      error instanceof ReleaseCommandError
        ? error
        : new ReleaseCommandError(
            "release_executor_transaction_failed",
            error instanceof Error
              ? error.message
              : "Unknown transaction failure",
          );
    await db.$transaction(async (tx) => {
      const command = await tx.controlPlaneCommand.findUnique({
        where: { id: input.commandId },
      });
      if (
        command?.status === "running" &&
        command.leaseOwner === input.workerId
      ) {
        await failCommand(tx, command, domainError, now);
      }
    });
    return {
      status: "failed",
      commandId: input.commandId,
      releaseId: existing.targetId,
      errorCode: domainError.code,
    };
  }
}
