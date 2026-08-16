import { randomUUID } from "node:crypto";
import type {
  moderationAppealDecisionResponseSchema,
  moderationMediaDecisionResponseSchema,
  moderationReportDecisionResponseSchema,
} from "@idream/shared/admin/contracts";
import type { z } from "zod";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { resolveMediaAssetBlobLocator } from "@/server/lib/media-asset-authority";
import {
  ensureReviewCaseForAppeal,
  ensureReviewCaseForReport,
  recordReviewCaseDecision,
} from "@/server/modules/admin-v2/cases/service";
import {
  lockCharacterGenerationAuthority,
  lockMediaAssetAuthority,
} from "@/server/modules/admin-v2/characters/generation-authority-lock";
import { executeAtomicIdempotentMutation } from "@/server/modules/admin-v2/shared/atomic-mutation";
import {
  actorWithPermission,
  jsonBody,
  type AdminV2RequestBody,
} from "@/server/modules/admin-v2/shared/authority";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import { operationalMediaAssetWhere } from "@/server/modules/metric-data-scope";
import { duplicateLineage } from "./duplicate-lineage";
import { serializeAppeal, serializeReport, serializeReview } from "./queue";
import {
  applyModerationAction,
  restoreCanonicalAppealTarget,
  type ModerationTargetRestoration,
} from "./moderation-effect";

type ReportDecisionBody = AdminV2RequestBody<
  "moderationReportDecisionRequestSchema+idempotency-key"
>;
type MediaDecisionBody = AdminV2RequestBody<
  "moderationMediaDecisionRequestSchema+idempotency-key"
>;
type AppealDecisionBody = AdminV2RequestBody<
  "moderationAppealDecisionRequestSchema+idempotency-key"
>;

type ReportDecisionResponse = z.infer<typeof moderationReportDecisionResponseSchema>;
type MediaDecisionResponse = z.infer<typeof moderationMediaDecisionResponseSchema>;
type AppealDecisionResponse = z.infer<typeof moderationAppealDecisionResponseSchema>;

function requestIdOf(request: Request) {
  return request.headers.get("x-request-id")?.trim() || randomUUID();
}

/**
 * SPEC: 对一张「独立复本」角色图的人工复核。
 * INTENT: 这条路径只受理身份图，且只受理仍处于未决安全态的那一张 —— 先把定位读出来再进事务，
 *         是为了让「这张图根本不该走这条路」在扣任何幂等键之前就失败。
 */
export async function mediaReviewDecision(
  request: Request,
  mediaAssetId: string,
): Promise<MediaDecisionResponse> {
  const actor = await actorWithPermission(request, "safety.review.write");
  const body = await jsonBody(
    request,
    "moderationMediaDecisionRequestSchema+idempotency-key",
  ) as MediaDecisionBody;
  if (body.confirmation !== mediaAssetId) {
    throw Errors.badRequest("Confirmation did not match the media asset");
  }

  const locator = await prisma.mediaAsset.findFirst({
    where: operationalMediaAssetWhere({
      id: mediaAssetId,
      deletedAt: null,
    }),
    select: { characterId: true },
  });
  if (!locator) throw Errors.notFound("Media asset not found");
  if (!locator.characterId) {
    throw Errors.conflict("Media asset is not attached to a Character");
  }
  const characterId = locator.characterId;
  const requestId = requestIdOf(request);

  return await executeAtomicIdempotentMutation({
    environment: env.APP_ENV,
    actor,
    idempotencyKey: requireIdempotencyKey(request),
    requestId,
    commandType: "safety.media.review",
    target: { type: "media", id: mediaAssetId },
    payload: body,
    mutate: async (tx) => {
      await lockCharacterGenerationAuthority(tx, characterId);
      await lockMediaAssetAuthority(tx, mediaAssetId);
      const asset = await tx.mediaAsset.findFirst({
        where: operationalMediaAssetWhere({
          id: mediaAssetId,
          characterId,
          deletedAt: null,
        }),
      });
      const character = await tx.character.findFirst({
        where: {
          id: characterId,
          deletedAt: null,
          imageAssetId: mediaAssetId,
        },
        select: { id: true, creatorId: true, imageAssetId: true },
      });
      if (!asset || !character) {
        throw Errors.conflict("Media asset is no longer the Character identity image");
      }
      const lineage = duplicateLineage(asset.metadata);
      if (
        !lineage ||
        lineage.duplicateCharacterId !== character.id ||
        lineage.duplicatedByUserId !== asset.ownerId ||
        character.creatorId !== asset.ownerId
      ) {
        throw Errors.badRequest("Media asset is not an independently reviewable Character duplicate");
      }
      if (!["unknown", "flagged"].includes(asset.safetyStatus)) {
        throw Errors.conflict("Media asset already has a terminal review decision");
      }
      if (
        body.decision === "passed" &&
        resolveMediaAssetBlobLocator(asset)?.kind !== "shared_immutable"
      ) {
        throw Errors.conflict("Duplicate media bytes are not backed by a valid immutable locator");
      }

      const updated = await tx.mediaAsset.update({
        where: { id: mediaAssetId },
        data: {
          safetyStatus: body.decision,
          visibility: body.decision === "blocked" ? "private" : undefined,
        },
      });
      const review = await tx.moderationReview.create({
        data: {
          reviewerId: actor.id,
          decision: body.decision,
          policyCode: "independent_duplicate_media_review",
          notes: body.reason,
        },
      });
      await tx.adminAuditLog.create({
        data: {
          actorId: actor.id,
          actorRole: actor.role,
          action: "safety.media.review",
          targetType: "media",
          targetId: mediaAssetId,
          reason: body.reason,
          before: toInputJson({
            safetyStatus: asset.safetyStatus,
            characterId: character.id,
            sourceAssetId: lineage.sourceAssetId,
          }),
          after: toInputJson({
            safetyStatus: updated.safetyStatus,
            characterId: character.id,
            reviewId: review.id,
          }),
          requestId,
        },
      });
      await tx.mainOutboxEvent.create({
        data: {
          eventType: "admin.moderation.media_reviewed.v1",
          aggregateType: "media",
          aggregateId: mediaAssetId,
          payload: toInputJson({
            mediaAssetId,
            characterId: character.id,
            decision: body.decision,
            actorId: actor.id,
            requestId,
          }),
        },
      });
      return {
        asset: {
          id: updated.id,
          ownerId: updated.ownerId,
          characterId: updated.characterId,
          safetyStatus: updated.safetyStatus,
          visibility: updated.visibility,
          createdAt: updated.createdAt.toISOString(),
        },
        review: serializeReview(review),
      };
    },
    decorateResult: (result, replayed) => ({
      ...(result as Omit<MediaDecisionResponse, "replayed">),
      replayed,
    }),
  }) as MediaDecisionResponse;
}

export async function moderationDecision(
  request: Request,
  reportId: string,
): Promise<ReportDecisionResponse> {
  const actor = await actorWithPermission(request, "safety.review.write");
  const body = await jsonBody(
    request,
    "moderationReportDecisionRequestSchema+idempotency-key",
  ) as ReportDecisionBody;
  if (body.decision === "actioned" && body.confirmation !== reportId && body.confirmation !== "TAKEDOWN") {
    throw Errors.badRequest("Actioned decisions require target confirmation");
  }
  const requestId = requestIdOf(request);
  return await executeAtomicIdempotentMutation({
    environment: env.APP_ENV,
    actor,
    idempotencyKey: requireIdempotencyKey(request),
    requestId,
    commandType: "safety.review.decision",
    target: { type: "content_report", id: reportId },
    payload: body,
    mutate: async (tx) => {
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
      if (body.decision === "actioned") {
        await applyModerationAction(
          current.targetType,
          current.targetId,
          review.id,
          tx,
        );
      }
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
      return { review: serializeReview(review), report: serializeReport(updated) };
    },
    decorateResult: (result, replayed) => ({
      ...(result as Omit<ReportDecisionResponse, "replayed">),
      replayed,
    }),
  }) as ReportDecisionResponse;
}

export async function appealDecision(
  request: Request,
  appealId: string,
): Promise<AppealDecisionResponse> {
  const actor = await actorWithPermission(request, "safety.review.write");
  const body = await jsonBody(
    request,
    "moderationAppealDecisionRequestSchema+idempotency-key",
  ) as AppealDecisionBody;
  const expectedConfirmation = appealOutcomeConfirmation(body.outcome);
  if (body.confirmation !== expectedConfirmation && body.confirmation !== appealId) {
    throw Errors.badRequest(`Appeal decision requires confirmation ${expectedConfirmation}`);
  }
  const requestId = requestIdOf(request);
  return await executeAtomicIdempotentMutation({
    environment: env.APP_ENV,
    actor,
    idempotencyKey: requireIdempotencyKey(request),
    requestId,
    commandType: "safety.appeal.decision",
    target: { type: "appeal", id: appealId },
    payload: body,
    mutate: async (tx) => {
      const current = await tx.appeal.findUnique({ where: { id: appealId } });
      if (!current) throw Errors.notFound("Appeal not found");
      if (body.outcome !== "open" && current.status !== "open") throw Errors.conflict("Appeal already has a terminal decision");
      const restored: ModerationTargetRestoration = body.outcome === "overturned"
        ? await restoreCanonicalAppealTarget(current, tx)
        : { targetRestored: false };
      if (body.outcome === "overturned" && !restored.targetRestored) {
        throw Errors.conflict(
          "Appeal target could not be restored; the decision was not applied",
        );
      }
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
      return { appeal: serializeAppeal(updated), target: restored };
    },
    decorateResult: (result, replayed) => ({
      ...(result as Omit<AppealDecisionResponse, "replayed">),
      replayed,
    }),
  }) as AppealDecisionResponse;
}

function appealOutcomeConfirmation(outcome: AppealDecisionBody["outcome"]) {
  if (outcome === "upheld") return "UPHOLD";
  if (outcome === "overturned") return "OVERTURN";
  if (outcome === "modified") return "MODIFY";
  return "REOPEN";
}
