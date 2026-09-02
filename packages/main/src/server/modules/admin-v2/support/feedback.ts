import { randomUUID } from "node:crypto";
import type { Prisma, ProductFeedbackItem } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { activeCustomerUserWhere } from "@/server/modules/ourdream/public-content-audience";
import { executeAtomicIdempotentMutation } from "../shared/atomic-mutation";
import { actorWithPermission, jsonBody, queryParams } from "../shared/authority";
import { requireIdempotencyKey } from "../shared/idempotency";
import { CREATED_AT_DESC_KEYS, paginateAdminKeyset } from "../shared/list-cursor";

// Customer feedback and authored roadmap items share the same operational list.
// Visibility is not changed by triage; audit/test actors stay outside the queue.
const operationalFeedbackWhere = {
  OR: [{ source: "official" }, { source: "user", createdBy: { is: activeCustomerUserWhere } }],
} satisfies Prisma.ProductFeedbackItemWhereInput;

function feedbackDTO(item: ProductFeedbackItem) {
  return {
    id: item.id, title: item.title, description: item.description,
    category: item.category, status: item.status, voteCount: Math.max(0, item.voteCount),
    createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString(),
  };
}

export async function listProductFeedback(request: Request) {
  await actorWithPermission(request, "support.request.read");
  const query = queryParams(request, "GET /api/v2/admin/support/feedback");
  const where: Prisma.ProductFeedbackItemWhereInput = { AND: [
    operationalFeedbackWhere,
    query.status === "all" ? {} : { status: query.status },
    query.search ? { OR: [
      { title: { contains: query.search, mode: "insensitive" } },
      { description: { contains: query.search, mode: "insensitive" } },
    ] } : {},
  ] };
  const result = await paginateAdminKeyset<ProductFeedbackItem, Prisma.ProductFeedbackItemOrderByWithRelationInput>({
    scope: "product_feedback", queryIdentity: { status: query.status, search: query.search ?? "" },
    cursor: query.cursor, limit: query.limit, keys: CREATED_AT_DESC_KEYS,
    fetch: (page) => prisma.productFeedbackItem.findMany({
      where: { AND: [where, ...page.cursorWhere] }, orderBy: page.orderBy, take: page.take,
    }),
  });
  return { items: result.items.map(feedbackDTO), pageInfo: result.pageInfo };
}

export async function updateProductFeedback(request: Request, id: string) {
  const actor = await actorWithPermission(request, "support.request.write");
  const body = await jsonBody(request, "PATCH /api/v2/admin/support/feedback/:id");
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  return executeAtomicIdempotentMutation({
    environment: env.APP_ENV, actor, requestId,
    idempotencyKey: requireIdempotencyKey(request),
    commandType: "support.feedback.update", target: { type: "product_feedback", id }, payload: body,
    mutate: async (tx) => {
      const before = await tx.productFeedbackItem.findFirst({ where: { AND: [operationalFeedbackWhere, { id }] } });
      if (!before) throw Errors.notFound("Feedback item not found");
      if (before.updatedAt.toISOString() !== body.expectedUpdatedAt) {
        throw Errors.conflict("Feedback has changed. Refresh it before updating its status.");
      }
      const item = await tx.productFeedbackItem.update({ where: { id }, data: { status: body.status } });
      await tx.adminAuditLog.create({ data: {
        actorId: actor.id, actorRole: actor.role, action: "support.feedback.update",
        targetType: "product_feedback", targetId: id, reason: body.reason, requestId,
        before: { status: before.status }, after: { status: item.status },
      } });
      return { item: feedbackDTO(item) };
    },
    decorateResult: (result, replayed) => ({ ...(result as Record<string, unknown>), replayed }),
  });
}
