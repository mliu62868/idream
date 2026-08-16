import { customer360Schema, customerListResponseSchema } from "@idream/shared/admin";
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import { actorWithPermission, queryParams } from "@/server/modules/admin-v2/shared/authority";
import {
  type AdminKeysetPaging,
  CREATED_AT_DESC_KEYS,
  paginateAdminKeyset,
} from "@/server/modules/admin-v2/shared/list-cursor";
import { caseDto } from "./query";

const ACTIVE_CASE_STATUSES = ["new", "triaged", "in_progress", "waiting", "reopened"];

export async function listCustomers(request: Request) {
  await actorWithPermission(request, "customer.read");
  const query = queryParams(request, "GET /api/v2/admin/customers");
  const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000);
  const where: Prisma.UserWhereInput = {
    role: "user",
    dataClass: "customer",
    ...(query.status ? { status: query.status } : {}),
    ...(query.search ? {
      OR: [
        { id: { contains: query.search, mode: "insensitive" } },
        { email: { contains: query.search, mode: "insensitive" } },
        { displayName: { contains: query.search, mode: "insensitive" } },
        { name: { contains: query.search, mode: "insensitive" } },
      ],
    } : {}),
  };
  const { items: pageRows, pageInfo } = await paginateAdminKeyset({
    scope: "customers",
    queryIdentity: { search: query.search, status: query.status },
    cursor: query.cursor,
    before: query.before,
    limit: query.limit,
    keys: CREATED_AT_DESC_KEYS,
    fetch: (paging: AdminKeysetPaging<Prisma.UserOrderByWithRelationInput>) =>
      prisma.user.findMany({
        where: { AND: [where, ...paging.cursorWhere] },
        orderBy: paging.orderBy,
        take: paging.take,
      }),
    count: () => prisma.user.count({ where }),
  });
  const customerIds = pageRows.map((row) => row.id);
  const [ledgerRows, caseCounts, failureCounts, subscriptionRows, chatActivity] = customerIds.length > 0
    ? await Promise.all([
        prisma.$queryRaw<Array<{ userId: string; balanceAfter: number }>>(Prisma.sql`
          SELECT DISTINCT ON ("userId") "userId", "balanceAfter"
          FROM dreamcoin_ledger
          WHERE "userId" IN (${Prisma.join(customerIds)})
          ORDER BY "userId", "createdAt" DESC, id DESC
        `),
        prisma.adminCase.groupBy({
          by: ["targetId"],
          where: { targetType: "user", targetId: { in: customerIds }, status: { in: ACTIVE_CASE_STATUSES } },
          _count: { _all: true },
        }),
        prisma.generationJob.groupBy({
          by: ["userId"],
          where: { userId: { in: customerIds }, status: { in: ["failed", "blocked"] }, createdAt: { gte: since30d } },
          _count: { _all: true },
        }),
        prisma.$queryRaw<Array<{ userId: string; status: string }>>(Prisma.sql`
          SELECT DISTINCT ON ("userId") "userId", status
          FROM subscriptions
          WHERE "userId" IN (${Prisma.join(customerIds)})
          ORDER BY "userId", "updatedAt" DESC, id DESC
        `),
        prisma.recentChat.groupBy({
          by: ["userId"],
          where: { userId: { in: customerIds }, status: "active" },
          _max: { lastMessageAt: true },
        }),
      ])
    : [[], [], [], [], []] as const;
  const balances = new Map(ledgerRows.map((row) => [row.userId, row.balanceAfter]));
  const cases = new Map(caseCounts.map((row) => [row.targetId, row._count._all]));
  const failures = new Map(failureCounts.map((row) => [row.userId, row._count._all]));
  const subscriptions = new Map(subscriptionRows.map((row) => [row.userId, row.status]));
  const lastActivities = new Map(chatActivity.map((row) => [row.userId, row._max.lastMessageAt]));
  const items = pageRows.map((customer) => {
    const lastActiveAt = lastActivities.get(customer.id);
    return {
      id: customer.id,
      email: customer.email,
      displayName: customer.displayName ?? customer.name,
      status: customer.status,
      createdAt: customer.createdAt.toISOString(),
      balanceDreamcoins: balances.get(customer.id) ?? 0,
      activeCaseCount: cases.get(customer.id) ?? 0,
      failedGenerationCount30d: failures.get(customer.id) ?? 0,
      subscriptionStatus: subscriptions.get(customer.id) ?? null,
      lastActiveAt: lastActiveAt?.toISOString() ?? null,
    };
  });
  const model = customerListResponseSchema.parse({
    items,
    pageInfo,
    query: { search: query.search, status: query.status, limit: query.limit, cursor: query.cursor ?? null },
    asOf: new Date().toISOString(),
    freshness: "fresh",
  });
  return ok(model, { headers: { "Cache-Control": "no-store" } });
}

export async function getCustomer360(request: Request, customerId: string) {
  const actor = await actorWithPermission(request, "customer.read");
  const customer = await prisma.user.findUnique({ where: { id: customerId } });
  if (!customer || customer.role !== "user" || customer.dataClass !== "customer") {
    throw Errors.notFound("Customer not found");
  }

  const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000);
  const [subscription, ledger, recentChats, generations, adminCases, failedGenerationCount30d] = await Promise.all([
    prisma.subscription.findFirst({
      where: { userId: customerId },
      include: { plan: true },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    }),
    prisma.dreamcoinLedger.findMany({
      where: { userId: customerId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 50,
    }),
    prisma.recentChat.findMany({
      where: { userId: customerId, status: "active" },
      include: { character: { select: { name: true } } },
      orderBy: [{ lastMessageAt: "desc" }, { sessionId: "desc" }],
      take: 20,
    }),
    prisma.generationJob.findMany({
      where: { userId: customerId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 20,
    }),
    prisma.adminCase.findMany({
      where: {
        targetType: "user",
        targetId: customerId,
        ...(actor.role === "support" ? { type: { in: ["support_request", "billing_dispute"] } } : {}),
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: 100,
    }),
    prisma.generationJob.count({
      where: { userId: customerId, status: { in: ["failed", "blocked"] }, createdAt: { gte: since30d } },
    }),
  ]);
  const caseIds = adminCases.map((item) => item.id);
  const activity = await prisma.adminAuditLog.findMany({
    where: {
      OR: [
        { targetType: "user", targetId: customerId },
        ...(caseIds.length > 0 ? [{ targetType: "admin_case", targetId: { in: caseIds } }] : []),
      ],
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 50,
  });
  const cases = await Promise.all(adminCases.map(caseDto));
  const lastActiveAt = recentChats.find((item) => item.lastMessageAt)?.lastMessageAt ?? null;
  const model = customer360Schema.parse({
    customer: {
      id: customer.id,
      email: customer.email,
      displayName: customer.displayName ?? customer.name,
      status: customer.status,
      createdAt: customer.createdAt.toISOString(),
    },
    overview: {
      balanceDreamcoins: ledger[0]?.balanceAfter ?? 0,
      activeCaseCount: adminCases.filter((item) => ACTIVE_CASE_STATUSES.includes(item.status)).length,
      failedGenerationCount30d,
      lastActiveAt: lastActiveAt?.toISOString() ?? null,
    },
    subscription: subscription
      ? {
          id: subscription.id,
          status: subscription.status,
          currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
          plan: {
            id: subscription.plan.id,
            name: subscription.plan.name,
            billingPeriod: subscription.plan.billingPeriod,
          },
        }
      : null,
    relationships: recentChats.map((item) => ({
      characterId: item.characterId,
      characterName: item.character.name,
      sessionId: item.sessionId,
      lastMessageAt: item.lastMessageAt?.toISOString() ?? null,
    })),
    generations: generations.map((item) => ({
      id: item.id,
      mode: item.mode,
      status: item.status,
      costDreamcoins: item.costDreamcoins,
      createdAt: item.createdAt.toISOString(),
    })),
    ledger: ledger.map((item) => ({
      id: item.id,
      delta: item.delta,
      balanceAfter: item.balanceAfter,
      reason: item.reason,
      sourceId: item.sourceId,
      createdAt: item.createdAt.toISOString(),
    })),
    cases,
    activity: activity.map((item) => ({
      id: item.id,
      action: item.action,
      targetType: item.targetType,
      targetId: item.targetId,
      createdAt: item.createdAt.toISOString(),
    })),
    asOf: new Date().toISOString(),
  });
  return ok(model, { headers: { "Cache-Control": "no-store" } });
}
