import { randomUUID } from "node:crypto";
import type { AffiliateApplication, Prisma } from "@prisma/client";
import { affiliateApplicationAdminSchema, affiliateApplicationMutationResponseSchema } from "@idream/shared/admin";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { executeAtomicIdempotentMutation } from "../shared/atomic-mutation";
import { actorWithPermission, jsonBody, queryParams } from "../shared/authority";
import { requireIdempotencyKey } from "../shared/idempotency";
import { CREATED_AT_DESC_KEYS, paginateAdminKeyset } from "../shared/list-cursor";

function applicationDTO(item: AffiliateApplication) {
  return affiliateApplicationAdminSchema.parse({
    ...item,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
    reviewedAt: item.reviewedAt?.toISOString() ?? null,
  });
}

export async function listAffiliateApplications(request: Request) {
  await actorWithPermission(request, "growth.promo.read");
  const query = queryParams(request, "GET /api/v2/admin/affiliate/applications");
  // 与其它运营队列同口径：测试/审计/内部账号的申请不进审批队列。
  const where: Prisma.AffiliateApplicationWhereInput = {
    user: { is: { dataClass: "customer" } },
    ...(query.status === "all" ? {} : { status: query.status }),
    ...(query.search ? { OR: [
      { id: { contains: query.search, mode: "insensitive" } },
      { userId: { contains: query.search, mode: "insensitive" } },
    ] } : {}),
  };
  const result = await paginateAdminKeyset<AffiliateApplication, Prisma.AffiliateApplicationOrderByWithRelationInput>({
    scope: "affiliate_applications", queryIdentity: { status: query.status, search: query.search ?? "" },
    cursor: query.cursor, limit: query.limit, keys: CREATED_AT_DESC_KEYS,
    fetch: (page) => prisma.affiliateApplication.findMany({
      where: { AND: [where, ...page.cursorWhere] }, orderBy: page.orderBy, take: page.take,
    }),
  });
  return { items: result.items.map(applicationDTO), pageInfo: result.pageInfo };
}

// Approval activates the existing attribution code. It does not authorize a payout or publish commercial terms.
export async function decideAffiliateApplication(request: Request, id: string) {
  const actor = await actorWithPermission(request, "growth.promo.write");
  const body = await jsonBody(request, "POST /api/v2/admin/affiliate/applications/:id/decision");
  if (body.confirmation !== id) throw Errors.badRequest("Confirmation must match the application ID");
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  return executeAtomicIdempotentMutation({
    environment: env.APP_ENV, actor, requestId,
    idempotencyKey: requireIdempotencyKey(request),
    commandType: "affiliate.application.decide", target: { type: "affiliate_application", id }, payload: body,
    mutate: async (tx) => {
      const before = await tx.affiliateApplication.findUnique({ where: { id } });
      if (!before) throw Errors.notFound("Affiliate application not found");
      if (before.status !== "pending" || before.updatedAt.toISOString() !== body.expectedUpdatedAt) {
        throw Errors.conflict("Application has changed or was already reviewed. Refresh before deciding.");
      }
      const item = await tx.affiliateApplication.update({ where: { id }, data: {
        status: body.status, reviewNote: body.reason, reviewedAt: new Date(),
      } });
      await tx.adminAuditLog.create({ data: {
        actorId: actor.id, actorRole: actor.role, action: "affiliate.application.decide",
        targetType: "affiliate_application", targetId: id, reason: body.reason, requestId,
        before: { userId: before.userId, status: before.status, termsVersion: before.termsVersion, channels: before.channels, updatedAt: before.updatedAt.toISOString() },
        after: { status: item.status, termsVersion: item.termsVersion, reviewedAt: item.reviewedAt!.toISOString() },
      } });
      return { item: applicationDTO(item) };
    },
    decorateResult: (result, replayed) => ({ ...(result as Record<string, unknown>), replayed }),
    validateResult: (result) => affiliateApplicationMutationResponseSchema.parse(result),
  });
}
