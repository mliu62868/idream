import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { actorWithPermission, queryParams } from "@/server/modules/admin-v2/shared/authority";
import {
  decodeAdminListCursor,
  encodeAdminListCursor,
} from "@/server/modules/admin-v2/shared/list-cursor";

export async function auditLog(request: Request) {
  await actorWithPermission(request, "audit.read");
  const query = queryParams(request, "GET /api/v2/admin/audit-log");
  const { search, action, actorId, targetType, limit } = query;
  const queryIdentity = { search, action, actorId, targetType };
  const cursorKeys = query.cursor
    ? decodeAdminListCursor(query.cursor, "audit_log", queryIdentity)
    : undefined;
  const cursorWhere: Prisma.AdminAuditLogWhereInput | undefined = cursorKeys
    ? (() => {
        const createdAt = new Date(cursorString(cursorKeys, 0));
        if (Number.isNaN(createdAt.getTime())) {
          throw Errors.badRequest("audit_log cursor timestamp is invalid");
        }
        const id = cursorString(cursorKeys, 1);
        return { OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: id } }] };
      })()
    : undefined;
  const logs = await prisma.adminAuditLog.findMany({
    where: {
      action,
      actorId,
      targetType,
      OR: search
        ? [
            { id: { contains: search } },
            { action: { contains: search } },
            { actorId: { contains: search } },
            { targetId: { contains: search } },
            { reason: { contains: search } },
          ]
        : undefined,
      AND: cursorWhere,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const page = logs.slice(0, limit);
  const last = page.at(-1);
  const hasNextPage = logs.length > limit;
  return {
    items: page.map((entry) => ({
      id: entry.id,
      actorId: entry.actorId,
      actorRole: entry.actorRole,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      reason: entry.reason,
      before: entry.before,
      after: entry.after,
      requestId: entry.requestId,
      ipHash: entry.ipHash,
      userAgent: entry.userAgent,
      createdAt: entry.createdAt.toISOString(),
    })),
    pageInfo: {
      endCursor: hasNextPage && last
        ? encodeAdminListCursor("audit_log", queryIdentity, [
            last.createdAt.toISOString(),
            last.id,
          ])
        : null,
      hasNextPage,
    },
  };
}

function cursorString(keys: readonly unknown[], index: number) {
  const value = keys[index];
  if (typeof value !== "string" || !value) throw Errors.badRequest("audit_log cursor key is invalid");
  return value;
}
