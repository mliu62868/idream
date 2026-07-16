import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import { decodeAdminListCursor, encodeAdminListCursor } from "@/server/modules/admin-v2/shared/list-cursor";
import { actorWithPermission } from "@/server/modules/admin/shared/legacy-primitives";
import {
  CUSTOMER_METRIC_DATA_SCOPE,
  customerDreamcoinLedgerWhere,
  customerSubscriptionWhere,
} from "@/server/modules/admin/shared/metric-data-scope";

const ledgerQuerySchema = z.object({
  search: z.string().trim().min(1).max(200).optional(),
  userId: z.string().trim().min(1).max(160).optional(),
  reason: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().trim().min(1).optional(),
}).strict();

const subscriptionQuerySchema = z.object({
  search: z.string().trim().min(1).max(200).optional(),
  userId: z.string().trim().min(1).max(160).optional(),
  status: z.enum(["checkout_created", "checkout_completed", "active", "past_due", "canceled", "expired"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().trim().min(1).optional(),
}).strict();

const reconciliationQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
}).strict();

export async function billingLedger(request: Request) {
  await actorWithPermission(request, "billing.read");
  const query = ledgerQuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
  const { search, userId, reason, limit } = query;
  const queryIdentity = { search, userId, reason };
  const cursorKeys = query.cursor
    ? decodeAdminListCursor(query.cursor, "billing_ledger", queryIdentity)
    : undefined;
  const cursorWhere: Prisma.DreamcoinLedgerWhereInput | undefined = cursorKeys
    ? descendingCursorWhere(cursorKeys, "billing_ledger")
    : undefined;
  const entries = await prisma.dreamcoinLedger.findMany({
    where: {
      userId,
      reason,
      OR: search
        ? [
            { id: { contains: search } },
            { userId: { contains: search } },
            { sourceId: { contains: search } },
            { user: { email: { contains: search } } },
          ]
        : undefined,
      AND: cursorWhere,
    },
    include: { user: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const page = entries.slice(0, limit);
  return ok({
    items: page.map((entry) => ({
      id: entry.id,
      userId: entry.userId,
      userEmail: entry.user.email,
      delta: entry.delta,
      balanceAfter: entry.balanceAfter,
      reason: entry.reason,
      sourceId: entry.sourceId,
      createdAt: entry.createdAt,
    })),
    pageInfo: pageInfo("billing_ledger", queryIdentity, page, entries.length > limit),
  });
}

export async function listSubscriptions(request: Request) {
  await actorWithPermission(request, "billing.read");
  const query = subscriptionQuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
  const { search, userId, status, limit } = query;
  const queryIdentity = { search, userId, status };
  const cursorKeys = query.cursor
    ? decodeAdminListCursor(query.cursor, "billing_subscriptions", queryIdentity)
    : undefined;
  const cursorWhere: Prisma.SubscriptionWhereInput | undefined = cursorKeys
    ? descendingCursorWhere(cursorKeys, "billing_subscriptions")
    : undefined;
  const subscriptions = await prisma.subscription.findMany({
    where: {
      userId,
      status,
      OR: search
        ? [
            { id: { contains: search } },
            { userId: { contains: search } },
            { providerSubscriptionId: { contains: search } },
            { user: { email: { contains: search } } },
            { plan: { slug: { contains: search } } },
          ]
        : undefined,
      AND: cursorWhere,
    },
    include: { plan: true, user: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const page = subscriptions.slice(0, limit);
  return ok({
    items: page.map((subscription) => ({
      id: subscription.id,
      userId: subscription.userId,
      userEmail: subscription.user.email,
      plan: subscription.plan.slug,
      billingPeriod: subscription.plan.billingPeriod,
      provider: subscription.provider,
      status: subscription.status,
      currentPeriodEnd: subscription.currentPeriodEnd,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      providerSubscriptionId: subscription.providerSubscriptionId,
      createdAt: subscription.createdAt,
    })),
    pageInfo: pageInfo("billing_subscriptions", queryIdentity, page, subscriptions.length > limit),
  });
}

export async function billingReconciliation(request: Request) {
  await actorWithPermission(request, "billing.read");
  const query = reconciliationQuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
  const now = new Date();
  const to = query.to ? new Date(query.to) : now;
  const from = query.from ? new Date(query.from) : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  if (from > to) throw Errors.badRequest("Reconciliation start must not be after end");
  const [grouped, activeSubscriptions] = await Promise.all([
    prisma.dreamcoinLedger.groupBy({
      by: ["reason"],
      where: customerDreamcoinLedgerWhere({
        createdAt: { gte: from, lte: to },
      }),
      _sum: { delta: true },
      _count: { _all: true },
    }),
    prisma.subscription.count({
      where: customerSubscriptionWhere({ status: "active" }),
    }),
  ]);
  const byReason = grouped
    .map((row) => ({ reason: row.reason, totalDelta: row._sum.delta ?? 0, count: row._count._all }))
    .sort((a, b) => a.reason.localeCompare(b.reason));
  const totals = byReason.reduce(
    (acc, row) => ({ net: acc.net + row.totalDelta, entries: acc.entries + row.count }),
    { net: 0, entries: 0 },
  );
  return ok({
    dataScope: CUSTOMER_METRIC_DATA_SCOPE,
    window: { from: from.toISOString(), to: to.toISOString() },
    activeSubscriptions,
    byReason,
    totals,
  });
}

function descendingCursorWhere(keys: readonly unknown[], scope: string) {
  const createdAt = new Date(cursorString(keys, 0, scope));
  if (Number.isNaN(createdAt.getTime())) throw Errors.badRequest(`${scope} cursor timestamp is invalid`);
  const id = cursorString(keys, 1, scope);
  return { OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: id } }] };
}

function cursorString(keys: readonly unknown[], index: number, scope: string) {
  const value = keys[index];
  if (typeof value !== "string" || !value) throw Errors.badRequest(`${scope} cursor key is invalid`);
  return value;
}

function pageInfo<T extends { createdAt: Date; id: string }>(
  scope: string,
  queryIdentity: unknown,
  page: readonly T[],
  hasNextPage: boolean,
) {
  const last = page.at(-1);
  return {
    endCursor: hasNextPage && last
      ? encodeAdminListCursor(scope, queryIdentity, [last.createdAt.toISOString(), last.id])
      : null,
    hasNextPage,
  };
}
