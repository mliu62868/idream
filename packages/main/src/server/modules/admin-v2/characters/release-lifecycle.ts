import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { actorWithPermission } from "@/server/modules/admin-v2/shared/authority";
import { CHARACTER_RELEASE_POLICY_VERSION, validateCharacterReleaseSnapshot } from "./release-executor";
import {
  characterReleaseProposalBlockers,
  evaluateCharacterReleaseSnapshot,
} from "./release-validation";
import { findOperationalGenerationRoute } from "./visual-authority";
import { env } from "@/server/lib/env";
import { characterReleaseSnapshotHash } from "./release-snapshot";
import { releaseStringArray } from "./release-snapshot-values";
import { toInputJson } from "../shared/prisma-json";
import { canonicalSha256 } from "../shared/canonical-json";
import type { CharacterReleaseCreationState } from "../shared/state-transition-authority";
import {
  transitionCharacterProject,
  transitionCharacterRelease,
} from "./transition";
import {
  lockCharacterGenerationAuthority,
  lockCharacterMediaAssetAuthorities,
} from "./generation-authority-lock";
import { characterReferenceMediaAuthoritySelect } from "./reference-media-authority";
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
    const selectedEntries = draftAssetEntries.filter((entry) => entry.selectedFromProject);
    const selectedItems = await tx.contentProductionItem.findMany({
      where: { id: { in: selectedEntries.flatMap((entry) => entry.itemId ? [entry.itemId] : []) } },
      include: { batch: true, job: true },
    });
    const selectedItemById = new Map(selectedItems.map((item) => [item.id, item]));
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
    // 血缘不完整的槽位不进 provenance：候选快照因此缺 pinned 条目，规则引擎的
    // release_asset_generation_authority 与 release_assets_customer_publishable 当场失败关闭。
    const placementGenerationProvenance = draftAssetEntries.flatMap((entry) => {
      const item = entry.itemId ? selectedItemById.get(entry.itemId) ?? null : null;
      const job = item?.job ?? null;
      const attempt = entry.generationJobId
        ? latestAttemptByJobId.get(entry.generationJobId) ?? null
        : null;
      if (!job || !attempt || job.id !== entry.generationJobId) return [];
      return [{
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
        referenceAssetIds: releaseStringArray(job.referenceAssetIds),
        referenceManifestHash: job.referenceManifest
          ? canonicalSha256(job.referenceManifest)
          : null,
        provider: job.provider,
        deliveredOutputCount: job.deliveredOutputCount,
        attemptId: attempt.id,
        attemptNo: attempt.attemptNo,
        completedAt: job.completedAt?.toISOString() ?? null,
      }];
    });
    const generationProvenance = {
      schemaVersion: "character-release-generation-provenance-v2",
      policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
      requiredReleaseRoute: {
        routeFingerprint: route?.routeFingerprint ?? null,
        matrixKey: route?.matrixKey ?? null,
        generationProfileKey: route?.generationProfileKey ?? null,
        generationProfileVersion: route?.generationProfileVersion ?? null,
        workflowKey: route?.workflowKey ?? null,
        workflowVersion: route?.workflowVersion ?? null,
      },
      visualAuthority: {
        visualProfileId: profile?.id ?? null,
        visualProfileVersion: profile?.version ?? null,
        visualProfileHash: profile?.immutableHash ?? null,
        referenceSetRevisionId: referenceSet?.id ?? null,
        referenceSetHash: referenceSet?.snapshotHash ?? null,
      },
      placements: placementGenerationProvenance,
      characterQa: {
        status: "passed",
        qaRunId: qaRun?.id ?? null,
        evidenceHash: qaRun?.evidenceHash ?? null,
        characterId: qaRun?.characterId ?? null,
        projectId: qaRun?.projectId ?? null,
        characterContentVersionId: qaRun?.characterContentVersionId ?? null,
        projectVersion: qaRun?.projectVersion ?? null,
        visualProfileId: qaRun?.visualProfileId ?? null,
        visualProfileVersion: qaRun?.visualProfileVersion ?? null,
        visualProfileHash: qaRun?.visualProfileHash ?? null,
        referenceSetRevisionId: qaRun?.referenceSetRevisionId ?? null,
        referenceSetRevision: qaRun?.referenceSetRevision ?? null,
        referenceSetHash: qaRun?.referenceSetHash ?? null,
        draftAssetPackHash: qaRun?.draftAssetPackHash ?? null,
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
      revisionId: revision?.id ?? null,
      characterContentVersionId: revision?.characterContentVersionId ?? null,
      visualProfileId: profile?.id ?? null,
      visualProfileVersion: profile?.version ?? null,
      referenceSetRevisionId: referenceSet?.id ?? null,
      generationProvenance,
      releasePlacementManifest,
    };
    const snapshotHash = characterReleaseSnapshotHash(snapshot);
    const evaluation = await evaluateCharacterReleaseSnapshot(
      tx,
      {
        ...snapshot,
        snapshotHash,
        legacy: false,
        rollbackOfReleaseId: null,
        liveQaAuthority: {
          projectVersion: project.version,
          draftAssetPackHash: canonicalSha256(project.draftAssetPack),
        },
      },
      CHARACTER_RELEASE_POLICY_VERSION,
      new Date(),
    );
    // §3.2：草稿包权威回答的是另一个问题 ——「活的草稿包此刻还自洽吗」。它比 manifest 侧那道闸
    // 更严（source_image 分区、workflow 槽位能力、来源图评审血缘），而发布后 manifest 已不可变，
    // 这个问题不再存在。所以它留在提案侧，不并进规则引擎。
    const blockers = [
      ...characterReleaseProposalBlockers(evaluation.failed),
      ...(draftAssetEntries.length !== 3 ||
        selectedEntries.length !== 3 ||
        exactDraftAssetPackAuthority?.ready !== true
        ? ["approved_asset_pack_incomplete"]
        : []),
      ...((exactDraftAssetPackAuthority?.invalidAssetPurposes.length ?? 0) > 0
        ? ["approved_asset_pack_invalid"]
        : []),
      ...((exactDraftAssetPackAuthority?.invalidLineagePurposes.length ?? 0) > 0
        ? ["approved_asset_pack_lineage_invalid"]
        : []),
    ];
    if (blockers.length > 0) throw Errors.conflict("Character is not ready to propose a Release", { blockers });
    await transitionCharacterProject(tx, {
      projectId: project.id,
      to: "qa",
      expectedVersion: project.version,
    });
    const release = await tx.characterRelease.create({ data: {
      ...snapshot,
      // revision_is_immutable_and_pinned 已通过，revision 必然存在。
      revisionId: revision!.id,
      characterContentVersionId: revision!.characterContentVersionId,
      generationProvenance: toInputJson(generationProvenance),
      releasePlacementManifest: toInputJson(releasePlacementManifest),
      snapshotHash,
      status: "in_review" satisfies CharacterReleaseCreationState,
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
    const updated = await transitionCharacterRelease(tx, {
      releaseId: release.id,
      to: status,
      expectedVersion: input.expectedVersion,
    });
    await transitionCharacterProject(tx, {
      projectId: project.id,
      to: projectPhase,
      expectedVersion: project.version,
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
