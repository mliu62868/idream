// SPEC: 订阅生命周期与权益投影 —— 一个已付款的 checkout 变成生效订阅、被更新的订阅
// 变成用户手上的 entitlement、以及这两者对外的公开投影。
//
// INTENT: 它是 billing-checkout.ts 的邻居而非它的一部分。checkout 负责"收钱"
// （下单、发票、provider 对账、webhook）；这里负责"发货"（谁现在有什么权益、
// 到哪天为止、被谁取代）。两件事的失败模式不同：收钱错了是少收/多收，发货错了是
// 用户付了钱没权益或没付钱有权益。分开是为了让第二类不变量有一个固定的阅读位置。
//
// INVARIANT: 支付重放只按 provider 发票（provider + providerSubscriptionId）判定，
// 绝不按"同一个计划"判定 —— 两张已结算的发票是两笔购买，按计划去重会静默吞掉一笔。
//
// INVARIANT: provider 的送达顺序不可信。谁是"当前那笔购买"由 durable checkout intent
// 的 createdAt（id 为并列时的稳定 tiebreaker）决定，不由到达顺序决定；拿不到完整
// purchase-order 证据时返回 reconciliationRequired，不猜。
//
// INTENT: 订阅域只依赖 JSON、权益可用性和事件记录等具名模块；路由分发文件不再
// 反向提供域助手，因此生命周期可以独立测试，也不会与 service 形成循环依赖。
import { Prisma, type CheckoutSession, type Plan, type Subscription } from "@prisma/client";
import { z } from "zod";
import { METRIC_PRODUCT_EVENTS } from "@idream/shared/contracts";
import { billingPeriodEnd } from "@/lib/billing-period";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { toInputJson } from "@/server/lib/request-json";
import { appendCanonicalMetricEvent } from "@/server/modules/admin-v2/metrics/event-writer";
import { postDreamcoinEntry } from "@/server/modules/billing/ledger";
import { paymentProviderCapabilities } from "@/server/providers/payment/capabilities";
import {
  publicFeatureProjection,
  publicOfferAvailability,
} from "./offer-availability";

type JsonRecord = Record<string, Prisma.JsonValue>;

export async function lockUserLedger(
  tx: Prisma.TransactionClient,
  userId: string,
) {
  await tx.$queryRaw`SELECT id FROM "users" WHERE id = ${userId} FOR UPDATE`;
}

export const checkoutSchema = z.object({
  planId: z.string().optional(),
  slug: z.enum(["premium", "deluxe"]).optional(),
  billingPeriod: z.enum(["monthly", "yearly"]).default("monthly"),
  returnPath: z
    .string()
    .max(240)
    .refine((value) => value.startsWith("/") && !value.startsWith("//"), {
      message: "returnPath must be an internal path",
    })
    .default("/profile"),
  autoConfirm: z.boolean().default(true),
});

export const checkoutOfferSnapshotSchema = z.object({
  version: z.literal(1),
  planId: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
  billingPeriod: z.enum(["monthly", "yearly"]),
  priceCents: z.number().int().nonnegative(),
  currency: z.string().min(1),
  includedDreamcoins: z.number().int().nonnegative(),
  features: z.record(z.string(), z.unknown()),
});

// Reads and recovery share the purchased offer. Entitlement rows are a cache,
// except explicit non-subscription grants and pre-checkout legacy records.
export async function entitlementMap(
  userId: string,
  db: Prisma.TransactionClient | typeof prisma = prisma,
  now = new Date(),
) {
  return (await entitlementMaps([userId], db, now)).get(userId)!;
}

// Admin lists and aggregate counts need the same authority as single-user
// admission. Batch the underlying facts instead of introducing an N+1 reader
// or a second SQL interpretation of purchased features.
export async function entitlementMaps(
  userIds: readonly string[],
  db: Prisma.TransactionClient | typeof prisma = prisma,
  now = new Date(),
) {
  const maps = new Map(userIds.map((userId) => [userId, {} as Record<string, Prisma.JsonValue>]));
  if (userIds.length === 0) return maps;
  // A TransactionClient owns one pg connection; all reads stay serial.
  const entitlements = await db.entitlement.findMany({
    where: { userId: { in: [...userIds] }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
  });
  const subscriptions = await db.subscription.findMany({
    where: { userId: { in: [...userIds] } },
    orderBy: [{ currentPeriodEnd: "desc" }, { createdAt: "desc" }],
  });
  const subscriptionUsers = new Set(subscriptions.map((subscription) => subscription.userId));
  const active = subscriptions.filter((subscription) => subscription.status === "active" &&
    (!subscription.currentPeriodEnd || subscription.currentPeriodEnd > now));
  const invoiceBindings = active.flatMap((subscription) => subscription.providerSubscriptionId
    ? [{ provider: subscription.provider, providerSessionId: subscription.providerSubscriptionId }] : []);
  const checkouts = invoiceBindings.length > 0
    ? await db.checkoutSession.findMany({ where: { OR: invoiceBindings } }) : [];
  const invoiceKey = (provider: string, invoiceId: string | null) => JSON.stringify([provider, invoiceId]);
  const checkoutByInvoice = new Map(checkouts.map((checkout) => [invoiceKey(checkout.provider, checkout.providerSessionId), checkout]));
  const purchasedOffers = new Map(active.map((subscription) => [subscription.id,
    purchasedSubscriptionOffer(subscription, checkoutByInvoice.get(invoiceKey(subscription.provider, subscription.providerSubscriptionId)) ?? null),
  ]));
  const legacyPlanIds = [...new Set(active.filter((subscription) => !purchasedOffers.get(subscription.id)).map((subscription) => subscription.planId))];
  const legacyPlans = legacyPlanIds.length > 0
    ? await db.plan.findMany({ where: { id: { in: legacyPlanIds } } }) : [];
  const legacyPlanById = new Map(legacyPlans.map((plan) => [plan.id, plan]));

  for (const subscription of active) {
    const map = maps.get(subscription.userId)!;
    const offer = purchasedOffers.get(subscription.id) ?? legacySubscriptionOffer(legacyPlanById.get(subscription.planId));
    if (map.plan === undefined) {
      map.plan = {
        slug: offer.slug,
        billingPeriod: offer.billingPeriod,
      };
    }
    mergeDerivedEntitlement(map, "premium_controls", true);
    for (const [key, value] of Object.entries(offer.features as JsonRecord)) {
      mergeDerivedEntitlement(map, featureKey(key), value ?? false);
    }
  }

  for (const entitlement of entitlements) {
    // A subscription cache must not resurrect refunded/expired access or
    // override a purchased snapshot. Entitlement-only legacy grants predate
    // durable checkout records and retain their existing expiry semantics.
    if (entitlement.source !== "subscription" || !subscriptionUsers.has(entitlement.userId)) {
      maps.get(entitlement.userId)![entitlement.key] = entitlement.value;
    }
  }
  return maps;
}

type SubscriptionOfferBinding = Pick<Subscription, "userId" | "planId" | "provider" | "providerSubscriptionId">;
type PurchasedOfferCheckout = Pick<CheckoutSession, "userId" | "planId" | "offerSnapshot" | "amountCents" | "currency">;

export async function resolveSubscriptionOfferAuthority(
  db: Prisma.TransactionClient | typeof prisma,
  subscription: SubscriptionOfferBinding,
) {
  const checkout = subscription.providerSubscriptionId
    ? await db.checkoutSession.findUnique({ where: {
        provider_providerSessionId: { provider: subscription.provider, providerSessionId: subscription.providerSubscriptionId },
      } })
    : null;
  const purchased = purchasedSubscriptionOffer(subscription, checkout);
  if (purchased) return { authority: "checkout_snapshot" as const, offer: purchased };
  const plan = await db.plan.findUniqueOrThrow({ where: { id: subscription.planId } });
  return { authority: "legacy_plan" as const, offer: legacySubscriptionOffer(plan) };
}

function purchasedSubscriptionOffer(subscription: SubscriptionOfferBinding, checkout: PurchasedOfferCheckout | null) {
  if (checkout && (checkout.userId !== subscription.userId || checkout.planId !== subscription.planId)) {
    throw Errors.conflict("Purchased offer does not belong to this subscription");
  }
  if (checkout?.offerSnapshot !== null && checkout?.offerSnapshot !== undefined) {
    const parsed = checkoutOfferSnapshotSchema.safeParse(checkout.offerSnapshot);
    if (!parsed.success || parsed.data.planId !== subscription.planId ||
      parsed.data.priceCents !== checkout.amountCents ||
      parsed.data.currency.toLowerCase() !== checkout.currency?.toLowerCase()) {
      throw Errors.conflict("Purchased offer authority is invalid; reconciliation is required");
    }
    return parsed.data;
  }
  return null;
}

function legacySubscriptionOffer(plan: Plan | undefined) {
  // Legacy subscriptions without a stored offer used the referenced Plan.
  // Keep that identified compatibility case; malformed snapshots never fall
  // through to mutable Plan data.
  if (!plan) throw Errors.conflict("Legacy subscription plan is unavailable; reconciliation is required");
  return checkoutOfferSnapshotSchema.parse({
    version: 1, planId: plan.id, slug: plan.slug, name: plan.name,
    billingPeriod: plan.billingPeriod, priceCents: plan.priceCents, currency: plan.currency,
    includedDreamcoins: plan.includedDreamcoins, features: plan.features ?? {},
  });
}

type PublicSubscriptionSource = {
  id: string;
  userId: string;
  planId: string;
  provider: string;
  providerSubscriptionId: string | null;
  status: string;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
};

export async function publicSubscriptionDTO(subscription: PublicSubscriptionSource) {
  const authority = await resolveSubscriptionOfferAuthority(prisma, subscription);
  const authoritativeOffer = authority.authority === "checkout_snapshot" ? authority.offer : null;
  const availability = authoritativeOffer
    ? await publicOfferAvailability()
    : null;
  return {
    id: subscription.id,
    userId: subscription.userId,
    planId: subscription.planId,
    status: subscription.status,
    offerAuthority: authoritativeOffer
      ? "checkout_snapshot"
      : "unavailable",
    plan: authoritativeOffer
      ? {
          id: authoritativeOffer.planId,
          slug: authoritativeOffer.slug,
          name: authoritativeOffer.name,
          billingPeriod: authoritativeOffer.billingPeriod,
          priceCents: authoritativeOffer.priceCents,
          includedDreamcoins: authoritativeOffer.includedDreamcoins,
          features: publicFeatureProjection(
            authoritativeOffer.features,
            availability ?? { videoGeneration: false },
          ),
        }
      : null,
  };
}

export function billingAccessDTO(subscription: PublicSubscriptionSource) {
  const capabilities = paymentProviderCapabilities(subscription.provider);
  const benefitsEndAt =
    subscription.currentPeriodEnd?.toISOString() ?? null;
  return {
    provider: subscription.provider,
    ...capabilities,
    benefitsEndAt,
    renewsAt:
      capabilities.billingModel === "recurring" &&
      !subscription.cancelAtPeriodEnd
        ? benefitsEndAt
        : null,
  };
}

export function assertRenewalMutationSupported(
  subscription: Pick<PublicSubscriptionSource, "provider">,
) {
  const capabilities = paymentProviderCapabilities(subscription.provider);
  if (capabilities.renewalCapability === "cancel_resume") return;
  throw Errors.conflict(
    capabilities.billingModel === "prepaid_period"
      ? "This access is prepaid and does not renew automatically."
      : "Renewal changes are not supported for this billing provider.",
    {
      code: "renewal_not_supported",
      ...capabilities,
    },
  );
}

export async function assertNoActiveSamePlanAccessInTx(
  tx: Prisma.TransactionClient,
  userId: string,
  planId: string,
  now: Date,
) {
  await expireEndedSubscriptionsInTx(tx, userId, now);
  const activeSamePlan = await tx.subscription.findFirst({
    where: {
      ...activeSubscriptionWhere(userId, now),
      planId,
    },
    orderBy: [{ currentPeriodEnd: "desc" }, { createdAt: "desc" }],
  });
  if (!activeSamePlan) return;

  const capabilities = paymentProviderCapabilities(activeSamePlan.provider);
  throw Errors.conflict(
    capabilities.billingModel === "prepaid_period"
      ? "This prepaid plan is already active. Buy it again after the current access period ends."
      : "This plan is already active.",
    {
      code: "active_prepaid_access_exists",
      idempotencyAction: "new_key",
      billingModel: capabilities.billingModel,
      renewalCapability: capabilities.renewalCapability,
      benefitsEndAt: activeSamePlan.currentPeriodEnd?.toISOString() ?? null,
    },
  );
}

export async function pendingSubscriptionRefundInTx(
  tx: Prisma.TransactionClient,
  userId: string,
) {
  return tx.subscription.findFirst({
    where: { userId, status: "refund_pending" },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    select: { id: true },
  });
}

export async function assertNoSubscriptionRefundPendingInTx(
  tx: Prisma.TransactionClient,
  userId: string,
) {
  const pending = await pendingSubscriptionRefundInTx(tx, userId);
  if (!pending) return;
  throw Errors.conflict(
    "A subscription refund is still pending. Wait for it to complete or be canceled before starting another checkout.",
    {
      reason: "subscription_refund_pending",
      subscriptionId: pending.id,
      idempotencyAction: "new_key",
    },
  );
}

export async function activeSamePlanProviderDispatchInTx(
  tx: Prisma.TransactionClient,
  userId: string,
  planId: string,
  excludedCheckoutId: string,
  now: Date,
) {
  return tx.checkoutSession.findFirst({
    where: {
      id: { not: excludedCheckoutId },
      userId,
      planId,
      status: "provider_dispatching",
      providerSessionId: null,
      providerAttemptedAt: { not: null },
      dispatchToken: { not: null },
      dispatchLeaseUntil: { gt: now },
    },
    select: {
      id: true,
      dispatchLeaseUntil: true,
    },
  });
}

async function expireEndedSubscriptionsInTx(
  tx: Prisma.TransactionClient,
  userId: string,
  now: Date,
) {
  const ended = await tx.subscription.findMany({
    where: {
      userId,
      status: "active",
      currentPeriodEnd: { lte: now },
    },
    select: { id: true, userId: true },
  });
  if (ended.length === 0) return;

  const endedIds = ended.map((subscription) => subscription.id);
  await tx.subscription.updateMany({
    where: {
      id: { in: endedIds },
      status: "active",
      currentPeriodEnd: { lte: now },
    },
    data: {
      status: "expired",
      cancelAtPeriodEnd: false,
    },
  });
  await tx.entitlement.deleteMany({
    where: {
      userId,
      source: "subscription",
      expiresAt: { lte: now },
    },
  });
  for (const subscription of ended) {
    await appendCanonicalMetricEvent(tx, {
      sourceEventId: `subscription:${subscription.id}:ended:period_expired`,
      eventType: METRIC_PRODUCT_EVENTS.subscriptionEnded,
      occurredAt: now,
      userId: subscription.userId,
      context: { source: "checkout_expiry_reconciliation" },
      payload: {
        subscriptionId: subscription.id,
        userId: subscription.userId,
        reason: "period_expired",
      },
    });
  }
}

export function activeSubscriptionWhere(userId: string, now = new Date()): Prisma.SubscriptionWhereInput {
  return {
    userId,
    status: "active",
    OR: [{ currentPeriodEnd: null }, { currentPeriodEnd: { gt: now } }],
  };
}

function mergeDerivedEntitlement(
  map: Record<string, Prisma.JsonValue>,
  key: string,
  value: Prisma.JsonValue,
) {
  const current = map[key];
  if (current === undefined) {
    map[key] = value;
    return;
  }
  if (typeof current === "boolean" && typeof value === "boolean") {
    map[key] = current || value;
    return;
  }
  if (typeof current === "number" && typeof value === "number") {
    map[key] = Math.max(current, value);
  }
}

export async function findPlan(input: z.infer<typeof checkoutSchema>) {
  const plan = input.planId
    ? await prisma.plan.findUnique({ where: { id: input.planId } })
    : await prisma.plan.findUnique({
        where: {
          slug_billingPeriod: {
            slug: input.slug ?? "premium",
            billingPeriod: input.billingPeriod,
          },
        },
      });
  if (!plan || !plan.active) throw Errors.notFound("Plan not found");
  return plan;
}

export async function activateSubscriptionInTx(
  tx: Prisma.TransactionClient,
  userId: string,
  planId: string,
  providerSubscriptionId: string,
  provider: string,
  offerSnapshot: z.infer<typeof checkoutOfferSnapshotSchema>,
  purchaseAuthority: {
    checkoutId: string;
    createdAt: Date;
  },
) {
  if (offerSnapshot.planId !== planId) {
    throw Errors.conflict("Checkout offer snapshot does not match its plan");
  }
  const entitlementPlan = {
    slug: offerSnapshot.slug,
    billingPeriod: offerSnapshot.billingPeriod,
    features: offerSnapshot.features as Prisma.JsonValue,
  };
  const includedDreamcoins = offerSnapshot.includedDreamcoins;
  // A payment replay is identified by the provider invoice, never merely by plan.
  // Distinct settled invoices are distinct purchases and must not be silently
  // discarded as a same-plan replay.
  await lockUserLedger(tx, userId);
  const pendingRefund = await pendingSubscriptionRefundInTx(tx, userId);
  if (pendingRefund) {
    return {
      subscription: null,
      created: false,
      reconciliationRequired: true,
      reconciliationReason: "subscription_refund_pending",
      settlementDeferred: false,
    } as const;
  }
  const competingDispatch = await activeSamePlanProviderDispatchInTx(
    tx,
    userId,
    planId,
    purchaseAuthority.checkoutId,
    new Date(),
  );
  if (competingDispatch) {
    return {
      subscription: null,
      created: false,
      reconciliationRequired: false,
      settlementDeferred: true,
      deferredByCheckoutId: competingDispatch.id,
    } as const;
  }
  const replay = await tx.subscription.findFirst({
    where: {
      provider,
      providerSubscriptionId,
    },
  });
  if (replay) {
    if (replay.userId !== userId || replay.planId !== planId) {
      throw Errors.conflict(
        "The provider invoice is already bound to different billing authority.",
        { provider, providerSubscriptionId },
      );
    }
    if (replay.status === "active") {
      await syncSubscriptionEntitlements(
        tx,
        userId,
        entitlementPlan,
        replay.currentPeriodEnd,
      );
    }
    return {
      subscription: replay,
      created: false,
      reconciliationRequired: false,
      settlementDeferred: false,
    } as const;
  }

  const now = new Date();
  await expireEndedSubscriptionsInTx(tx, userId, now);
  const superseded = await tx.subscription.findMany({
    where: activeSubscriptionWhere(userId, now),
    select: {
      id: true,
      userId: true,
      planId: true,
      provider: true,
      providerSubscriptionId: true,
      currentPeriodEnd: true,
    },
  });
  const activePurchaseAuthority = await resolveActivePurchaseOrderAuthority(
    tx,
    superseded,
    purchaseAuthority,
  );
  if (activePurchaseAuthority.kind === "unavailable") {
    return {
      subscription: null,
      created: false,
      reconciliationRequired: true,
      reconciliationReason: "active_purchase_authority_unavailable",
      settlementDeferred: false,
    } as const;
  }
  const billingPeriod = offerSnapshot.billingPeriod;
  if (billingPeriod !== "monthly" && billingPeriod !== "yearly") {
    throw Errors.conflict("Plan billing period is not supported");
  }

  if (activePurchaseAuthority.kind === "newer") {
    const newerAccess = activePurchaseAuthority.subscription;
    const convertedAccess = convertedPrepaidAccessEnd({
      currentOffer: offerSnapshot,
      newerOffer: activePurchaseAuthority.offerSnapshot,
      newerAccessEnd: newerAccess.currentPeriodEnd,
      now,
    });
    if (!convertedAccess.ok) {
      return {
        subscription: null,
        created: false,
        reconciliationRequired: true,
        reconciliationReason: "prepaid_value_conversion_unavailable",
        settlementDeferred: false,
      } as const;
    }
    const extendedEnd = convertedAccess.currentPeriodEnd;
    const preserved = await tx.subscription.update({
      where: { id: newerAccess.id },
      data: { currentPeriodEnd: extendedEnd },
    });
    await tx.entitlement.updateMany({
      where: { userId, source: "subscription" },
      data: { expiresAt: extendedEnd },
    });
    const appliedPurchase = await tx.subscription.create({
      data: {
        userId,
        planId,
        provider,
        providerSubscriptionId,
        status: "checkout_completed",
        currentPeriodEnd: extendedEnd,
      },
    });
    await postDreamcoinEntry(tx, {
      kind: "subscription_grant",
      userId,
      amount: includedDreamcoins,
      sourceId: appliedPurchase.id,
      idempotencyKey: `subscription:grant:${provider}:${providerSubscriptionId}`,
    });
    await appendCanonicalMetricEvent(tx, {
      sourceEventId: `subscription:${appliedPurchase.id}:activated`,
      eventType: METRIC_PRODUCT_EVENTS.subscriptionActivated,
      occurredAt: appliedPurchase.createdAt,
      userId,
      context: {
        providerSubscriptionId,
        source: "late_purchase_applied_to_newer_access",
        activeSubscriptionId: preserved.id,
      },
      payload: {
        subscriptionId: appliedPurchase.id,
        userId,
        planId,
      },
    });
    return {
      subscription: preserved,
      created: true,
      reconciliationRequired: false,
      settlementDeferred: false,
    } as const;
  }

  const samePlanAccess = superseded.find(
    (subscription) => subscription.planId === planId,
  );
  const supersededCount = await tx.subscription.updateMany({
    where: activeSubscriptionWhere(userId, now),
    data: { status: "canceled", cancelAtPeriodEnd: false },
  });
  if (supersededCount.count > 0) {
    await tx.entitlement.deleteMany({ where: { userId, source: "subscription" } });
    for (const previous of superseded) {
      const samePlanPurchase = previous.planId === planId;
      await appendCanonicalMetricEvent(tx, {
        sourceEventId: `subscription:${previous.id}:ended:${providerSubscriptionId}`,
        eventType: METRIC_PRODUCT_EVENTS.subscriptionEnded,
        occurredAt: now,
        userId: previous.userId,
        context: {
          source: samePlanPurchase
            ? "new_prepaid_period"
            : "plan_switch",
        },
        payload: {
          subscriptionId: previous.id,
          userId: previous.userId,
          reason: samePlanPurchase
            ? "superseded_by_new_prepaid_period"
            : "superseded_by_plan_switch",
        },
      });
    }
  }
  const periodStartsAt =
    samePlanAccess?.currentPeriodEnd &&
    samePlanAccess.currentPeriodEnd > now
      ? samePlanAccess.currentPeriodEnd
      : now;
  const currentPeriodEnd = billingPeriodEnd(periodStartsAt, billingPeriod);
  const subscription = await tx.subscription.create({
    data: {
      userId,
      planId,
      provider,
      providerSubscriptionId,
      status: "active",
      currentPeriodEnd,
    },
  });
  await syncSubscriptionEntitlements(tx, userId, entitlementPlan, currentPeriodEnd);
  await postDreamcoinEntry(tx, {
    kind: "subscription_grant",
    userId,
    amount: includedDreamcoins,
    sourceId: subscription.id,
    idempotencyKey: `subscription:grant:${provider}:${providerSubscriptionId}`,
  });
  await appendCanonicalMetricEvent(tx, {
    sourceEventId: `subscription:${subscription.id}:activated`,
    eventType: METRIC_PRODUCT_EVENTS.subscriptionActivated,
    occurredAt: subscription.createdAt,
    userId,
    context: { providerSubscriptionId },
    payload: { subscriptionId: subscription.id, userId, planId },
  });
  return {
    subscription,
    created: true,
    reconciliationRequired: false,
    settlementDeferred: false,
  } as const;
}

async function resolveActivePurchaseOrderAuthority(
  tx: Prisma.TransactionClient,
  activeSubscriptions: readonly {
    id: string;
    userId: string;
    planId: string;
    provider: string;
    providerSubscriptionId: string | null;
    currentPeriodEnd: Date | null;
  }[],
  currentPurchase: {
    checkoutId: string;
    createdAt: Date;
  },
) {
  // Provider delivery order is nondeterministic. The durable checkout intent is
  // the purchase-order authority: createdAt orders intents, with id as the
  // stable tie-breaker for the rare equal-timestamp case.
  if (activeSubscriptions.length === 0) return { kind: "none" } as const;
  const providerPurchases = activeSubscriptions.filter(
    (
      subscription,
    ): subscription is typeof subscription & {
      providerSubscriptionId: string;
    } => subscription.providerSubscriptionId !== null,
  );
  if (providerPurchases.length !== activeSubscriptions.length) {
    return { kind: "unavailable" } as const;
  }

  const checkoutAuthorities = await tx.checkoutSession.findMany({
    where: {
      OR: providerPurchases.map((subscription) => ({
        provider: subscription.provider,
        providerSessionId: subscription.providerSubscriptionId,
      })),
    },
    select: {
      id: true,
      provider: true,
      providerSessionId: true,
      createdAt: true,
      userId: true,
      planId: true,
      amountCents: true,
      currency: true,
      offerSnapshot: true,
      status: true,
    },
  });
  const checkoutByProviderInvoice = new Map(
    checkoutAuthorities.map((checkout) => [
      `${checkout.provider}:${checkout.providerSessionId ?? ""}`,
      checkout,
    ]),
  );
  const authorities = [];
  for (const subscription of providerPurchases) {
    const checkout = checkoutByProviderInvoice.get(
      `${subscription.provider}:${subscription.providerSubscriptionId}`,
    );
    const offerSnapshot = checkoutOfferSnapshotSchema.safeParse(
      checkout?.offerSnapshot,
    );
    if (
      !checkout ||
      checkout.userId !== subscription.userId ||
      checkout.planId !== subscription.planId ||
      checkout.status !== "completed" ||
      !offerSnapshot.success ||
      offerSnapshot.data.planId !== subscription.planId ||
      checkout.amountCents !== offerSnapshot.data.priceCents ||
      checkout.currency?.toLowerCase() !==
        offerSnapshot.data.currency.toLowerCase()
    ) {
      return { kind: "unavailable" } as const;
    }
    authorities.push({
      subscription,
      checkout,
      offerSnapshot: offerSnapshot.data,
    });
  }

  const newer = authorities
    .filter(
      (candidate) =>
        compareCheckoutPurchaseOrder(candidate.checkout, currentPurchase) > 0,
    )
    .sort((left, right) =>
      compareCheckoutPurchaseOrder(right.checkout, left.checkout),
    )[0];
  return newer
    ? {
        kind: "newer",
        subscription: newer.subscription,
        offerSnapshot: newer.offerSnapshot,
      } as const
    : { kind: "none" } as const;
}

function convertedPrepaidAccessEnd(input: {
  currentOffer: z.infer<typeof checkoutOfferSnapshotSchema>;
  newerOffer: z.infer<typeof checkoutOfferSnapshotSchema>;
  newerAccessEnd: Date | null;
  now: Date;
}) {
  if (
    input.currentOffer.priceCents <= 0 ||
    input.newerOffer.priceCents <= 0 ||
    input.currentOffer.currency.toLowerCase() !==
      input.newerOffer.currency.toLowerCase()
  ) {
    return { ok: false } as const;
  }
  if (input.newerAccessEnd === null) {
    return { ok: true, currentPeriodEnd: null } as const;
  }

  const startsAt =
    input.newerAccessEnd > input.now ? input.newerAccessEnd : input.now;
  const newerUnitEnd = billingPeriodEnd(
    startsAt,
    input.newerOffer.billingPeriod,
  );
  const newerUnitDurationMs =
    newerUnitEnd.getTime() - startsAt.getTime();
  const convertedDurationMs = Math.max(
    1,
    Math.floor(
      newerUnitDurationMs *
        (input.currentOffer.priceCents / input.newerOffer.priceCents),
    ),
  );
  const convertedEndMs = startsAt.getTime() + convertedDurationMs;
  if (
    !Number.isSafeInteger(convertedDurationMs) ||
    !Number.isFinite(convertedEndMs)
  ) {
    return { ok: false } as const;
  }
  return {
    ok: true,
    currentPeriodEnd: new Date(convertedEndMs),
  } as const;
}

function compareCheckoutPurchaseOrder(
  left: { id: string; createdAt: Date },
  right: { checkoutId?: string; id?: string; createdAt: Date },
) {
  const createdAtDelta = left.createdAt.getTime() - right.createdAt.getTime();
  if (createdAtDelta !== 0) return createdAtDelta;
  return left.id.localeCompare(right.checkoutId ?? right.id ?? "");
}

export async function syncSubscriptionEntitlements(
  tx: Prisma.TransactionClient,
  userId: string,
  plan: {
    slug: string;
    billingPeriod: string;
    features: Prisma.JsonValue;
  },
  expiresAt: Date | null,
) {
  const independentGrants = new Set((await tx.entitlement.findMany({
    where: { userId, source: { not: "subscription" } }, select: { key: true },
  })).map((row) => row.key));
  await tx.entitlement.deleteMany({ where: { userId, source: "subscription" } });
  if (!independentGrants.has("plan")) {
    await tx.entitlement.upsert({
      where: { userId_key: { userId, key: "plan" } },
      update: { value: { slug: plan.slug, billingPeriod: plan.billingPeriod }, source: "subscription", expiresAt },
      create: { userId, key: "plan", value: { slug: plan.slug, billingPeriod: plan.billingPeriod }, source: "subscription", expiresAt },
    });
  }
  const featureEntries = Object.entries(plan.features as JsonRecord);
  for (const [key, value] of featureEntries) {
    if (independentGrants.has(featureKey(key))) continue;
    const entitlementValue = toInputJson(value ?? false);
    await tx.entitlement.upsert({
      where: { userId_key: { userId, key: featureKey(key) } },
      update: { value: entitlementValue, source: "subscription", expiresAt },
      create: { userId, key: featureKey(key), value: entitlementValue, source: "subscription", expiresAt },
    });
  }
  if (!independentGrants.has("premium_controls")) {
    await tx.entitlement.upsert({
      where: { userId_key: { userId, key: "premium_controls" } },
      update: { value: true, source: "subscription", expiresAt },
      create: { userId, key: "premium_controls", value: true, source: "subscription", expiresAt },
    });
  }
}

function featureKey(key: string) {
  return key.replace(/[A-Z]/g, (match) => `_${match.toLowerCase()}`);
}
