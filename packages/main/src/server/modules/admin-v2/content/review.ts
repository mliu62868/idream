import type { Prisma } from "@prisma/client";
import type {
  ContentReviewDecisionRequest,
  ContentReviewQueueQuery,
} from "@idream/shared/admin";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import {
  isMediaAssetOperationalForAuthority,
  isSyntheticMediaAsset,
  resolveMediaAssetBlobLocator,
} from "@/server/lib/media-asset-authority";
import {
  operationalCharacterSubmissionWhere,
  operationalContentReportWhere,
} from "@/server/modules/metric-data-scope";
import {
  lockCharacterGenerationAuthority,
  lockMediaAssetAuthority,
} from "../characters/generation-authority-lock";
import { ensureCustomerCharacterPublicationPrep } from "../characters/publication-prep";
import type { AdminActor } from "../shared/authority";
import {
  decodeAdminListCursor,
  encodeAdminListCursor,
  parseIsoCursorKey,
} from "../shared/list-cursor";
import { toInputJson } from "../shared/prisma-json";

// SPEC: 角色人审队列 —— 把 public 角色提交（CharacterSubmission status=pending）显式化为一个审核入口，
//       审核员 approve/reject 后同步角色 status 与提交记录，并写审计。
// INVARIANT: 只处理 status=pending 的提交（已审 → 409）；approve/reject 在单事务内同时落地
//            character + submission；每次决策恰好一条审计（action=content.submission.review）。

const characterSelect = {
  id: true,
  name: true,
  gender: true,
  style: true,
  visibility: true,
  status: true,
  description: true,
  imageAssetId: true,
  source: true,
  createdAt: true,
} as const;

export async function listReviewQueue(query: ContentReviewQueueQuery) {
  const { search, reportFilter, limit } = query;
  const reportedCharacterIds = reportFilter === "all" ? [] : (
    await prisma.contentReport.findMany({
      where: operationalContentReportWhere({ targetType: "character" }),
      distinct: ["targetId"],
      select: { targetId: true },
    })
  ).map((report) => report.targetId);
  const queryIdentity = { search, reportFilter, sort: "submitted_asc" };
  const cursorKeys = query.cursor
    ? decodeAdminListCursor(query.cursor, "character_review_queue", queryIdentity)
    : null;
  const [cursorAt, cursorId] = cursorKeys
    ? [parseIsoCursorKey(cursorKeys[0], "character_review_queue"), cursorText(cursorKeys[1])]
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
        { id: { contains: search, mode: "insensitive" as const } },
        { characterId: { contains: search, mode: "insensitive" as const } },
        { character: { is: { OR: [
          { name: { contains: search, mode: "insensitive" as const } },
          { description: { contains: search, mode: "insensitive" as const } },
          { gender: { contains: search, mode: "insensitive" as const } },
          { style: { contains: search, mode: "insensitive" as const } },
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

  const items = await Promise.all(page.map(async (submission) => ({
    submissionId: submission.id,
    submittedAt: submission.submittedAt.toISOString(),
    character: {
      ...submission.character,
      createdAt: submission.character.createdAt.toISOString(),
    },
    reportCount: await prisma.contentReport.count({
      where: operationalContentReportWhere({
        targetType: "character",
        targetId: submission.characterId,
      }),
    }),
  })));

  const last = page.at(-1);
  return {
    items,
    pageInfo: {
      endCursor: hasNextPage && last
        ? encodeAdminListCursor("character_review_queue", queryIdentity, [
            last.submittedAt.toISOString(),
            last.id,
          ])
        : null,
      hasNextPage,
    },
    asOf: new Date().toISOString(),
    freshness: "fresh" as const,
  };
}

export async function reviewSubmission(input: {
  tx: Prisma.TransactionClient;
  actor: AdminActor;
  requestId: string;
  id: string;
  body: ContentReviewDecisionRequest;
}) {
  const { tx, actor, requestId, id, body } = input;
  if (body.confirmation !== id) {
    throw Errors.badRequest("Confirmation did not match review decision");
  }
  const locator = await tx.characterSubmission.findFirst({
    where: operationalCharacterSubmissionWhere({ id }),
    select: { characterId: true },
  });
  if (!locator) throw Errors.notFound("Character submission not found");

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
      select: { id: true, storageKey: true, safetyStatus: true, metadata: true },
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
  const publication = body.decision === "approve"
    ? await ensureCustomerCharacterPublicationPrep(tx, {
        characterId: submission.characterId,
        submissionId: submission.id,
        actorId: actor.id,
      })
    : null;
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
        publication,
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
        publication,
      }),
    },
  });
  return {
    submission: {
      id: updated.id,
      characterId: updated.characterId,
      status: updated.status,
      reviewReason: updated.reviewReason,
      reviewerId: updated.reviewerId,
      submittedAt: updated.submittedAt.toISOString(),
      reviewedAt: updated.reviewedAt?.toISOString() ?? null,
    },
    publication: publication === undefined ? null : publication,
  };
}

function isDuplicateMedia(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const lineage = (value as Record<string, unknown>).duplicateLineage;
  return Boolean(lineage && typeof lineage === "object" && !Array.isArray(lineage));
}

function cursorText(value: unknown) {
  if (typeof value !== "string" || !value) {
    throw Errors.badRequest("Invalid character_review_queue cursor");
  }
  return value;
}
