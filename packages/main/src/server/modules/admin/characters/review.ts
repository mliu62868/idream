// SPEC: 角色人审队列 —— 把 public 角色提交（CharacterSubmission status=pending）显式化为一个审核入口，
//        审核员 approve/reject 后同步角色 status 与提交记录，并写审计。
// INTENT: 复用既有 safety.review.read/write 权限，不新增权限、不改 schema；只新增列表 + 决策两个 handler。
// INVARIANTS: 只处理 status=pending 的提交（已审 → 400）；approve/reject 在单事务内同时落地 character + submission；
//             每次决策恰好一条审计（action=content.submission.review，targetId=characterId）。
// EXAMPLE: list → [{ submissionId, submittedAt, character, reportCount }]；
//          decision approve → character.status=approved 且 submission.status=approved。
import { z } from "zod";
import {
  actorWithPermission,
  clampInt,
  jsonBody,
  toInputJson,
} from "@/server/modules/admin/shared/legacy-primitives";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import {
  isMediaAssetOperationalForAuthority,
  isSyntheticMediaAsset,
  resolveMediaAssetBlobLocator,
} from "@/server/lib/media-asset-authority";
import { executeIdempotentDomainCommand } from "@/server/modules/admin/shared/domain-command";
import {
  lockCharacterGenerationAuthority,
  lockMediaAssetAuthority,
} from "@/server/modules/admin-v2/characters/generation-authority-lock";
import {
  decodeAdminListCursor,
  encodeAdminListCursor,
  parseIsoCursorKey,
} from "@/server/modules/admin-v2/shared/list-cursor";
import {
  operationalCharacterSubmissionWhere,
  operationalContentReportWhere,
} from "@/server/modules/admin/shared/metric-data-scope";

const characterSelect = {
  id: true,
  name: true,
  gender: true,
  style: true,
  visibility: true,
  status: true,
  description: true,
  imageAssetId: true,
  createdAt: true,
} as const;

const reviewDecisionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  reviewReason: z.string().trim().max(2_000).optional(),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

export async function listReviewQueue(request: Request): Promise<Response> {
  await actorWithPermission(request, "safety.review.read");
  const url = new URL(request.url);
  const search = url.searchParams.get("search")?.trim() || undefined;
  const reportFilter = z.enum(["all", "reported", "clean"]).catch("all").parse(url.searchParams.get("reportFilter") ?? "all");
  const limit = clampInt(url.searchParams.get("limit"), 1, 100, 25);
  const reportedCharacterIds = reportFilter === "all" ? [] : (await prisma.contentReport.findMany({
    where: operationalContentReportWhere({ targetType: "character" }),
    distinct: ["targetId"],
    select: { targetId: true },
  })).map((report) => report.targetId);
  const queryIdentity = { search, reportFilter, sort: "submitted_asc" };
  const cursorKeys = url.searchParams.get("cursor")
    ? decodeAdminListCursor(url.searchParams.get("cursor")!, "character_review_queue", queryIdentity)
    : null;
  const [cursorAt, cursorId] = cursorKeys
    ? [parseIsoCursorKey(cursorKeys[0], "character_review_queue"), z.string().min(1).parse(cursorKeys[1])]
    : [null, null];
  const submissions = await prisma.characterSubmission.findMany({
    where: operationalCharacterSubmissionWhere({
      status: "pending",
      characterId: reportFilter === "reported"
        ? { in: reportedCharacterIds }
        : reportFilter === "clean"
          ? { notIn: reportedCharacterIds }
          : undefined,
      ...(search ? { OR: [
        { id: { contains: search, mode: "insensitive" } },
        { characterId: { contains: search, mode: "insensitive" } },
        { character: { is: { OR: [
          { name: { contains: search, mode: "insensitive" } },
          { description: { contains: search, mode: "insensitive" } },
          { gender: { contains: search, mode: "insensitive" } },
          { style: { contains: search, mode: "insensitive" } },
        ] } } },
      ] } : {}),
      ...(cursorAt && cursorId ? { AND: [{ OR: [
        { submittedAt: { gt: cursorAt } },
        { submittedAt: cursorAt, id: { gt: cursorId } },
      ] }] } : {}),
    }),
    orderBy: [{ submittedAt: "asc" }, { id: "asc" }],
    take: limit + 1,
    include: { character: { select: characterSelect } },
  });
  const hasNextPage = submissions.length > limit;
  const page = submissions.slice(0, limit);

  const items = await Promise.all(
    page.map(async (submission) => ({
      submissionId: submission.id,
      submittedAt: submission.submittedAt,
      character: submission.character,
      reportCount: await prisma.contentReport.count({
        where: operationalContentReportWhere({
          targetType: "character",
          targetId: submission.characterId,
        }),
      }),
    })),
  );

  const last = page.at(-1);
  return ok({
    items,
    pageInfo: {
      endCursor: hasNextPage && last
        ? encodeAdminListCursor("character_review_queue", queryIdentity, [last.submittedAt.toISOString(), last.id])
        : null,
      hasNextPage,
    },
    asOf: new Date().toISOString(),
    freshness: "fresh",
  });
}

export async function reviewSubmission(request: Request, id: string): Promise<Response> {
  const actor = await actorWithPermission(request, "safety.review.write");
  const body = reviewDecisionSchema.parse(await jsonBody(request));
  if (body.confirmation !== id) {
    throw Errors.badRequest("Confirmation did not match review decision");
  }

  const locator = await prisma.characterSubmission.findFirst({
    where: operationalCharacterSubmissionWhere({ id }),
    select: { characterId: true },
  });
  if (!locator) throw Errors.notFound("Character submission not found");

  const result = await executeIdempotentDomainCommand({
    request,
    actor,
    commandType: "content.submission.review",
    targetType: "character_submission",
    targetId: id,
    payload: body,
    execute: async (tx, requestId) => {
      await lockCharacterGenerationAuthority(tx, locator.characterId);
      const submission = await tx.characterSubmission.findFirst({
        where: operationalCharacterSubmissionWhere({ id }),
        include: { character: { select: characterSelect } },
      });
      if (!submission) throw Errors.notFound("Character submission not found");
      if (submission.status !== "pending") {
        throw Errors.conflict("Submission already has a terminal review decision");
      }
      if (
        submission.character.visibility !== "public" ||
        submission.character.status !== "pending_review"
      ) {
        throw Errors.conflict("Character is no longer awaiting public review");
      }

      const imageAssetId = submission.character.imageAssetId;
      if (imageAssetId) {
        await lockMediaAssetAuthority(tx, imageAssetId);
      }
      if (body.decision === "approve" && imageAssetId) {
        const imageAsset = await tx.mediaAsset.findFirst({
          where: {
            id: imageAssetId,
            characterId: submission.characterId,
            deletedAt: null,
            type: "image",
          },
          select: {
            id: true,
            storageKey: true,
            safetyStatus: true,
            metadata: true,
          },
        });
        if (
          !imageAsset ||
          imageAsset.safetyStatus !== "passed" ||
          !isMediaAssetOperationalForAuthority(imageAsset.metadata) ||
          isSyntheticMediaAsset(imageAsset.metadata)
        ) {
          throw Errors.conflict("Character identity image is not independently approved");
        }
        if (
          isDuplicateMedia(imageAsset.metadata) &&
          resolveMediaAssetBlobLocator(imageAsset)?.kind !== "shared_immutable"
        ) {
          throw Errors.conflict("Duplicate Character identity bytes are not serviceable");
        }
      }

      const nextStatus = body.decision === "approve" ? "approved" : "rejected";
      const reviewedAt = new Date();
      await tx.character.update({
        where: { id: submission.characterId },
        data: { status: nextStatus },
      });
      const updated = await tx.characterSubmission.update({
        where: { id: submission.id },
        data: {
          status: nextStatus,
          reviewerId: actor.id,
          reviewedAt,
          reviewReason: body.reviewReason,
        },
      });
      await tx.adminAuditLog.create({
        data: {
          actorId: actor.id,
          actorRole: actor.role,
          action: "content.submission.review",
          targetType: "character",
          targetId: submission.characterId,
          reason: body.reason,
          before: toInputJson({
            characterStatus: submission.character.status,
            submissionStatus: submission.status,
            imageAssetId,
          }),
          after: toInputJson({
            characterStatus: nextStatus,
            submissionStatus: nextStatus,
            imageAssetId,
          }),
          requestId,
        },
      });
      await tx.mainOutboxEvent.create({
        data: {
          eventType: "admin.character_submission.reviewed.v1",
          aggregateType: "character",
          aggregateId: submission.characterId,
          payload: toInputJson({
            submissionId: submission.id,
            characterId: submission.characterId,
            decision: body.decision,
            imageAssetId,
            actorId: actor.id,
            requestId,
          }),
        },
      });
      return { submission: updated };
    },
  });
  return ok(result);
}

function isDuplicateMedia(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const lineage = (value as Record<string, unknown>).duplicateLineage;
  return Boolean(lineage && typeof lineage === "object" && !Array.isArray(lineage));
}
