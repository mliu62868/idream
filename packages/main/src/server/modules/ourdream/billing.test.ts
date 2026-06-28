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

    const replay = await api("POST", "billing/webhooks/mock", {
      headers: { "x-provider-event-id": `${P}evt-1` },
      body: webhookBody,
    });
    expectOk(replay);
    expect(replay.data).toMatchObject({ idempotent: true, processed: false });
    // Balance unchanged — no double grant.
    expect(await dreamcoinBalance(userId)).toBe(800);

    const subscriptions = await prisma.subscription.count({ where: { userId } });
    expect(subscriptions).toBe(1);
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
