import {
  todayClaimRequestSchema,
  todayClaimResponseSchema,
  type TodayClaimRequest,
  type TodayClaimResponse,
} from "@idream/shared/admin";
import { effectiveCharacterIdsForPermission } from "@/server/admin/effective-permissions";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import type { AdminActor } from "@/server/modules/admin/service";
import { actorWithPermission } from "@/server/modules/admin/service";
import { assignReviewCase } from "../cases/service";
import { triageIncident } from "../incidents/workflow";
import { toInputJson } from "../shared/prisma-json";

const claimAuditAction = {
  admin_case: "case.assigned",
  ops_incident: "incident.triaged",
  character_release: "character.project.claimed",
  creative_run: "creative.run.claimed",
} as const;

async function replayedClaim(
  request: TodayClaimRequest,
  actor: AdminActor,
  requestId: string,
): Promise<TodayClaimResponse | null> {
  const audit = await prisma.adminAuditLog.findFirst({
    where: { actorId: actor.id, action: claimAuditAction[request.sourceType], requestId },
    orderBy: { createdAt: "desc" },
  });
  if (!audit) return null;
  if (request.sourceType === "admin_case") {
    const current = await prisma.adminCase.findUnique({ where: { id: request.sourceId } });
    return current?.ownerId === actor.id ? todayClaimResponseSchema.parse({
      sourceType: request.sourceType,
      sourceId: request.sourceId,
      ownerId: actor.id,
      entityVersion: current.version,
    }) : null;
  }
  if (request.sourceType === "ops_incident") {
    const current = await prisma.opsIncident.findUnique({ where: { id: request.sourceId } });
    return current?.ownerId === actor.id ? todayClaimResponseSchema.parse({
      sourceType: request.sourceType,
      sourceId: request.sourceId,
      ownerId: actor.id,
      entityVersion: current.version,
    }) : null;
  }
  if (request.sourceType === "creative_run") {
    const current = await prisma.contentProductionBatch.findUnique({ where: { id: request.sourceId } });
    return current?.ownerId === actor.id ? todayClaimResponseSchema.parse({
      sourceType: request.sourceType,
      sourceId: request.sourceId,
      ownerId: actor.id,
      entityVersion: current.version,
    }) : null;
  }
  const release = await prisma.characterRelease.findUnique({ where: { id: request.sourceId } });
  const project = release
    ? await prisma.characterProject.findUnique({ where: { id: release.projectId } })
    : null;
  return project?.ownerId === actor.id ? todayClaimResponseSchema.parse({
    sourceType: request.sourceType,
    sourceId: request.sourceId,
    ownerId: actor.id,
    entityVersion: project.version,
  }) : null;
}

async function claimCreativeRun(input: {
  request: TodayClaimRequest;
  actor: AdminActor;
  requestId: string;
}): Promise<TodayClaimResponse> {
  return prisma.$transaction(async (tx) => {
    const current = await tx.contentProductionBatch.findUnique({ where: { id: input.request.sourceId } });
    if (!current) throw Errors.notFound("Creative Run not found");
    if (current.ownerId !== null) throw Errors.conflict("Creative Run is already assigned", { ownerId: current.ownerId });
    const changed = await tx.contentProductionBatch.updateMany({
      where: { id: current.id, ownerId: null, version: input.request.entityVersion },
      data: { ownerId: input.actor.id, version: { increment: 1 } },
    });
    if (changed.count !== 1) throw Errors.conflict("Creative Run changed before claim", { currentVersion: current.version });
    const updated = await tx.contentProductionBatch.findUniqueOrThrow({ where: { id: current.id } });
    await tx.adminAuditLog.create({
      data: {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: "creative.run.claimed",
        targetType: "creative_run",
        targetId: current.id,
        reason: "Claimed from Today",
        before: toInputJson({ ownerId: null, version: current.version }),
        after: toInputJson({ ownerId: updated.ownerId, version: updated.version }),
        requestId: input.requestId,
      },
    });
    await tx.mainOutboxEvent.create({
      data: {
        eventType: "creative.run.claimed.v2",
        aggregateType: "creative_run",
        aggregateId: current.id,
        payload: toInputJson({ runId: current.id, ownerId: updated.ownerId, version: updated.version }),
      },
    });
    return todayClaimResponseSchema.parse({
      sourceType: "creative_run",
      sourceId: current.id,
      ownerId: input.actor.id,
      entityVersion: updated.version,
    });
  });
}

async function claimCharacterRelease(input: {
  request: TodayClaimRequest;
  actor: AdminActor;
  requestId: string;
}): Promise<TodayClaimResponse> {
  return prisma.$transaction(async (tx) => {
    const release = await tx.characterRelease.findUnique({ where: { id: input.request.sourceId } });
    if (!release) throw Errors.notFound("Character Release not found");
    const project = await tx.characterProject.findUnique({ where: { id: release.projectId } });
    if (!project) throw Errors.notFound("Character Project not found");
    const allowedCharacterIds = await effectiveCharacterIdsForPermission(
      input.actor.id,
      input.actor.role,
      "character.project.write",
    );
    if (allowedCharacterIds !== null && !allowedCharacterIds.has(project.characterId)) {
      throw Errors.forbidden("Character is outside the effective permission scope");
    }
    if (project.ownerId !== null) {
      throw Errors.conflict("Character Project is already assigned", { ownerId: project.ownerId });
    }
    const changed = await tx.characterProject.updateMany({
      where: { id: project.id, ownerId: null, version: input.request.entityVersion },
      data: { ownerId: input.actor.id, version: { increment: 1 } },
    });
    if (changed.count !== 1) {
      throw Errors.conflict("Character Project changed before claim", { currentVersion: project.version });
    }
    const updated = await tx.characterProject.findUniqueOrThrow({ where: { id: project.id } });
    await tx.adminAuditLog.create({
      data: {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: "character.project.claimed",
        targetType: "character_project",
        targetId: project.id,
        reason: "Claimed from Today",
        before: toInputJson({ ownerId: null, version: project.version }),
        after: toInputJson({ ownerId: updated.ownerId, version: updated.version, releaseId: release.id }),
        requestId: input.requestId,
      },
    });
    await tx.mainOutboxEvent.create({
      data: {
        eventType: "character.project.claimed.v2",
        aggregateType: "character_project",
        aggregateId: project.id,
        payload: toInputJson({
          projectId: project.id,
          characterId: project.characterId,
          releaseId: release.id,
          ownerId: updated.ownerId,
          version: updated.version,
        }),
      },
    });
    return todayClaimResponseSchema.parse({
      sourceType: "character_release",
      sourceId: release.id,
      ownerId: input.actor.id,
      entityVersion: updated.version,
    });
  });
}

export async function claimTodayWorkItem(request: Request) {
  const body = todayClaimRequestSchema.parse(await request.json());
  const requestId = request.headers.get("idempotency-key")
    ?? request.headers.get("x-request-id")
    ?? crypto.randomUUID();

  if (body.sourceType === "admin_case") {
    const actor = await actorWithPermission(request, "case.assign");
    const replay = await replayedClaim(body, actor, requestId);
    if (replay) return replay;
    const updated = await assignReviewCase({
      caseId: body.sourceId,
      actor,
      expectedVersion: body.entityVersion,
      ownerId: actor.id,
      reason: "Claimed from Today",
      requestId,
    });
    return todayClaimResponseSchema.parse({
      sourceType: body.sourceType,
      sourceId: body.sourceId,
      ownerId: actor.id,
      entityVersion: updated.version,
    });
  }

  if (body.sourceType === "ops_incident") {
    const actor = await actorWithPermission(request, "ops.incident.manage");
    const replay = await replayedClaim(body, actor, requestId);
    if (replay) return replay;
    const updated = await triageIncident({
      incidentId: body.sourceId,
      actor,
      expectedVersion: body.entityVersion,
      ownerId: actor.id,
      reason: "Claimed from Today",
      requestId,
    });
    return todayClaimResponseSchema.parse({
      sourceType: body.sourceType,
      sourceId: body.sourceId,
      ownerId: actor.id,
      entityVersion: updated.version,
    });
  }

  if (body.sourceType === "character_release") {
    const actor = await actorWithPermission(request, "character.project.write");
    const replay = await replayedClaim(body, actor, requestId);
    if (replay) return replay;
    return claimCharacterRelease({ request: body, actor, requestId });
  }

  const actor = await actorWithPermission(request, "creative.run.write");
  const replay = await replayedClaim(body, actor, requestId);
  if (replay) return replay;
  return claimCreativeRun({ request: body, actor, requestId });
}
