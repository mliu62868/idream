import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import { actorWithPermission } from "@/server/modules/admin/shared/legacy-primitives";
import { decodeAdminListCursor, encodeAdminListCursor } from "@/server/modules/admin-v2/shared/list-cursor";

const auditQuerySchema = z.object({
  search: z.string().trim().min(1).max(200).optional(),
  action: z.string().trim().min(1).max(160).optional(),
  actorId: z.string().trim().min(1).max(160).optional(),
  targetType: z.string().trim().min(1).max(160).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(80),
  cursor: z.string().trim().min(1).optional(),
}).strict();

export async function auditLog(request: Request) {
  await actorWithPermission(request, "audit.read");
  const query = auditQuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
  const { search, action, actorId, targetType, limit } = query;
  const queryIdentity = { search, action, actorId, targetType };
  const cursorKeys = query.cursor ? decodeAdminListCursor(query.cursor, "audit_log", queryIdentity) : undefined;
  const cursorWhere: Prisma.AdminAuditLogWhereInput | undefined = cursorKeys ? (() => {
    const createdAt = new Date(cursorString(cursorKeys, 0));
    if (Number.isNaN(createdAt.getTime())) throw Errors.badRequest("audit_log cursor timestamp is invalid");
    const id = cursorString(cursorKeys, 1);
    return { OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: id } }] };
  })() : undefined;
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
  return ok({
    items: page,
    pageInfo: {
      endCursor: hasNextPage && last
        ? encodeAdminListCursor("audit_log", queryIdentity, [last.createdAt.toISOString(), last.id])
        : null,
      hasNextPage,
    },
  });
}

function cursorString(keys: readonly unknown[], index: number) {
  const value = keys[index];
  if (typeof value !== "string" || !value) throw Errors.badRequest("audit_log cursor key is invalid");
  return value;
}
