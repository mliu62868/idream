import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import { actorWithPermission, clampInt, jsonBody, toInputJson, type AdminActor } from "@/server/modules/admin/shared/legacy-primitives";
import { ensureReviewCaseForAppeal, ensureReviewCaseForReport, recordReviewCaseDecision } from "@/server/modules/admin-v2/cases/service";
import { canonicalRequestHash } from "@/server/modules/admin-v2/shared/control-plane-command";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";
import { decodeAdminListCursor, encodeAdminListCursor } from "@/server/modules/admin-v2/shared/list-cursor";
const adminDecisionSchema = z.object({
  decision: z.enum(["actioned", "no_violation", "duplicate", "escalated", "closed"]),
  policyCode: z.string().max(120).optional(),
  notes: z.string().max(2_000).optional(),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

const appealDecisionSchema = z.object({
  outcome: z.enum(["upheld", "overturned", "modified", "open"]),
  notes: z.string().trim().max(2_000).optional(),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

type ModerationCommandInput = {
  request: Request;
  actor: AdminActor;
  commandType: string;
  targetType: "content_report" | "appeal";
  targetId: string;
  payload: unknown;
  execute: (tx: Prisma.TransactionClient, requestId: string) => Promise<Record<string, unknown>>;
};

async function executeIdempotentModerationCommand(input: ModerationCommandInput) {
  const idempotencyKey = requireIdempotencyKey(input.request);
  const requestId = input.request.headers.get("x-request-id")?.trim() || randomUUID();
  const scope = `${env.APP_ENV}:${input.actor.id}`;
  const requestHash = canonicalRequestHash({
    commandType: input.commandType,
    target: { type: input.targetType, id: input.targetId },
    payload: input.payload,
    retryMode: "idempotent",
  });
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1::int AS locked FROM pg_advisory_xact_lock(hashtext(${`${scope}:${idempotencyKey}`}))`;
    const existing = await tx.controlPlaneCommand.findUnique({ where: { scope_idempotencyKey: { scope, idempotencyKey } } });
    if (existing) {
      if (existing.requestHash !== requestHash) throw Errors.conflict("Idempotency-Key was already used for a different moderation command");
      if (existing.status !== "succeeded" || !existing.result) throw Errors.conflict("The original moderation command has not completed");
      return { ...(existing.result as Record<string, unknown>), replayed: true };
    }
    const command = await tx.controlPlaneCommand.create({ data: {
      scope,
      idempotencyKey,
      commandType: input.commandType,
      targetType: input.targetType,
      targetId: input.targetId,
      actorId: input.actor.id,
      requestId,
      requestHash,
      requestPayload: toInputJson(input.payload),
      retryMode: "idempotent",
      status: "accepted",
    } });
    const result = { ...await input.execute(tx, requestId), replayed: false };
    await tx.controlPlaneCommand.update({ where: { id: command.id }, data: { status: "succeeded", result: toInputJson(result), finishedAt: new Date() } });
    return result;
  });
}

export async function moderationQueue(request: Request) {
  await actorWithPermission(request, "safety.review.read");
  const url = new URL(request.url);
  const scope = z.enum(["reports", "media", "appeals"]).optional().parse(url.searchParams.get("scope") ?? undefined);
  const search = url.searchParams.get("search")?.trim() || undefined;
  const id = url.searchParams.get("id")?.trim() || undefined;
  const targetType = url.searchParams.get("targetType")?.trim() || undefined;
  const targetId = url.searchParams.get("targetId")?.trim() || undefined;
  const requestedStatuses = url.searchParams
    .get("status")
    ?.split(",")
    .map((status) => status.trim())
    .filter(Boolean);
  const statuses = requestedStatuses?.length && !requestedStatuses.includes("all")
    ? requestedStatuses
    : ["open", "triaged", "reviewing"];
  const limit = clampInt(url.searchParams.get("limit"), 1, 100, 100);
  const queryIdentity = { search, id, targetType, targetId, statuses };
  const reportCursorKeys = adminListCursorKeys(url, "moderation_reports", queryIdentity, "reportCursor");
  const mediaCursorKeys = adminListCursorKeys(url, "moderation_blocked_media", queryIdentity, "mediaCursor");
  const appealCursorKeys = adminListCursorKeys(url, "moderation_appeals", queryIdentity, "appealCursor");
  const reportWhere: Prisma.ContentReportWhereInput = {
    id,
    targetType,
    targetId,
    status: { in: statuses },
    OR: search
      ? [
          { id: { contains: search } },
          { targetId: { contains: search } },
          { category: { contains: search } },
          { description: { contains: search } },
        ]
      : undefined,
    AND: reportCursorKeys ? (() => {
      const priority = adminCursorNumber(reportCursorKeys, 0, "moderation_reports");
      const createdAt = adminCursorDate(reportCursorKeys, 1, "moderation_reports");
      const cursorId = adminCursorString(reportCursorKeys, 2, "moderation_reports");
      return { OR: [
        { priority: { gt: priority } },
        { priority, createdAt: { lt: createdAt } },
        { priority, createdAt, id: { lt: cursorId } },
      ] };
    })() : undefined,
  };
  const reports = scope && scope !== "reports" ? [] : await prisma.contentReport.findMany({
    where: reportWhere,
    include: { reporter: true, reviews: true },
    orderBy: [{ priority: "asc" }, { createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const blockedMedia = scope && scope !== "media" ? [] : await prisma.mediaAsset.findMany({
    where: {
      safetyStatus: "blocked",
      deletedAt: null,
      OR: search
        ? [{ id: { contains: search } }, { ownerId: { contains: search } }, { type: { contains: search } }]
        : undefined,
      AND: mediaCursorKeys ? (() => {
        const createdAt = adminCursorDate(mediaCursorKeys, 0, "moderation_blocked_media");
        const cursorId = adminCursorString(mediaCursorKeys, 1, "moderation_blocked_media");
        return { OR: [{ createdAt: { gt: createdAt } }, { createdAt, id: { gt: cursorId } }] };
      })() : undefined,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: limit + 1,
  });
  const appeals = scope && scope !== "appeals" ? [] : await prisma.appeal.findMany({
    where: {
      status: "open",
      OR: search
        ? [
            { id: { contains: search } },
            { userId: { contains: search } },
            { targetId: { contains: search } },
            { appealText: { contains: search } },
          ]
        : undefined,
      AND: appealCursorKeys ? (() => {
        const createdAt = adminCursorDate(appealCursorKeys, 0, "moderation_appeals");
        const cursorId = adminCursorString(appealCursorKeys, 1, "moderation_appeals");
        return { OR: [{ createdAt: { gt: createdAt } }, { createdAt, id: { gt: cursorId } }] };
      })() : undefined,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: limit + 1,
  });
  const reportPage = reports.slice(0, limit);
  const mediaPage = blockedMedia.slice(0, limit);
  const appealPage = appeals.slice(0, limit);
  return ok({
    reports: reportPage,
    blockedMedia: mediaPage.map((asset) => ({
      id: asset.id,
      ownerId: asset.ownerId,
      type: asset.type,
      safetyStatus: asset.safetyStatus,
      createdAt: asset.createdAt,
    })),
    appeals: appealPage,
    pageInfo: {
      reports: adminListPageInfo("moderation_reports", queryIdentity, reportPage, reports.length > limit, (row) => [
        row.priority,
        row.createdAt.toISOString(),
        row.id,
      ]),
      blockedMedia: adminListPageInfo(
        "moderation_blocked_media",
        queryIdentity,
        mediaPage,
        blockedMedia.length > limit,
        (row) => [row.createdAt.toISOString(), row.id],
      ),
      appeals: adminListPageInfo("moderation_appeals", queryIdentity, appealPage, appeals.length > limit, (row) => [
        row.createdAt.toISOString(),
        row.id,
      ]),
    },
  });
}

export async function moderationDecision(request: Request, reportId: string) {
  const actor = await actorWithPermission(request, "safety.review.write");
  const body = adminDecisionSchema.parse(await jsonBody(request));
  if (body.decision === "actioned" && body.confirmation !== reportId && body.confirmation !== "TAKEDOWN") {
    throw Errors.badRequest("Actioned decisions require target confirmation");
  }
  const result = await executeIdempotentModerationCommand({
    request,
    actor,
    commandType: "safety.review.decision",
    targetType: "content_report",
    targetId: reportId,
    payload: body,
    execute: async (tx, requestId) => {
      const current = await tx.contentReport.findUnique({ where: { id: reportId } });
      if (!current) throw Errors.notFound("Report not found");
      if (["actioned", "no_violation", "duplicate", "closed"].includes(current.status)) {
        throw Errors.conflict("Report already has a terminal decision");
      }
      const review = await tx.moderationReview.create({ data: {
        reportId,
        reviewerId: actor.id,
        decision: body.decision,
        policyCode: body.policyCode,
        notes: body.notes,
      } });
      const updated = await tx.contentReport.update({ where: { id: reportId }, data: { status: body.decision } });
      if (body.decision === "actioned") await applyModerationAction(current.targetType, current.targetId, tx);
      const adminCase = await ensureReviewCaseForReport(tx, current);
      if (!adminCase) throw Errors.conflict("Open report did not produce a Review Case");
      const evidence = await tx.caseEvidence.findUniqueOrThrow({ where: { caseId_sourceType_sourceId: { caseId: adminCase.id, sourceType: "content_report", sourceId: current.id } } });
      await recordReviewCaseDecision(tx, {
        caseId: adminCase.id,
        actor,
        decision: body.decision,
        summary: body.notes ?? body.reason,
        evidenceRefs: [evidence.id],
        downstreamVerified: true,
        requestId,
      });
      await tx.adminAuditLog.create({ data: {
        actorId: actor.id,
        actorRole: actor.role,
        action: "safety.review.decision",
        targetType: current.targetType,
        targetId: current.targetId,
        reason: body.reason,
        before: toInputJson({ reportId, status: current.status, policyCode: current.category }),
        after: toInputJson({ reportId, status: updated.status, policyCode: body.policyCode }),
        requestId,
      } });
      await tx.mainOutboxEvent.create({ data: {
        eventType: "admin.moderation.report_decided.v2",
        aggregateType: "content_report",
        aggregateId: reportId,
        payload: toInputJson({ reportId, targetType: current.targetType, targetId: current.targetId, decision: body.decision, actorId: actor.id, requestId }),
      } });
      return { review, report: updated };
    },
  });
  return ok(result);
}

export async function appealDecision(request: Request, appealId: string) {
  const actor = await actorWithPermission(request, "safety.review.write");
  const body = appealDecisionSchema.parse(await jsonBody(request));
  const expectedConfirmation = appealOutcomeConfirmation(body.outcome);
  if (body.confirmation !== expectedConfirmation && body.confirmation !== appealId) {
    throw Errors.badRequest(`Appeal decision requires confirmation ${expectedConfirmation}`);
  }
  const result = await executeIdempotentModerationCommand({
    request,
    actor,
    commandType: "safety.appeal.decision",
    targetType: "appeal",
    targetId: appealId,
    payload: body,
    execute: async (tx, requestId) => {
      const current = await tx.appeal.findUnique({ where: { id: appealId } });
      if (!current) throw Errors.notFound("Appeal not found");
      if (body.outcome !== "open" && current.status !== "open") throw Errors.conflict("Appeal already has a terminal decision");
      const restored = body.outcome === "overturned"
        ? await restoreAppealTarget(current.targetType, current.targetId, tx)
        : { targetRestored: false };
      const updated = await tx.appeal.update({
        where: { id: appealId },
        data: body.outcome === "open"
          ? { status: "open", reviewerId: null, resolvedAt: null }
          : { status: body.outcome, reviewerId: actor.id, resolvedAt: new Date() },
      });
      const adminCase = await ensureReviewCaseForAppeal(tx, current);
      if (!adminCase) throw Errors.conflict("Open appeal did not produce a Review Case");
      const evidence = await tx.caseEvidence.findUniqueOrThrow({ where: { caseId_sourceType_sourceId: { caseId: adminCase.id, sourceType: "appeal", sourceId: current.id } } });
      await recordReviewCaseDecision(tx, {
        caseId: adminCase.id,
        actor,
        decision: body.outcome,
        summary: body.notes ?? `Appeal ${body.outcome}`,
        evidenceRefs: [evidence.id],
        downstreamVerified: body.outcome !== "open",
        requestId,
      });
      await tx.adminAuditLog.create({ data: {
        actorId: actor.id,
        actorRole: actor.role,
        action: "safety.appeal.decision",
        targetType: "appeal",
        targetId: appealId,
        reason: body.reason,
        before: toInputJson({ status: current.status, targetType: current.targetType, targetId: current.targetId }),
        after: toInputJson({ status: updated.status, targetType: updated.targetType, targetId: updated.targetId, notes: body.notes, ...restored }),
        requestId,
      } });
      await tx.mainOutboxEvent.create({ data: {
        eventType: "admin.moderation.appeal_decided.v2",
        aggregateType: "appeal",
        aggregateId: appealId,
        payload: toInputJson({ appealId, targetType: current.targetType, targetId: current.targetId, outcome: body.outcome, actorId: actor.id, requestId }),
      } });
      return { appeal: updated, target: restored };
    },
  });
  return ok(result);
}

function appealOutcomeConfirmation(outcome: z.infer<typeof appealDecisionSchema>["outcome"]) {
  if (outcome === "upheld") return "UPHOLD";
  if (outcome === "overturned") return "OVERTURN";
  if (outcome === "modified") return "MODIFY";
  return "REOPEN";
}

async function applyModerationAction(
  targetType: string,
  targetId: string,
  db: Prisma.TransactionClient | typeof prisma = prisma,
) {
  // INVARIANT: "actioned" must actually take content down. Feed items wrap a
  // character, so resolve and remove it; unknown target types throw so the
  // decision transaction rolls back instead of marking a report falsely handled.
  if (targetType === "character") {
    await db.character.updateMany({
      where: { id: targetId },
      data: { status: "removed" },
    });
    return;
  }
  if (targetType === "media") {
    await db.mediaAsset.updateMany({
      where: { id: targetId },
      data: { safetyStatus: "blocked", visibility: "private" },
    });
    return;
  }
  if (targetType === "feed_item") {
    const characterId = feedItemCharacterId(targetId);
    if (!characterId) {
      throw Errors.badRequest(`Cannot resolve feed_item moderation target: ${targetId}`);
    }
    await db.character.updateMany({
      where: { id: characterId },
      data: { status: "removed" },
    });
    return;
  }
  throw Errors.badRequest(`Unsupported moderation target type: ${targetType}`);
}

async function restoreAppealTarget(
  targetType: string,
  targetId: string,
  db: Prisma.TransactionClient | typeof prisma = prisma,
) {
  if (targetType === "character") {
    const result = await db.character.updateMany({
      where: { id: targetId },
      data: { status: "approved" },
    });
    return { targetRestored: result.count > 0, restoredTargetType: targetType };
  }
  if (targetType === "feed_item") {
    const characterId = feedItemCharacterId(targetId);
    if (!characterId) {
      return { targetRestored: false, restoredTargetType: targetType, restoreReason: "unresolvable_feed_item" };
    }
    const result = await db.character.updateMany({
      where: { id: characterId },
      data: { status: "approved" },
    });
    return { targetRestored: result.count > 0, restoredTargetType: targetType, restoredTargetId: characterId };
  }
  if (targetType === "media") {
    const result = await db.mediaAsset.updateMany({
      where: { id: targetId },
      data: { safetyStatus: "passed" },
    });
    return { targetRestored: result.count > 0, restoredTargetType: targetType };
  }
  if (targetType === "user_profile") {
    const result = await db.user.updateMany({
      where: { id: targetId, status: { not: "deleted" } },
      data: { status: "active" },
    });
    return { targetRestored: result.count > 0, restoredTargetType: targetType };
  }
  return { targetRestored: false, restoredTargetType: targetType, restoreReason: "manual_followup_required" };
}

// Feed item ids are encoded as `character:<id>` (see ourdream feed handlers).
function feedItemCharacterId(itemId: string) {
  const decoded = decodeURIComponent(itemId);
  return decoded.startsWith("character:") ? decoded.slice("character:".length) : null;
}

function adminListCursorKeys(
  url: URL,
  scope: string,
  queryIdentity: unknown,
  parameter = "cursor",
) {
  const raw = url.searchParams.get(parameter);
  if (!raw) return undefined;
  return decodeAdminListCursor(raw, scope, queryIdentity);
}

function adminCursorString(keys: readonly unknown[], index: number, scope: string) {
  const value = keys[index];
  if (typeof value !== "string" || !value) throw Errors.badRequest(`${scope} cursor key is invalid`);
  return value;
}

function adminCursorNumber(keys: readonly unknown[], index: number, scope: string) {
  const value = keys[index];
  if (typeof value !== "number" || !Number.isFinite(value)) throw Errors.badRequest(`${scope} cursor key is invalid`);
  return value;
}

function adminCursorDate(keys: readonly unknown[], index: number, scope: string) {
  const value = new Date(adminCursorString(keys, index, scope));
  if (Number.isNaN(value.getTime())) throw Errors.badRequest(`${scope} cursor timestamp is invalid`);
  return value;
}

function adminListPageInfo<T>(
  scope: string,
  queryIdentity: unknown,
  page: readonly T[],
  hasNextPage: boolean,
  keys: (row: T) => readonly (string | number | boolean | null)[],
) {
  const last = page.at(-1);
  return {
    endCursor: hasNextPage && last ? encodeAdminListCursor(scope, queryIdentity, keys(last)) : null,
    hasNextPage,
  };
}
