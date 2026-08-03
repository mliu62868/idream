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
// NOTE: 反向 import ./service 的四个符号（lockUserLedger / toInputJson /
// publicOfferAvailability / publicFeatureProjection）与 billing-checkout.ts 同理：
// mega-module 形态是既定决策，这里只搬走自成体系的订阅域，不去拆共用助手。
// publicOfferAvailability 留在 service 是因为它依赖那边的 generation profile/recipe
// 可执行性判定，搬过来要一起拖走三个不相干的 helper。
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { METRIC_PRODUCT_EVENTS } from "@idream/shared/contracts";
import { billingPeriodEnd } from "@/lib/billing-period";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { appendCanonicalMetricEvent } from "@/server/modules/admin-v2/metrics/event-writer";
import { postDreamcoinEntry } from "@/server/modules/billing/ledger";
import { paymentProviderCapabilities } from "@/server/providers/payment/capabilities";
import {
  lockUserLedger,
  publicFeatureProjection,
  publicOfferAvailability,
  toInputJson,
} from "./service";

type JsonRecord = Record<string, Prisma.JsonValue>;

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

export async function entitlementMap(userId: string) {
  const now = new Date();
  const [entitlements, activeSubscriptions] = await Promise.all([
    prisma.entitlement.findMany({
      where: {
        userId,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
    }),
    prisma.subscription.findMany({
      where: {
        userId,
        status: "active",
        OR: [{ currentPeriodEnd: null }, { currentPeriodEnd: { gt: now } }],
      },
      include: { plan: true },
      orderBy: [{ currentPeriodEnd: "desc" }, { createdAt: "desc" }],
    }),
  ]);
  const map: Record<string, Prisma.JsonValue> = {};

  for (const subscription of activeSubscriptions) {
    if (map.plan === undefined) {
      map.plan = {
        slug: subscription.plan.slug,
        billingPeriod: subscription.plan.billingPeriod,
      };
    }
    mergeDerivedEntitlement(map, "premium_controls", true);
    for (const [key, value] of Object.entries(subscription.plan.features as JsonRecord)) {
      mergeDerivedEntitlement(map, featureKey(key), value ?? false);
    }
  }

  for (const entitlement of entitlements) map[entitlement.key] = entitlement.value;
  return map;
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
  const checkout = subscription.providerSubscriptionId
    ? await prisma.checkoutSession.findUnique({
        where: {
          provider_providerSessionId: {
            provider: subscription.provider,
            providerSessionId: subscription.providerSubscriptionId,
          },
        },
        select: { offerSnapshot: true, planId: true },
      })
    : null;
  const offerSnapshot = checkoutOfferSnapshotSchema.safeParse(
    checkout?.offerSnapshot,
  );
  const authoritativeOffer =
    offerSnapshot.success &&
    offerSnapshot.data.planId === subscription.planId &&
    checkout?.planId === subscription.planId
      ? offerSnapshot.data
      : null;
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

async function syncSubscriptionEntitlements(
  tx: Prisma.TransactionClient,
  userId: string,
  plan: {
    slug: string;
    billingPeriod: string;
    features: Prisma.JsonValue;
  },
  expiresAt: Date | null,
) {
  await tx.entitlement.upsert({
    where: { userId_key: { userId, key: "plan" } },
    update: { value: { slug: plan.slug, billingPeriod: plan.billingPeriod }, source: "subscription", expiresAt },
    create: { userId, key: "plan", value: { slug: plan.slug, billingPeriod: plan.billingPeriod }, source: "subscription", expiresAt },
  });
  const featureEntries = Object.entries(plan.features as JsonRecord);
  for (const [key, value] of featureEntries) {
    const entitlementValue = toInputJson(value ?? false);
    await tx.entitlement.upsert({
      where: { userId_key: { userId, key: featureKey(key) } },
      update: { value: entitlementValue, source: "subscription", expiresAt },
      create: { userId, key: featureKey(key), value: entitlementValue, source: "subscription", expiresAt },
    });
  }
  await tx.entitlement.upsert({
    where: { userId_key: { userId, key: "premium_controls" } },
    update: { value: true, source: "subscription", expiresAt },
    create: { userId, key: "premium_controls", value: true, source: "subscription", expiresAt },
  });
}

function featureKey(key: string) {
  return key.replace(/[A-Z]/g, (match) => `_${match.toLowerCase()}`);
}
