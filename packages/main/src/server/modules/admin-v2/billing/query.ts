import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import {
  parseSubscriptionRefundEvidence,
  publicSubscriptionRefundDTO,
} from "@/server/modules/billing/subscription-refund";
import {
  type AdminKeysetPaging,
  CREATED_AT_DESC_KEYS,
  paginateAdminKeyset,
} from "@/server/modules/admin-v2/shared/list-cursor";
import {
  actorWithPermission,
  queryParams,
} from "@/server/modules/admin-v2/shared/authority";
import {
  CUSTOMER_METRIC_DATA_SCOPE,
  customerDreamcoinLedgerWhere,
  customerSubscriptionWhere,
} from "@/server/modules/metric-data-scope";

export async function billingLedger(request: Request) {
  await actorWithPermission(request, "billing.read");
  const query = queryParams(request, "GET /api/v2/admin/billing/ledger");
  const { search, userId, reason, limit } = query;
  const queryIdentity = { search, userId, reason };
  const where: Prisma.DreamcoinLedgerWhereInput = customerDreamcoinLedgerWhere({
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
  });
  const { items: page, pageInfo } = await paginateAdminKeyset({
    scope: "billing_ledger",
    queryIdentity,
    cursor: query.cursor,
    before: query.before,
    limit,
    keys: CREATED_AT_DESC_KEYS,
    fetch: (paging: AdminKeysetPaging<Prisma.DreamcoinLedgerOrderByWithRelationInput>) =>
      prisma.dreamcoinLedger.findMany({
        where: { AND: [where, ...paging.cursorWhere] },
        include: { user: true },
        orderBy: paging.orderBy,
        take: paging.take,
      }),
    count: () => prisma.dreamcoinLedger.count({ where }),
  });
  return {
    dataScope: CUSTOMER_METRIC_DATA_SCOPE,
    items: page.map((entry) => ({
      id: entry.id,
      userId: entry.userId,
      userEmail: entry.user.email,
      delta: entry.delta,
      balanceAfter: entry.balanceAfter,
      reason: entry.reason,
      sourceId: entry.sourceId,
      createdAt: entry.createdAt.toISOString(),
    })),
    pageInfo,
  };
}

export async function listSubscriptions(request: Request) {
  await actorWithPermission(request, "billing.read");
  const query = queryParams(request, "GET /api/v2/admin/billing/subscriptions");
  const { search, userId, status, limit } = query;
  const queryIdentity = { search, userId, status };
  const where: Prisma.SubscriptionWhereInput = customerSubscriptionWhere({
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
  });
  const { items: page, pageInfo } = await paginateAdminKeyset({
    scope: "billing_subscriptions",
    queryIdentity,
    cursor: query.cursor,
    before: query.before,
    limit,
    keys: CREATED_AT_DESC_KEYS,
    fetch: (paging: AdminKeysetPaging<Prisma.SubscriptionOrderByWithRelationInput>) =>
      prisma.subscription.findMany({
        where: { AND: [where, ...paging.cursorWhere] },
        include: { plan: true, user: true },
        orderBy: paging.orderBy,
        take: paging.take,
      }),
    count: () => prisma.subscription.count({ where }),
  });
  const checkoutKeys = page.flatMap((subscription) =>
    subscription.providerSubscriptionId
      ? [{
          provider: subscription.provider,
          providerSessionId: subscription.providerSubscriptionId,
        }]
      : [],
  );
  const checkouts = checkoutKeys.length
    ? await prisma.checkoutSession.findMany({
        where: { OR: checkoutKeys },
      })
    : [];
  const checkoutByProviderIdentity = new Map(
    checkouts.map((checkout) => [
      `${checkout.provider}:${checkout.providerSessionId ?? ""}`,
      checkout,
    ]),
  );
  return {
    dataScope: CUSTOMER_METRIC_DATA_SCOPE,
    items: page.map((subscription) => {
      const checkout = subscription.providerSubscriptionId
        ? checkoutByProviderIdentity.get(
            `${subscription.provider}:${subscription.providerSubscriptionId}`,
          )
        : undefined;
      const refund = checkout
        ? parseSubscriptionRefundEvidence(checkout.reconciliationEvidence)
        : null;
      return {
        id: subscription.id,
        userId: subscription.userId,
        userEmail: subscription.user.email,
        plan: subscription.plan.slug,
        billingPeriod: subscription.plan.billingPeriod,
        includedDreamcoins: subscription.plan.includedDreamcoins,
        provider: subscription.provider,
        status: subscription.status,
        currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        providerSubscriptionId: subscription.providerSubscriptionId,
        checkoutId: checkout?.id ?? null,
        amountCents: checkout?.amountCents ?? null,
        currency: checkout?.currency ?? null,
        refund: refund ? publicSubscriptionRefundDTO(refund) : null,
        canRefund: Boolean(
          subscription.status === "active" &&
          checkout?.status === "completed" &&
          checkout.providerInvoiceStatus === "settled" &&
          (!refund || refund.state === "canceled"),
        ),
        createdAt: subscription.createdAt.toISOString(),
      };
    }),
    pageInfo,
  };
}

export async function billingReconciliation(request: Request) {
  await actorWithPermission(request, "billing.read");
  const query = queryParams(request, "GET /api/v2/admin/billing/reconciliation");
  const now = new Date();
  const to = query.to ? new Date(query.to) : now;
  const from = query.from ? new Date(query.from) : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  if (from > to) throw Errors.badRequest("Reconciliation start must not be after end");
  const [grouped, activeSubscriptions, checkoutExceptions] = await Promise.all([
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
    prisma.checkoutSession.findMany({
      where: {
        user: {
          is: {
            dataClass: "customer",
            status: "active",
            deletedAt: null,
          },
        },
        OR: [
          { needsReconciliation: true },
          { status: "provider_unknown" },
          {
            failureCode: {
              in: [
                "provider_invoice_not_found_after_grace",
                "provider_invoice_settled_after_abandonment",
              ],
            },
          },
        ],
      },
      include: { plan: true, user: true },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: 100,
    }),
  ]);
  const byReason = grouped
    .map((row) => ({ reason: row.reason, totalDelta: row._sum.delta ?? 0, count: row._count._all }))
    .sort((a, b) => a.reason.localeCompare(b.reason));
  const totals = byReason.reduce(
    (acc, row) => ({ net: acc.net + row.totalDelta, entries: acc.entries + row.count }),
    { net: 0, entries: 0 },
  );
  return {
    dataScope: CUSTOMER_METRIC_DATA_SCOPE,
    window: { from: from.toISOString(), to: to.toISOString() },
    activeSubscriptions,
    checkoutExceptions: checkoutExceptions.map((checkout) => ({
      id: checkout.id,
      userId: checkout.userId,
      userEmail: checkout.user.email,
      plan: checkout.plan?.slug ?? null,
      billingPeriod: checkout.plan?.billingPeriod ?? null,
      provider: checkout.provider,
      providerSessionId: checkout.providerSessionId,
      providerInvoiceStatus: checkout.providerInvoiceStatus,
      providerInvoiceAdditionalStatus: checkout.providerInvoiceAdditionalStatus,
      status: checkout.status,
      failureCode: checkout.failureCode,
      needsReconciliation: checkout.needsReconciliation,
      providerLookupMissCount: checkout.providerLookupMissCount,
      providerAttemptedAt: checkout.providerAttemptedAt?.toISOString() ?? null,
      providerLastLookupAt: checkout.providerLastLookupAt?.toISOString() ?? null,
      createdAt: checkout.createdAt.toISOString(),
      updatedAt: checkout.updatedAt.toISOString(),
    })),
    byReason,
    totals,
  };
}

