import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import {
  api,
  createCharacter,
  createPlan,
  createUser,
  dreamcoinBalance,
  expectOk,
  grantCoins,
  purgeTestData,
  runQueuedGenerationJobs,
} from "@/server/test/helpers";

// SPEC (docs/architecture/11-testing.md §4 — billing/ledger):
// - dreamcoin balance == SUM(ledger); append-only
// - checkout → entitlement active; premium gates open server-side
// - generation reserve→settle/refund nets correctly
// - webhook is idempotent: a repeated provider event changes state once

const P = "zt-bill-";

async function setupUser(suffix: string) {
  const id = `${P}u-${suffix}`;
  await createUser({ id });
  return id;
}

async function setupPlan(suffix: string, includedDreamcoins = 1000) {
  const id = `${P}plan-${suffix}`;
  await createPlan({
    id,
    slug: `${P}premium-${suffix}`,
    billingPeriod: "monthly",
    includedDreamcoins,
    features: {
      unlimitedMessages: true,
      imageGeneration: true,
      videoGeneration: true,
      voiceEnabled: true,
      customPrompt: true,
    },
  });
  return id;
}

beforeAll(async () => {
  await purgeTestData(P);
});

afterAll(async () => {
  await purgeTestData(P);
  await prisma.$disconnect();
});

describe("plans billing mode", () => {
  it("marks local mock checkout as demo-only and auto-confirm capable", async () => {
    const plans = await api("GET", "plans");
    expectOk(plans);
    expect(plans.data.billing).toMatchObject({
      provider: "mock",
      demoMode: true,
      autoConfirmAvailable: true,
    });
  });
});

describe("checkout (auto-confirm) activates entitlements + grants coins", () => {
  it("activates a subscription, derives entitlements, and grants included dreamcoins", async () => {
    const userId = await setupUser("checkout");
    const planId = await setupPlan("checkout", 1000);

    const checkout = await api("POST", "billing/checkout", {
      userId,
      body: { planId, autoConfirm: true },
    });
    expectOk(checkout);
    expect(checkout.data.subscription).toMatchObject({ status: "active", planId });

    const me = await api("GET", "me", { userId });
    expect(me.data.dreamcoins.balance).toBe(1000);
    expect(me.data.entitlements).toMatchObject({
      premium_controls: true,
      video_generation: true,
      // camelCase plan feature → snake_case entitlement; gates on-demand voice.
      voice_enabled: true,
      custom_prompt: true,
    });
    expect(
      await prisma.analyticsEvent.count({
        where: { userId, name: "subscription_started" },
      }),
    ).toBe(1);

    // Premium gate now opens: a custom prompt no longer returns 402.
    const charId = `${P}char-checkout`;
    await createCharacter({ id: charId, creatorId: userId, visibility: "public", status: "approved" });
    const gen = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: { mode: "image", characterId: charId, prompt: "a premium scene", outputCount: 1 },
    });
    expectOk(gen, 202);
    expect(gen.data.job.status).toBe("queued");
    await runQueuedGenerationJobs(8);
  });

  it("is idempotent on repeated auto-confirm checkout: no extra subs or coins", async () => {
    const userId = await setupUser("repeat");
    const planId = await setupPlan("repeat", 1000);

    const first = await api("POST", "billing/checkout", {
      userId,
      body: { planId, autoConfirm: true },
    });
    expectOk(first);
    expect(first.data.subscription).toMatchObject({ status: "active", planId });
    expect(await dreamcoinBalance(userId)).toBe(1000);

    // Replaying checkout must not mint coins again or stack a second subscription.
    const second = await api("POST", "billing/checkout", {
      userId,
      body: { planId, autoConfirm: true },
    });
    expectOk(second);
    expect(second.data.subscription.id).toBe(first.data.subscription.id);
    expect(await dreamcoinBalance(userId)).toBe(1000);
    expect(await prisma.subscription.count({ where: { userId } })).toBe(1);
    expect(
      await prisma.analyticsEvent.count({
        where: { userId, name: "subscription_started" },
      }),
    ).toBe(1);
  });

  it("backfills plan-derived entitlements when replaying an existing active subscription", async () => {
    const userId = await setupUser("backfill-existing");
    const planId = await setupPlan("backfill-existing", 1000);
    await prisma.subscription.create({
      data: {
        id: `${P}sub-backfill-existing`,
        userId,
        planId,
        provider: "mock",
        providerSubscriptionId: `${P}invoice-existing`,
        status: "active",
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    const checkout = await api("POST", "billing/checkout", {
      userId,
      body: { planId, autoConfirm: true },
    });
    expectOk(checkout);
    expect(checkout.data.subscription.id).toBe(`${P}sub-backfill-existing`);
    expect(await dreamcoinBalance(userId)).toBe(0);

    const me = await api("GET", "me", { userId });
    expectOk(me);
    expect(me.data.entitlements).toMatchObject({
      voice_enabled: true,
      video_generation: true,
      premium_controls: true,
    });
  });

  it("creates an invoice without activating when auto-confirm is false", async () => {
    const userId = await setupUser("manual-checkout");
    const planId = await setupPlan("manual-checkout", 1000);

    const checkout = await api("POST", "billing/checkout", {
      userId,
      body: { planId, autoConfirm: false },
    });
    expectOk(checkout);
    expect(checkout.data).toMatchObject({
      billing: { provider: "mock", demoMode: true, autoConfirmAvailable: true },
      subscription: null,
    });
    expect(checkout.data.invoice.checkoutUrl).toContain("mock-payments.idream.local");
    expect(await dreamcoinBalance(userId)).toBe(0);
    expect(await prisma.subscription.count({ where: { userId } })).toBe(0);
  });
});

describe("billing portal local subscription management", () => {
  it("routes inactive users to upgrade instead of pretending a portal exists", async () => {
    const userId = await setupUser("portal-inactive");

    const portal = await api("POST", "billing/portal", { userId });
    expectOk(portal);
    expect(portal.data).toMatchObject({
      mode: "subscribe",
      url: "/upgrade",
      subscription: null,
    });
  });

  it("cancels and resumes renewal without removing current-period entitlements", async () => {
    const userId = await setupUser("portal-active");
    const planId = await setupPlan("portal-active", 1000);
    const checkout = await api("POST", "billing/checkout", {
      userId,
      body: { planId, autoConfirm: true },
    });
    expectOk(checkout);

    const portal = await api("POST", "billing/portal", { userId });
    expectOk(portal);
    expect(portal.data).toMatchObject({ mode: "manage", url: "/profile#billing" });
    expect(portal.data.subscription.cancelAtPeriodEnd).toBe(false);

    const canceled = await api("POST", "billing/cancel", { userId });
    expectOk(canceled);
    expect(canceled.data.subscription.cancelAtPeriodEnd).toBe(true);
    expect(canceled.data.message).toContain("Benefits stay active");

    const profileAfterCancel = await api("GET", "profile", { userId });
    expectOk(profileAfterCancel);
    expect(profileAfterCancel.data.subscription.cancelAtPeriodEnd).toBe(true);
    expect(profileAfterCancel.data.entitlements).toMatchObject({
      premium_controls: true,
      voice_enabled: true,
    });

    const resumed = await api("POST", "billing/resume", { userId });
    expectOk(resumed);
    expect(resumed.data.subscription.cancelAtPeriodEnd).toBe(false);
    expect(resumed.data.message).toBe("Renewal resumed.");
    expect(
      await prisma.analyticsEvent.count({
        where: { userId, name: { in: ["subscription_cancel_requested", "subscription_resume_requested"] } },
      }),
    ).toBe(2);
  });
});

describe("webhook idempotency", () => {
  it("activates once on first event and is a no-op on replay", async () => {
    const userId = await setupUser("webhook");
    const planId = await setupPlan("webhook", 800);

    const checkout = await api("POST", "billing/checkout", {
      userId,
      body: { planId, autoConfirm: false },
    });
    expectOk(checkout);
    expect(checkout.data.subscription).toBeNull();
    const invoiceId = checkout.data.invoice.invoiceId as string;

    const webhookBody = { invoiceId, planId, providerEventId: `${P}evt-1` };
    const first = await api("POST", "billing/webhooks/mock", {
      headers: { "x-provider-event-id": `${P}evt-1` },
      body: webhookBody,
    });
    expectOk(first);
    expect(first.data).toMatchObject({ processed: true });
    expect(await dreamcoinBalance(userId)).toBe(800);
    expect(
      await prisma.analyticsEvent.count({
        where: { userId, name: "subscription_started" },
      }),
    ).toBe(1);

    const replay = await api("POST", "billing/webhooks/mock", {
      headers: { "x-provider-event-id": `${P}evt-1` },
      body: webhookBody,
    });
    expectOk(replay);
    expect(replay.data).toMatchObject({ idempotent: true, processed: false });
    // Balance unchanged — no double grant.
    expect(await dreamcoinBalance(userId)).toBe(800);
    expect(
      await prisma.analyticsEvent.count({
        where: { userId, name: "subscription_started" },
      }),
    ).toBe(1);

    const subscriptions = await prisma.subscription.count({ where: { userId } });
    expect(subscriptions).toBe(1);
  });

  it("processes the event but does not activate when the payload omits planId", async () => {
    const userId = await setupUser("noplan");
    const planId = await setupPlan("noplan", 700);

    const checkout = await api("POST", "billing/checkout", {
      userId,
      body: { planId, autoConfirm: false },
    });
    expectOk(checkout);
    const invoiceId = checkout.data.invoice.invoiceId as string;

    // Controlled-beta: planId is resolved only from the webhook payload (echoed
    // from invoice metadata). With no payload planId and no CheckoutSession.planId
    // column, settlement marks the event processed but cannot activate a sub —
    // this only affects the deferred BTCPay path; auto-confirm carries planId.
    const webhookBody = { invoiceId, providerEventId: `${P}evt-noplan` };
    const result = await api("POST", "billing/webhooks/mock", {
      headers: { "x-provider-event-id": `${P}evt-noplan` },
      body: webhookBody,
    });
    expectOk(result);
    expect(result.data).toMatchObject({ processed: true });
    expect(await dreamcoinBalance(userId)).toBe(0);
    expect(await prisma.subscription.count({ where: { userId } })).toBe(0);
  });

  it("keeps a failed webhook settlement retryable until processedAt is written", async () => {
    const userId = await setupUser("retryable-webhook");
    const planId = await setupPlan("retryable-webhook", 650);

    const checkout = await api("POST", "billing/checkout", {
      userId,
      body: { planId, autoConfirm: false },
    });
    expectOk(checkout);
    const invoiceId = checkout.data.invoice.invoiceId as string;
    const providerEventId = `${P}evt-retryable`;

    const failed = await api("POST", "billing/webhooks/mock", {
      headers: { "x-provider-event-id": providerEventId },
      body: { invoiceId, planId: `${P}missing-plan`, providerEventId },
    });
    expect(failed.ok).toBe(false);
    const eventAfterFailure = await prisma.providerEvent.findUniqueOrThrow({
      where: { provider_providerEventId: { provider: "mock", providerEventId } },
    });
    expect(eventAfterFailure.processedAt).toBeNull();
    expect(await prisma.subscription.count({ where: { userId } })).toBe(0);

    const retry = await api("POST", "billing/webhooks/mock", {
      headers: { "x-provider-event-id": providerEventId },
      body: { invoiceId, planId, providerEventId },
    });
    expectOk(retry);
    expect(retry.data).toMatchObject({ processed: true });
    expect(await dreamcoinBalance(userId)).toBe(650);
    const eventAfterRetry = await prisma.providerEvent.findUniqueOrThrow({
      where: { provider_providerEventId: { provider: "mock", providerEventId } },
    });
    expect(eventAfterRetry.processedAt).not.toBeNull();
  });
});

describe("dreamcoin ledger invariants", () => {
  it("keeps balance == SUM(ledger) and settles a successful generation spend", async () => {
    const userId = await setupUser("ledger");
    const charId = `${P}char-ledger`;
    await createCharacter({ id: charId, creatorId: userId, visibility: "public", status: "approved" });
    await grantCoins(userId, 100, "seed");

    const before = await dreamcoinBalance(userId);
    expect(before).toBe(100);

    const gen = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: { mode: "image", characterId: charId, outputCount: 2 },
    });
    expectOk(gen, 202);
    expect(gen.data.job.status).toBe("queued");
    await runQueuedGenerationJobs(8);

    // image costs 5 per output → 10 reserved and settled (no refund).
    const after = await dreamcoinBalance(userId);
    expect(after).toBe(90);

    const dc = await api("GET", "dreamcoins", { userId });
    expectOk(dc);
    expect(dc.data.balance).toBe(90);
    // Ledger is append-only and the running sum matches the balance.
    const sum = (dc.data.ledger as Array<{ delta: number }>).reduce((acc, e) => acc + e.delta, 0);
    expect(sum).toBe(90);
    // The spend entry's balanceAfter reflects the post-spend balance.
    const spend = (dc.data.ledger as Array<{ reason: string; balanceAfter: number }>).find(
      (e) => e.reason === "generation_spend",
    );
    expect(spend?.balanceAfter).toBe(90);
  });
});
