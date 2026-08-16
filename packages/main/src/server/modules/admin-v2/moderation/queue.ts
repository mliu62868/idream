import type { Prisma } from "@prisma/client";
import type { ModerationQueueResponse } from "@idream/shared/admin/contracts";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { queryParams } from "@/server/modules/admin-v2/shared/authority";
import {
  decodeAdminListCursor,
  encodeAdminListCursor,
} from "@/server/modules/admin-v2/shared/list-cursor";
import {
  operationalAppealWhere,
  operationalContentReportWhere,
  operationalMediaAssetWhere,
} from "@/server/modules/metric-data-scope";
import { duplicateLineage } from "./duplicate-lineage";

const DEFAULT_REPORT_STATUSES = ["open", "triaged", "reviewing"];

/**
 * SPEC: 审核队列 —— 举报 / 待独立复核的角色图 / 申诉三份互相独立的权威快照。
 * INTENT: 三个游标各自独立，是因为运营台三块区域各自翻页；把它们合成一个游标会让任一块翻页
 *         把另外两块也翻掉。`scope` 只决定「这次要哪一块」，不改变另外两块的语义。
 */
export async function moderationQueue(request: Request): Promise<ModerationQueueResponse> {
  const query = queryParams(request, "GET /api/v2/admin/moderation/queue");
  const url = new URL(request.url);
  const { scope, search, id, targetType, targetId, limit } = query;
  const requestedStatuses = query.status
    ?.split(",")
    .map((status) => status.trim())
    .filter(Boolean);
  const statuses = requestedStatuses?.length && !requestedStatuses.includes("all")
    ? requestedStatuses
    : DEFAULT_REPORT_STATUSES;
  const queryIdentity = { search, id, targetType, targetId, statuses };
  const reportCursorKeys = !scope || scope === "reports"
    ? adminListCursorKeys(url, "moderation_reports", queryIdentity, "reportCursor")
    : undefined;
  const mediaCursorKeys = !scope || scope === "media"
    ? adminListCursorKeys(url, "moderation_media_review", queryIdentity, "mediaCursor")
    : undefined;
  const appealCursorKeys = !scope || scope === "appeals"
    ? adminListCursorKeys(url, "moderation_appeals", queryIdentity, "appealCursor")
    : undefined;
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
    where: operationalContentReportWhere(reportWhere),
    orderBy: [{ priority: "asc" }, { createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const mediaReview = scope && scope !== "media" ? [] : await prisma.mediaAsset.findMany({
    where: operationalMediaAssetWhere({
      deletedAt: null,
      AND: [
        {
          OR: [
            { safetyStatus: "blocked" },
            {
              safetyStatus: { in: ["unknown", "flagged"] },
              metadata: {
                path: ["duplicateLineage", "schemaVersion"],
                equals: 1,
              },
              characterImageOf: {
                some: { deletedAt: null },
              },
            },
          ],
        },
        ...(search
          ? [{
              OR: [
                { id: { contains: search } },
                { ownerId: { contains: search } },
                { characterId: { contains: search } },
                { type: { contains: search } },
              ],
            }]
          : []),
        ...(mediaCursorKeys
          ? [{
              OR: (() => {
                const createdAt = adminCursorDate(mediaCursorKeys, 0, "moderation_media_review");
                const cursorId = adminCursorString(mediaCursorKeys, 1, "moderation_media_review");
                return [{ createdAt: { gt: createdAt } }, { createdAt, id: { gt: cursorId } }];
              })(),
            }]
          : []),
      ],
    }),
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: limit + 1,
  });
  const appeals = scope && scope !== "appeals" ? [] : await prisma.appeal.findMany({
    where: operationalAppealWhere({
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
    }),
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: limit + 1,
  });
  const reportPage = reports.slice(0, limit);
  const mediaPage = mediaReview.slice(0, limit);
  const appealPage = appeals.slice(0, limit);
  return {
    reports: reportPage.map((report) => ({
      id: report.id,
      reporterId: report.reporterId,
      targetType: report.targetType,
      targetId: report.targetId,
      category: report.category,
      description: report.description,
      status: report.status,
      priority: report.priority,
      createdAt: report.createdAt.toISOString(),
    })),
    mediaReview: mediaPage.map((asset) => {
      const lineage = duplicateLineage(asset.metadata);
      return {
        id: asset.id,
        ownerId: asset.ownerId,
        characterId: asset.characterId,
        type: asset.type,
        url: asset.url,
        thumbnailUrl: asset.thumbnailUrl,
        safetyStatus: asset.safetyStatus,
        reviewKind: lineage ? "independent_duplicate" as const : "blocked" as const,
        sourceAssetId: lineage?.sourceAssetId ?? null,
        sourceCharacterId: lineage?.sourceCharacterId ?? null,
        createdAt: asset.createdAt.toISOString(),
      };
    }),
    appeals: appealPage.map((appeal) => serializeAppeal(appeal)),
    pageInfo: {
      reports: adminListPageInfo("moderation_reports", queryIdentity, reportPage, reports.length > limit, (row) => [
        row.priority,
        row.createdAt.toISOString(),
        row.id,
      ]),
      mediaReview: adminListPageInfo(
        "moderation_media_review",
        queryIdentity,
        mediaPage,
        mediaReview.length > limit,
        (row) => [row.createdAt.toISOString(), row.id],
      ),
      appeals: adminListPageInfo("moderation_appeals", queryIdentity, appealPage, appeals.length > limit, (row) => [
        row.createdAt.toISOString(),
        row.id,
      ]),
    },
  };
}

export function serializeAppeal(appeal: {
  id: string;
  userId: string;
  targetType: string;
  targetId: string;
  originalDecisionId: string | null;
  status: string;
  appealText: string;
  reviewerId: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
}) {
  return {
    id: appeal.id,
    userId: appeal.userId,
    targetType: appeal.targetType,
    targetId: appeal.targetId,
    originalDecisionId: appeal.originalDecisionId,
    status: appeal.status,
    appealText: appeal.appealText,
    reviewerId: appeal.reviewerId,
    createdAt: appeal.createdAt.toISOString(),
    resolvedAt: appeal.resolvedAt?.toISOString() ?? null,
  };
}

export function serializeReport(report: {
  id: string;
  reporterId: string | null;
  targetType: string;
  targetId: string;
  category: string;
  description: string | null;
  status: string;
  priority: number;
  createdAt: Date;
}) {
  return {
    id: report.id,
    reporterId: report.reporterId,
    targetType: report.targetType,
    targetId: report.targetId,
    category: report.category,
    description: report.description,
    status: report.status,
    priority: report.priority,
    createdAt: report.createdAt.toISOString(),
  };
}

export function serializeReview(review: {
  id: string;
  reportId: string | null;
  reviewerId: string;
  decision: string;
  policyCode: string | null;
  notes: string | null;
  createdAt: Date;
}) {
  return {
    id: review.id,
    reportId: review.reportId,
    reviewerId: review.reviewerId,
    decision: review.decision,
    policyCode: review.policyCode,
    notes: review.notes,
    createdAt: review.createdAt.toISOString(),
  };
}

function adminListCursorKeys(
  url: URL,
  scope: string,
  queryIdentity: unknown,
  parameter: string,
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
