import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { createPlan, createUser, purgeTestData } from "@/server/test/helpers";
import { entitlementMap, syncSubscriptionEntitlements } from "./subscription-lifecycle";

const P = "zt-purchased-entitlements-";

beforeAll(async () => { await purgeTestData(P); });
afterAll(async () => { await purgeTestData(P); await prisma.$disconnect(); });

describe("purchased entitlement authority", () => {
  it("rebuilds missing subscription cache from the purchased offer after the live plan changes", async () => {
    const userId = `${P}snapshot-user`;
    const planId = `${P}snapshot-plan`;
    await createUser({ id: userId });
    const plan = await createPlan({
      id: planId, slug: `${P}premium`, billingPeriod: "monthly", includedDreamcoins: 1500,
      features: { unlimitedMessages: true, voiceEnabled: true, voiceMinutes: 30 },
    });
    const invoiceId = `${P}snapshot-invoice`;
    await prisma.checkoutSession.create({ data: {
      id: `${P}snapshot-checkout`, userId, planId, provider: "mock", providerSessionId: invoiceId,
      amountCents: plan.priceCents, currency: plan.currency, status: "completed",
      offerSnapshot: {
        version: 1, planId, slug: plan.slug, name: plan.name, billingPeriod: plan.billingPeriod,
        priceCents: plan.priceCents, currency: plan.currency, includedDreamcoins: plan.includedDreamcoins,
        features: plan.features!,
      },
    } });
    await prisma.subscription.create({ data: {
      id: `${P}snapshot-subscription`, userId, planId, provider: "mock", providerSubscriptionId: invoiceId,
      status: "active", currentPeriodEnd: new Date(Date.now() + 86_400_000),
    } });
    await prisma.plan.update({ where: { id: planId }, data: {
      features: { unlimitedMessages: false, voiceEnabled: false, voiceMinutes: 900, newUnpurchasedFeature: true },
    } });

    const entitlements = await entitlementMap(userId);
    expect(entitlements).toMatchObject({ unlimited_messages: true, voice_enabled: true, voice_minutes: 30 });
    expect(entitlements).not.toHaveProperty("new_unpurchased_feature");
    await prisma.entitlement.createMany({ data: [
      { userId, key: "unlimited_messages", value: false, source: "subscription" },
      { userId, key: "voice_minutes", value: 75, source: "admin" },
    ] });
    expect(await entitlementMap(userId)).toMatchObject({ unlimited_messages: true, voice_enabled: true, voice_minutes: 75 });
    await prisma.$transaction((tx) => syncSubscriptionEntitlements(tx, userId, {
      slug: plan.slug, billingPeriod: plan.billingPeriod, features: { unlimitedMessages: true, voiceMinutes: 30 },
    }, new Date(Date.now() + 86_400_000)));
    expect(await prisma.entitlement.findUniqueOrThrow({ where: { userId_key: { userId, key: "voice_minutes" } } })).toMatchObject({ value: 75, source: "admin" });

    await prisma.subscription.update({ where: { id: `${P}snapshot-subscription` }, data: { status: "refund_pending" } });
    expect(await entitlementMap(userId)).toEqual({ voice_minutes: 75 });
  });

  it("retains explicitly identified legacy Plan and entitlement-only grants", async () => {
    const userId = `${P}legacy-user`;
    const planId = `${P}legacy-plan`;
    await createUser({ id: userId });
    await createPlan({ id: planId, slug: `${P}legacy`, features: { unlimitedMessages: true, voiceMinutes: 15 } });
    await prisma.subscription.create({ data: { id: `${P}legacy-subscription`, userId, planId, provider: "mock", status: "active" } });
    expect(await entitlementMap(userId)).toMatchObject({ unlimited_messages: true, voice_minutes: 15 });

    const grantUserId = `${P}entitlement-only`;
    await createUser({ id: grantUserId });
    await prisma.entitlement.create({ data: { userId: grantUserId, key: "voice_enabled", value: true, source: "subscription" } });
    expect(await entitlementMap(grantUserId)).toEqual({ voice_enabled: true });
  });

  it("does not fall through a malformed purchased snapshot to the live Plan", async () => {
    const userId = `${P}invalid-user`;
    const planId = `${P}invalid-plan`;
    const invoiceId = `${P}invalid-invoice`;
    await createUser({ id: userId });
    await createPlan({ id: planId, slug: `${P}invalid`, features: { unlimitedMessages: true } });
    await prisma.checkoutSession.create({ data: {
      id: `${P}invalid-checkout`, userId, planId, provider: "mock", providerSessionId: invoiceId,
      amountCents: 1_999, currency: "usd", status: "completed", offerSnapshot: { version: 1, planId },
    } });
    await prisma.subscription.create({ data: {
      id: `${P}invalid-subscription`, userId, planId, provider: "mock", providerSubscriptionId: invoiceId, status: "active",
    } });
    await expect(entitlementMap(userId)).rejects.toThrow("Purchased offer authority is invalid");
  });
});
