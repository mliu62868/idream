import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";
import { prisma } from "@/server/lib/db";
import { createPlan, createUser, purgeTestData } from "@/server/test/helpers";
import { entitlementMap, syncSubscriptionEntitlements } from "./subscription-lifecycle";
import { voiceMinutesRemainingMs } from "./voice-clip";

const P = "zt-purchased-entitlements-";

beforeAll(async () => { await purgeTestData(P); });
afterAll(async () => { await purgeTestData(P); await prisma.$disconnect(); });

describe("purchased entitlement authority", () => {
  it.each([{ slug: "premium", minutes: 30 }, { slug: "deluxe", minutes: 120 }])(
    "grants a new $slug annual purchase its monthly voice allowance rather than twelve monthly allowances",
    async ({ slug, minutes }) => {
      const userId = `${P}annual-${slug}`;
      await createUser({ id: userId });
      const plan = await prisma.plan.findUniqueOrThrow({ where: { slug_billingPeriod: { slug, billingPeriod: "yearly" } } });
      const invoiceId = `${userId}-invoice`;
      await prisma.checkoutSession.create({ data: {
        id: `${userId}-checkout`, userId, planId: plan.id, provider: "mock", providerSessionId: invoiceId,
        amountCents: plan.priceCents, currency: plan.currency, status: "completed",
        offerSnapshot: {
          version: 1, planId: plan.id, slug: plan.slug, name: plan.name, billingPeriod: plan.billingPeriod,
          priceCents: plan.priceCents, currency: plan.currency, includedDreamcoins: plan.includedDreamcoins,
          features: plan.features!,
        },
      } });
      await prisma.subscription.create({ data: {
        id: `${userId}-subscription`, userId, planId: plan.id, provider: "mock", providerSubscriptionId: invoiceId,
        status: "active", currentPeriodEnd: new Date(Date.now() + 365 * 86_400_000),
      } });
      const entitlements = await entitlementMap(userId);
      expect(await voiceMinutesRemainingMs(userId, entitlements)).toBe(minutes * 60_000);
    },
  );

  it("corrects future annual offers without changing accepted offers and refuses snapshotless legacy access", async () => {
    const userId = `${P}annual-cutover`;
    const legacyUserId = `${userId}-legacy`;
    await createUser({ id: userId });
    await createUser({ id: legacyUserId });
    const premium = await prisma.plan.findUniqueOrThrow({ where: { slug_billingPeriod: { slug: "premium", billingPeriod: "yearly" } } });
    const deluxe = await prisma.plan.findUniqueOrThrow({ where: { slug_billingPeriod: { slug: "deluxe", billingPeriod: "yearly" } } });
    const originalFeatures = premium.features as Record<string, never>;
    const oldFeatures = { ...originalFeatures, voiceMinutes: 360 };
    const invoiceId = `${userId}-invoice`;
    const snapshot = {
      version: 1, planId: premium.id, slug: premium.slug, name: premium.name, billingPeriod: premium.billingPeriod,
      priceCents: premium.priceCents, currency: premium.currency, includedDreamcoins: premium.includedDreamcoins, features: oldFeatures,
    };
    await prisma.checkoutSession.createMany({ data: [
      { id: `${userId}-checkout`, userId, planId: premium.id, provider: "mock", providerSessionId: invoiceId,
        amountCents: premium.priceCents, currency: premium.currency, status: "completed", offerSnapshot: snapshot },
      { id: `${userId}-pending`, userId, planId: premium.id, provider: "mock", providerSessionId: `${invoiceId}-pending`,
        amountCents: premium.priceCents, currency: premium.currency, status: "created", offerSnapshot: snapshot },
    ] });
    await prisma.subscription.create({ data: {
      id: `${userId}-subscription`, userId, planId: premium.id, provider: "mock", providerSubscriptionId: invoiceId,
      status: "active", currentPeriodEnd: new Date(Date.now() + 365 * 86_400_000),
    } });
    await prisma.subscription.create({ data: { id: `${userId}-legacy-subscription`, userId: legacyUserId, planId: premium.id, provider: "mock", status: "active" } });
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const sql = await readFile(path.resolve(process.cwd(), "../../db/sql/2026-10-29-annual-voice-allowance.sql"), "utf8");
    try {
      await prisma.plan.update({ where: { id: premium.id }, data: { features: oldFeatures } });
      await prisma.plan.update({ where: { id: deluxe.id }, data: { features: { ...(deluxe.features as Record<string, never>), voiceMinutes: 1440 } } });
      await expect(client.query(sql)).rejects.toThrow("Annual legacy subscription lacks a valid purchased offer");
      await client.query("ROLLBACK");
      expect((await prisma.plan.findUniqueOrThrow({ where: { id: premium.id } })).features).toMatchObject({ voiceMinutes: 360 });
      expect((await prisma.plan.findUniqueOrThrow({ where: { id: deluxe.id } })).features).toMatchObject({ voiceMinutes: 1440 });

      await prisma.subscription.delete({ where: { id: `${userId}-legacy-subscription` } });
      await client.query(sql);
      await client.query(sql); // Reapplying the correction changes no purchased fact.
      expect((await prisma.plan.findUniqueOrThrow({ where: { id: premium.id } })).features).toEqual({ ...oldFeatures, voiceMinutes: 30 });
      expect((await prisma.plan.findUniqueOrThrow({ where: { id: deluxe.id } })).features).toMatchObject({ voiceMinutes: 120 });
      expect(await entitlementMap(userId)).toMatchObject({ voice_minutes: 360 });
      expect(await voiceMinutesRemainingMs(userId, await entitlementMap(userId))).toBe(360 * 60_000);
      for (const id of [`${userId}-checkout`, `${userId}-pending`]) {
        expect((await prisma.checkoutSession.findUniqueOrThrow({ where: { id } })).offerSnapshot).toEqual(snapshot);
      }
      await prisma.entitlement.create({ data: { userId, key: "voice_minutes", value: 75, source: "admin" } });
      expect(await entitlementMap(userId)).toMatchObject({ voice_minutes: 75 });
    } finally {
      await client.query("ROLLBACK");
      await client.end();
      await prisma.plan.update({ where: { id: premium.id }, data: { features: premium.features! } });
      await prisma.plan.update({ where: { id: deluxe.id }, data: { features: deluxe.features! } });
    }
  });

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
