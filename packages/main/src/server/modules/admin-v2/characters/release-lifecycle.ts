import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { actorWithPermission } from "@/server/modules/admin-v2/shared/authority";
import { CHARACTER_RELEASE_POLICY_VERSION, validateCharacterReleaseSnapshot } from "./release-executor";
import { findQualifiedGenerationRoute } from "./visual-authority";
import { env } from "@/server/lib/env";
import { characterReleaseSnapshotHash } from "./release-snapshot";
import { toInputJson } from "../shared/prisma-json";
import {
  isCharacterProjectPhaseTransitionAllowed,
  isCharacterReleaseTransitionAllowed,
} from "../shared/state-transition-authority";

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
    const project = await tx.characterProject.findFirst({ where: { characterId: input.characterId } });
    if (!project) throw Errors.notFound("Character Project not found");
    if (project.version !== input.expectedProjectVersion) throw Errors.conflict("Character Project changed before Release proposal");
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
    const character = await tx.character.findUnique({ where: { id: input.characterId }, include: { imageAsset: true } });
    const revision = await tx.characterRevision.findFirst({ where: { projectId: project.id }, orderBy: { revision: "desc" } });
    const qaRun = await tx.characterQaRun.findUnique({ where: { id: input.qaRunId } });
    const profile = await tx.characterVisualProfile.findFirst({ where: { characterId: input.characterId, status: "active" }, orderBy: { version: "desc" } });
    const referenceSet = profile ? await tx.referenceSetRevision.findFirst({ where: { visualProfileId: profile.id, status: "active" }, include: { references: true }, orderBy: { revision: "desc" } }) : null;
    const route = profile ? await findQualifiedGenerationRoute(tx, {
      style: profile.style,
      policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
      evaluatorVersion: env.GENERATION_ROUTE_EVALUATOR_VERSION,
      at: new Date(),
    }) : null;
    const blockers = [
      ...(!character ? ["character_missing"] : []),
      ...(!revision ? ["revision_missing"] : []),
      ...(!qaRun || qaRun.status !== "passed" ? ["character_qa_not_passed"] : []),
      ...(qaRun && (
        qaRun.characterId !== input.characterId ||
        qaRun.projectId !== project.id ||
        qaRun.characterContentVersionId !== revision?.characterContentVersionId ||
        qaRun.projectVersion !== project.version
      ) ? ["character_qa_authority_mismatch"] : []),
      ...(!profile?.immutableHash ? ["active_visual_profile_missing_or_unsealed"] : []),
      ...(!referenceSet?.snapshotHash || !referenceSet.references.length ? ["active_reference_set_missing_or_empty"] : []),
      ...(!route ? ["qualified_generation_route_missing"] : []),
      ...(!character?.imageAsset || character.imageAsset.deletedAt || character.imageAsset.safetyStatus !== "passed" ? ["approved_avatar_missing"] : []),
    ];
    if (blockers.length > 0) throw Errors.conflict("Character is not ready to propose a Release", { blockers });
    const generationProvenance = {
      routeFingerprint: route!.routeFingerprint,
      matrixKey: route!.matrixKey,
      generationProfileKey: route!.generationProfileKey,
      generationProfileVersion: route!.generationProfileVersion,
      workflowKey: route!.workflowKey,
      workflowVersion: route!.workflowVersion,
      visualProfileHash: profile!.immutableHash,
      referenceSetHash: referenceSet!.snapshotHash,
      characterQa: {
        status: "passed",
        qaRunId: qaRun!.id,
        evidenceHash: qaRun!.evidenceHash,
      },
    };
    const releasePlacementManifest = { placements: [{ slotKey: "character_avatar", assetId: character!.imageAsset!.id, slotVersion: 1 }] };
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
}) {
  const actor = await actorWithPermission(input.request, "character.release.review", { characterId: input.characterId });
  return prisma.$transaction(async (tx) => {
    const release = await tx.characterRelease.findUnique({ where: { id: input.releaseId } });
    if (!release) throw Errors.notFound("Character Release not found");
    const project = await tx.characterProject.findUnique({ where: { id: release.projectId } });
    if (!project || project.characterId !== input.characterId) throw Errors.notFound("Character Release not found for Character");
    const status = input.decision === "approved" ? "approved" : "draft";
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
      requestId: input.request.headers.get("x-request-id"),
    } });
    await tx.mainOutboxEvent.create({ data: { eventType: `character.release.${input.decision}.v2`, aggregateType: "character_release", aggregateId: release.id, payload: toInputJson({ characterId: input.characterId, releaseId: release.id, status: updated.status, version: updated.version }) } });
    return updated;
  });
}
import type { Prisma } from "@prisma/client";
