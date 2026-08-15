import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/lib/db";
import { postDreamcoinEntry } from "@/server/modules/billing/ledger";
import { parseSubscriptionRefundEvidence } from "@/server/modules/billing/subscription-refund";
import { providers } from "@/server/providers";
import {
  api,
  createPlan,
  createUser,
  expectOk,
  purgeTestData,
} from "@/server/test/helpers";

const P = "zt-subscription-refund-";
const actorId = `${P}actor`;
const supportId = `${P}support`;
const customerId = `${P}customer`;
const planId = `${P}plan`;
const checkoutId = `${P}checkout`;
const invoiceId = `${P}invoice`;
const subscriptionId = `${P}subscription`;
const idempotencyKey = `${P}request-1`;
let primaryRefundReference = "";

async function cleanup() {
  await prisma.controlPlaneCommand.deleteMany({
    where: {
      OR: [
        { actorId: { startsWith: P } },
        { targetId: { startsWith: P } },
      ],
    },
  });
  await purgeTestData(P);
}

beforeAll(async () => {
  await cleanup();
  await createUser({ id: actorId, role: "admin", dataClass: "internal" });
  await createUser({ id: supportId, role: "support", dataClass: "internal" });
  await createUser({ id: customerId, dataClass: "customer" });
  await createPlan({
    id: planId,
    slug: `${P}premium`,
    includedDreamcoins: 1_500,
    features: {
      unlimitedMessages: true,
      imageGeneration: true,
      videoGeneration: false,
      voiceGeneration: true,
    },
  });
  await prisma.checkoutSession.create({
    data: {
      id: checkoutId,
      userId: customerId,
      planId,
      provider: "mock",
      providerSessionId: invoiceId,
      providerInvoiceStatus: "settled",
      providerInvoiceAdditionalStatus: "none",
      amountCents: 1_999,
      currency: "usd",
      offerSnapshot: {
        version: 1,
        planId,
        slug: `${P}premium`,
        name: "Premium",
        billingPeriod: "monthly",
        priceCents: 1_999,
        currency: "usd",
        includedDreamcoins: 1_500,
        features: {
          unlimitedMessages: true,
          imageGeneration: true,
          videoGeneration: false,
          voiceGeneration: true,
        },
      },
      status: "completed",
    },
  });
  await prisma.subscription.create({
    data: {
      id: subscriptionId,
      userId: customerId,
      planId,
      provider: "mock",
      providerSubscriptionId: invoiceId,
      status: "active",
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
    },
  });
  await prisma.entitlement.createMany({
    data: [
      {
        id: `${P}entitlement-plan`,
        userId: customerId,
        key: "plan",
        value: { slug: `${P}premium`, billingPeriod: "monthly" },
        source: "subscription",
      },
      {
        id: `${P}entitlement-image`,
        userId: customerId,
        key: "image_generation",
        value: true,
        source: "subscription",
      },
    ],
  });
  await prisma.$transaction(async (tx) => {
    await postDreamcoinEntry(tx, {
      kind: "signup_bonus",
      userId: customerId,
      amount: 250,
      sourceId: `${P}signup`,
      idempotencyKey: `${P}signup`,
    });
    await postDreamcoinEntry(tx, {
      kind: "subscription_grant",
      userId: customerId,
      amount: 1_500,
      sourceId: subscriptionId,
      idempotencyKey: `${P}grant`,
    });
    await postDreamcoinEntry(tx, {
      kind: "generation_spend",
      userId: customerId,
      amount: 8,
      sourceId: `${P}generation`,
      idempotencyKey: `${P}generation`,
    });
  });
});

afterAll(async () => {
  vi.restoreAllMocks();
  await cleanup();
  await prisma.$disconnect();
});

describe.sequential("completed subscription refund authority", () => {
  it("requires the dedicated refund permission", async () => {
    const denied = await api(
      "POST",
      `admin/billing/subscriptions/${subscriptionId}/refund`,
      {
        userId: supportId,
        role: "support",
        body: {
          reason: "Customer requested a full refund.",
          confirmation: `${subscriptionId}:refund`,
        },
      },
    );

    expect(denied.status).toBe(403);
    expect(denied.error?.details).toMatchObject({
      permission: "billing.subscription.refund",
    });
  });

  it("creates one provider refund, freezes access, and reverses the exact grant", async () => {
    const createRefund = vi.spyOn(providers.payment, "createRefund");
    const body = {
      reason: "Customer requested a full refund.",
      confirmation: `${subscriptionId}:refund`,
    };
    const first = await api(
      "POST",
      `admin/billing/subscriptions/${subscriptionId}/refund`,
      {
        userId: actorId,
        role: "admin",
        headers: { "idempotency-key": idempotencyKey },
        body,
      },
    );
    expectOk(first);
    primaryRefundReference = (
      first.data as { refund: { reference: string } }
    ).refund.reference;
    expect(primaryRefundReference).toMatch(
      new RegExp(`^idream-refund:${checkoutId}:.+$`),
    );
    expect(first.data).toMatchObject({
      replayed: false,
      checkoutId,
      subscriptionId,
      subscriptionStatus: "refund_pending",
      refund: {
        reference: primaryRefundReference,
        state: "claimable",
      },
      settlement: {
        reversedDreamcoins: 1_500,
        balanceAfter: 242,
      },
    });

    const replay = await api(
      "POST",
      `admin/billing/subscriptions/${subscriptionId}/refund`,
      {
        userId: actorId,
        role: "admin",
        headers: { "idempotency-key": idempotencyKey },
        body,
      },
    );
    expectOk(replay);
    expect(replay.data).toMatchObject({ replayed: true });
    expect(createRefund).toHaveBeenCalledTimes(1);
    expect(createRefund).toHaveBeenCalledWith({
      invoiceId,
      reference: primaryRefundReference,
      reason: body.reason,
      amountCents: 1_999,
      currency: "usd",
    });
    await expect(
      prisma.subscription.findUniqueOrThrow({
        where: { id: subscriptionId },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: "refund_pending" });
    await expect(
      prisma.entitlement.count({
        where: { userId: customerId, source: "subscription" },
      }),
    ).resolves.toBe(0);
    await expect(
      prisma.dreamcoinLedger.findMany({
        where: { userId: customerId, reason: "subscription_refund" },
        select: { delta: true, balanceAfter: true, sourceId: true },
      }),
    ).resolves.toEqual([
      {
        delta: -1_500,
        balanceAfter: 242,
        sourceId: subscriptionId,
      },
    ]);
  });

  it("converges a completed provider payout without a second coin reversal", async () => {
    vi.spyOn(providers.payment, "findRefund").mockResolvedValue({
      ok: true,
      data: {
        provider: "mock",
        refundId: `mock-refund-${invoiceId}`,
        reference: primaryRefundReference,
        claimUrl: `https://mock-payments.idream.local/refunds/mock-refund-${invoiceId}`,
        amount: "19.99",
        currency: "usd",
        state: "completed",
        payouts: [
          {
            payoutId: `${P}payout`,
            amount: "19.99",
            currency: "usd",
            state: "completed",
            paymentProofId: `${P}transaction`,
          },
        ],
      },
    });

    const reconciled = await api(
      "POST",
      `admin/billing/subscriptions/${subscriptionId}/refund/reconcile`,
      {
        userId: actorId,
        role: "admin",
        headers: { "idempotency-key": `${P}reconcile-1` },
        body: {
          reason: "Provider payout completed.",
          confirmation: `${subscriptionId}:refund_reconcile`,
        },
      },
    );
    expectOk(reconciled);
    expect(reconciled.data).toMatchObject({
      subscriptionStatus: "refunded",
      refund: {
        state: "completed",
        payouts: [
          {
            payoutId: `${P}payout`,
            paymentProofId: `${P}transaction`,
          },
        ],
      },
    });
    await expect(
      prisma.checkoutSession.findUniqueOrThrow({
        where: { id: checkoutId },
        select: {
          status: true,
          failureCode: true,
          needsReconciliation: true,
        },
      }),
    ).resolves.toEqual({
      status: "refunded",
      failureCode: null,
      needsReconciliation: false,
    });
    await expect(
      prisma.dreamcoinLedger.count({
        where: { userId: customerId, reason: "subscription_refund" },
      }),
    ).resolves.toBe(1);

    const profile = await api("GET", "profile", { userId: customerId });
    expectOk(profile);
    expect(profile.data).toMatchObject({
      balance: 242,
      subscription: null,
      billingAccess: null,
      refund: {
        subscriptionId,
        state: "completed",
      },
    });
  });

  it("restores subscription access and the exact grant when a payout-canceled webhook arrives", async () => {
    vi.restoreAllMocks();
    const suffix = "webhook-cancel";
    const cancelCustomerId = `${P}${suffix}-customer`;
    const cancelCheckoutId = `${P}${suffix}-checkout`;
    const cancelInvoiceId = `${P}${suffix}-invoice`;
    const cancelSubscriptionId = `${P}${suffix}-subscription`;
    await createUser({ id: cancelCustomerId, dataClass: "customer" });
    await prisma.checkoutSession.create({
      data: {
        id: cancelCheckoutId,
        userId: cancelCustomerId,
        planId,
        provider: "mock",
        providerSessionId: cancelInvoiceId,
        providerInvoiceStatus: "settled",
        providerInvoiceAdditionalStatus: "none",
        amountCents: 1_999,
        currency: "usd",
        status: "completed",
      },
    });
    await prisma.subscription.create({
      data: {
        id: cancelSubscriptionId,
        userId: cancelCustomerId,
        planId,
        provider: "mock",
        providerSubscriptionId: cancelInvoiceId,
        status: "active",
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
      },
    });
    await prisma.entitlement.create({
      data: {
        id: `${P}${suffix}-entitlement`,
        userId: cancelCustomerId,
        key: "plan",
        value: { slug: `${P}premium`, billingPeriod: "monthly" },
        source: "subscription",
      },
    });
    await prisma.$transaction(async (tx) => {
      await postDreamcoinEntry(tx, {
        kind: "signup_bonus",
        userId: cancelCustomerId,
        amount: 250,
        sourceId: `${P}${suffix}-signup`,
        idempotencyKey: `${P}${suffix}-signup`,
      });
      await postDreamcoinEntry(tx, {
        kind: "subscription_grant",
        userId: cancelCustomerId,
        amount: 1_500,
        sourceId: cancelSubscriptionId,
        idempotencyKey: `${P}${suffix}-grant`,
      });
      await postDreamcoinEntry(tx, {
        kind: "generation_spend",
        userId: cancelCustomerId,
        amount: 8,
        sourceId: `${P}${suffix}-generation`,
        idempotencyKey: `${P}${suffix}-generation`,
      });
    });

    const requested = await api(
      "POST",
      `admin/billing/subscriptions/${cancelSubscriptionId}/refund`,
      {
        userId: actorId,
        role: "admin",
        headers: { "idempotency-key": `${P}${suffix}-request` },
        body: {
          reason: "Customer requested a full refund.",
          confirmation: `${cancelSubscriptionId}:refund`,
        },
      },
    );
    expectOk(requested);
    const refundId = `mock-refund-${cancelInvoiceId}`;
    const payoutId = `${P}${suffix}-payout`;
    const pendingCheckout = await prisma.checkoutSession.findUniqueOrThrow({
      where: { id: cancelCheckoutId },
      select: {
        status: true,
        needsReconciliation: true,
        reconciliationEvidence: true,
      },
    });
    expect(pendingCheckout).toMatchObject({
      status: "refund_pending",
      needsReconciliation: true,
      reconciliationEvidence: {
        refund: { providerRefundId: refundId },
      },
    });
    expect(
      parseSubscriptionRefundEvidence(pendingCheckout.reconciliationEvidence),
    ).toMatchObject({ providerRefundId: refundId });
    const canceledReference = parseSubscriptionRefundEvidence(
      pendingCheckout.reconciliationEvidence,
    )!.reference;
    const blockedCheckout = await api("POST", "billing/checkout", {
      userId: cancelCustomerId,
      headers: { "idempotency-key": `${P}${suffix}-blocked-checkout` },
      body: { planId, returnPath: "/profile", autoConfirm: true },
    });
    expect(blockedCheckout.status).toBe(409);
    expect(blockedCheckout.error).toMatchObject({
      code: "conflict",
      details: { reason: "subscription_refund_pending" },
    });

    const findRefund = vi.spyOn(providers.payment, "findRefund");
    findRefund.mockResolvedValue({
      ok: true,
      data: {
        provider: "mock",
        refundId,
        reference: canceledReference,
        claimUrl: `https://mock-payments.idream.local/refunds/${refundId}`,
        amount: "55.00",
        currency: "usd",
        state: "canceled",
        payouts: [
          {
            payoutId,
            amount: "55.00",
            currency: "usd",
            state: "canceled",
          },
        ],
      },
    });
    const webhookBody = {
      type: "refund.updated",
      deliveryId: `${P}${suffix}-event`,
      refundId,
      payoutId,
      payoutState: "canceled",
    };
    const mismatched = await api("POST", "billing/webhooks/mock", {
      body: webhookBody,
    });
    expect(mismatched.status).toBe(500);
    await expect(
      prisma.subscription.findUniqueOrThrow({
        where: { id: cancelSubscriptionId },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: "refund_pending" });
    await expect(
      prisma.dreamcoinLedger.count({
        where: {
          userId: cancelCustomerId,
          reason: "subscription_refund_restore",
        },
      }),
    ).resolves.toBe(0);

    findRefund.mockResolvedValue({
      ok: true,
      data: {
        provider: "mock",
        refundId,
        reference: canceledReference,
        claimUrl: `https://mock-payments.idream.local/refunds/${refundId}`,
        amount: "19.99",
        currency: "usd",
        state: "canceled",
        payouts: [
          {
            payoutId,
            amount: "19.99",
            currency: "usd",
            state: "canceled",
          },
        ],
      },
    });
    const competingSubscriptionId = `${P}${suffix}-competing-subscription`;
    await prisma.subscription.create({
      data: {
        id: competingSubscriptionId,
        userId: cancelCustomerId,
        planId,
        provider: "mock",
        providerSubscriptionId: `${cancelInvoiceId}-competing`,
        status: "active",
        currentPeriodEnd: new Date(Date.now() + 20 * 24 * 60 * 60 * 1_000),
      },
    });
    const competing = await api("POST", "billing/webhooks/mock", {
      body: webhookBody,
    });
    expect(competing.status).toBe(409);
    await expect(
      prisma.dreamcoinLedger.count({
        where: {
          userId: cancelCustomerId,
          reason: "subscription_refund_restore",
        },
      }),
    ).resolves.toBe(0);
    await prisma.subscription.delete({
      where: { id: competingSubscriptionId },
    });
    const converged = await api("POST", "billing/webhooks/mock", {
      body: webhookBody,
    });
    expectOk(converged);
    expect(converged.data).toMatchObject({
      processed: true,
      subscriptionId: cancelSubscriptionId,
      subscriptionStatus: "active",
      refund: {
        state: "canceled",
        restoredBalanceAfter: 1_742,
      },
    });
    const replay = await api("POST", "billing/webhooks/mock", {
      body: webhookBody,
    });
    expectOk(replay);
    expect(replay.data).toMatchObject({ processed: false, idempotent: true });
    await expect(
      prisma.subscription.findUniqueOrThrow({
        where: { id: cancelSubscriptionId },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: "active" });
    await expect(
      prisma.entitlement.count({
        where: { userId: cancelCustomerId, source: "subscription" },
      }),
    ).resolves.toBe(6);
    await expect(
      prisma.dreamcoinLedger.findMany({
        where: {
          userId: cancelCustomerId,
          reason: { in: ["subscription_refund", "subscription_refund_restore"] },
        },
        orderBy: { createdAt: "asc" },
        select: { delta: true, balanceAfter: true, reason: true },
      }),
    ).resolves.toEqual([
      { delta: -1_500, balanceAfter: 242, reason: "subscription_refund" },
      {
        delta: 1_500,
        balanceAfter: 1_742,
        reason: "subscription_refund_restore",
      },
    ]);

    vi.restoreAllMocks();
    const retried = await api(
      "POST",
      `admin/billing/subscriptions/${cancelSubscriptionId}/refund`,
      {
        userId: actorId,
        role: "admin",
        headers: { "idempotency-key": `${P}${suffix}-retry` },
        body: {
          reason: "Customer retried the full refund after payout cancellation.",
          confirmation: `${cancelSubscriptionId}:refund`,
        },
      },
    );
    expectOk(retried);
    expect(retried.data).toMatchObject({
      subscriptionStatus: "refund_pending",
      refund: { state: "claimable" },
      settlement: { reversedDreamcoins: 1_500, balanceAfter: 242 },
    });
    expect(
      (retried.data as { refund: { reference: string } }).refund.reference,
    ).not.toBe(canceledReference);
    await expect(
      prisma.dreamcoinLedger.findMany({
        where: {
          userId: cancelCustomerId,
          reason: { in: ["subscription_refund", "subscription_refund_restore"] },
        },
        orderBy: { createdAt: "asc" },
        select: { delta: true, balanceAfter: true, reason: true },
      }),
    ).resolves.toEqual([
      { delta: -1_500, balanceAfter: 242, reason: "subscription_refund" },
      {
        delta: 1_500,
        balanceAfter: 1_742,
        reason: "subscription_refund_restore",
      },
      { delta: -1_500, balanceAfter: 242, reason: "subscription_refund" },
    ]);
  });
});
