import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { actorWithPermission, queryParams } from "@/server/modules/admin-v2/shared/authority";
import {
  type AdminKeysetPaging,
  CREATED_AT_DESC_KEYS,
  paginateAdminKeyset,
} from "@/server/modules/admin-v2/shared/list-cursor";

export async function auditLog(request: Request) {
  await actorWithPermission(request, "audit.read");
  const query = queryParams(request, "GET /api/v2/admin/audit-log");
  const { search, action, actorId, targetType, limit } = query;
  const queryIdentity = { search, action, actorId, targetType };
  const where: Prisma.AdminAuditLogWhereInput = {
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
  };
  const { items: page, pageInfo } = await paginateAdminKeyset({
    scope: "audit_log",
    queryIdentity,
    cursor: query.cursor,
    before: query.before,
    limit,
    keys: CREATED_AT_DESC_KEYS,
    fetch: (paging: AdminKeysetPaging<Prisma.AdminAuditLogOrderByWithRelationInput>) =>
      prisma.adminAuditLog.findMany({
        where: { AND: [where, ...paging.cursorWhere] },
        orderBy: paging.orderBy,
        take: paging.take,
      }),
    count: () => prisma.adminAuditLog.count({ where }),
  });
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
    pageInfo,
  };
}
