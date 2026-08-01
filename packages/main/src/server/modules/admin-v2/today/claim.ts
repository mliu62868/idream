import {
  todayClaimRequestSchema,
  todayClaimResponseSchema,
  type TodayClaimRequest,
  type TodayClaimResponse,
} from "@idream/shared/admin";
import type { Prisma } from "@prisma/client";
import { effectiveCharacterIdsForPermission } from "@/server/admin/effective-permissions";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import type { AdminActor } from "@/server/modules/admin-v2/shared/authority";
import { actorWithPermission, jsonBody } from "@/server/modules/admin-v2/shared/authority";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";
import { assignReviewCaseInTransaction } from "../cases/service";
import { triageIncidentInTransaction } from "../incidents/workflow";
import { canonicalRequestHash } from "../shared/control-plane-command";
import { toInputJson } from "../shared/prisma-json";

async function claimCreativeRun(input: {
  tx: Prisma.TransactionClient;
  request: TodayClaimRequest;
  actor: AdminActor;
  requestId: string;
}): Promise<TodayClaimResponse> {
  const tx = input.tx;
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
}

async function claimCharacterRelease(input: {
  tx: Prisma.TransactionClient;
  request: TodayClaimRequest;
  actor: AdminActor;
  requestId: string;
}): Promise<TodayClaimResponse> {
  const tx = input.tx;
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
}

async function claimActor(request: Request, body: TodayClaimRequest) {
  if (body.sourceType === "admin_case") {
    return actorWithPermission(request, "case.assign");
  }
  if (body.sourceType === "ops_incident") {
    return actorWithPermission(request, "ops.incident.manage");
  }
  if (body.sourceType === "character_release") {
    return actorWithPermission(request, "character.project.write");
  }
  return actorWithPermission(request, "creative.run.write");
}

async function applyClaim(
  tx: Prisma.TransactionClient,
  body: TodayClaimRequest,
  actor: AdminActor,
  requestId: string,
) {
  if (body.sourceType === "admin_case") {
    const updated = await assignReviewCaseInTransaction(tx, {
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
    const updated = await triageIncidentInTransaction(tx, {
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
    return claimCharacterRelease({ tx, request: body, actor, requestId });
  }
  return claimCreativeRun({ tx, request: body, actor, requestId });
}

export async function claimTodayWorkItem(request: Request) {
  const body = todayClaimRequestSchema.parse(await jsonBody(request));
  const idempotencyKey = requireIdempotencyKey(request);
  const requestId = request.headers.get("x-request-id")?.trim() || crypto.randomUUID();
  const actor = await claimActor(request, body);
  const scope = `${env.APP_ENV}:${actor.id}`;
  const requestHash = canonicalRequestHash({
    commandType: "today.work.claim",
    target: { type: body.sourceType, id: body.sourceId },
    expectedVersion: body.entityVersion,
    payload: { ownerId: actor.id },
    retryMode: "idempotent",
  });

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${scope}:${idempotencyKey}`}))`;
    const existing = await tx.controlPlaneCommand.findUnique({
      where: { scope_idempotencyKey: { scope, idempotencyKey } },
    });
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw Errors.conflict("Idempotency key is bound to another Today claim", {
          existingRequestHash: existing.requestHash,
          submittedRequestHash: requestHash,
        });
      }
      return todayClaimResponseSchema.parse(existing.result);
    }

    const result = await applyClaim(tx, body, actor, requestId);
    await tx.controlPlaneCommand.create({
      data: {
        scope,
        idempotencyKey,
        commandType: "today.work.claim",
        targetType: body.sourceType,
        targetId: body.sourceId,
        actorId: actor.id,
        requestId,
        requestHash,
        requestPayload: toInputJson(body),
        expectedVersion: body.entityVersion,
        retryMode: "idempotent",
        status: "succeeded",
        result: toInputJson(result),
        finishedAt: new Date(),
      },
    });
    return result;
  });
}
