import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { providers } from "@/server/providers";
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

async function setupPlan(
  suffix: string,
  includedDreamcoins = 1000,
  billingPeriod: "monthly" | "yearly" = "monthly",
) {
  const id = `${P}plan-${suffix}`;
  await createPlan({
    id,
    slug: `${P}premium-${suffix}`,
    billingPeriod,
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

async function checkoutApi(
  userId: string,
  body: {
    planId: string;
    autoConfirm: boolean;
    returnPath?: string;
  },
  idempotencyKey = `${P}checkout-${crypto.randomUUID()}`,
) {
  return api("POST", "billing/checkout", {
    userId,
    headers: { "idempotency-key": idempotencyKey },
    body,
  });
}

async function createDurableCheckoutIntent(input: {
  checkoutId: string;
  idempotencyKey: string;
  planId: string;
  userId: string;
}) {
  const plan = await prisma.plan.findUniqueOrThrow({
    where: { id: input.planId },
  });
  const requestHash = createHash("sha256")
    .update(
      JSON.stringify({
        selector: { planId: input.planId },
        returnPath: "/profile",
        autoConfirm: false,
        provider: "mock",
      }),
    )
    .digest("hex");
  return prisma.checkoutSession.create({
    data: {
      id: input.checkoutId,
      userId: input.userId,
      planId: input.planId,
      provider: "mock",
      idempotencyKey: input.idempotencyKey,
      requestHash,
      amountCents: plan.priceCents,
      currency: plan.currency,
      offerSnapshot: {
        version: 1,
        planId: input.planId,
        slug: plan.slug,
        name: plan.name,
        billingPeriod: plan.billingPeriod,
        priceCents: plan.priceCents,
        currency: plan.currency,
        includedDreamcoins: plan.includedDreamcoins,
        features: plan.features,
      },
      autoConfirm: false,
      returnPath: "/profile",
      status: "provider_pending",
    },
  });
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
      billingModel: "prepaid_period",
      renewalCapability: "none",
    });
  });

  it("keeps dormant video entitlement durable without marketing it as available", async () => {
    const planId = await setupPlan("dormant-video-copy");
    const userId = await setupUser("dormant-video-copy");
    const videoFlag = await prisma.featureFlag.findUniqueOrThrow({
      where: { key: "video_gen" },
      select: { enabled: true, rolloutPercent: true },
    });
    await prisma.featureFlag.update({
      where: { key: "video_gen" },
      data: { enabled: false },
    });

    try {
      const plans = await api("GET", "plans");
      expectOk(plans);
      expect(
        plans.data.items.find((item: { id: string }) => item.id === planId)
          ?.features,
      ).toMatchObject({ videoGeneration: false });

      await prisma.featureFlag.update({
        where: { key: "video_gen" },
        data: { enabled: true, rolloutPercent: 0 },
      });
      const zeroFlagRolloutPlans = await api("GET", "plans");
      expectOk(zeroFlagRolloutPlans);
      expect(
        zeroFlagRolloutPlans.data.items.find(
          (item: { id: string }) => item.id === planId,
        )?.features,
      ).toMatchObject({ videoGeneration: false });

      await prisma.featureFlag.update({
        where: { key: "video_gen" },
        data: { enabled: true, rolloutPercent: 100 },
      });
      const productionRoutePlans = await api("GET", "plans");
      expectOk(productionRoutePlans);
      expect(
        productionRoutePlans.data.items.find(
          (item: { id: string }) => item.id === planId,
        )?.features,
      ).toMatchObject({ videoGeneration: true });

      await prisma.featureFlag.update({
        where: { key: "video_gen" },
        data: { enabled: false, rolloutPercent: 0 },
      });

      const checkout = await checkoutApi(userId, {
        planId,
        autoConfirm: true,
      });
      expectOk(checkout);

      const storedEntitlement = await prisma.entitlement.findUniqueOrThrow({
        where: {
          userId_key: { userId, key: "video_generation" },
        },
      });
      expect(storedEntitlement.value).toBe(true);

      const profile = await api("GET", "profile", { userId });
      expectOk(profile);
      expect(profile.data.entitlements.video_generation).toBe(false);
      expect(profile.data.subscription.plan.features.videoGeneration).toBe(
        false,
      );

      const viewer = await api("GET", "me", { userId });
      expectOk(viewer);
      expect(viewer.data.entitlements.video_generation).toBe(false);

      const generationConfig = await api("GET", "generation/config", {
        userId,
        ageGate: true,
      });
      expectOk(generationConfig);
      expect(generationConfig.data.video.availability).toEqual({
        state: "unavailable",
        reason: "feature_disabled",
      });
      expect(generationConfig.data.entitlements.video_generation).toBe(false);
    } finally {
      await prisma.featureFlag.update({
        where: { key: "video_gen" },
        data: videoFlag,
      });
    }
  });

  it("markets video only from the authoritative Character I2V route", async () => {
    const planId = await setupPlan("alternate-video-profile");
    const alternateProfileId = `${P}alternate-video-profile`;
    const [videoFlag, productionProfile] = await Promise.all([
      prisma.featureFlag.findUniqueOrThrow({
        where: { key: "video_gen" },
        select: { enabled: true, rolloutPercent: true },
      }),
      prisma.generationModelProfile.findUniqueOrThrow({
        where: { id: "seed-profile-video-beta-v1" },
        select: { enabled: true, rolloutPercent: true },
      }),
    ]);

    await prisma.featureFlag.update({
      where: { key: "video_gen" },
      data: { enabled: true, rolloutPercent: 100 },
    });
    await prisma.generationModelProfile.update({
      where: { id: "seed-profile-video-beta-v1" },
      data: { rolloutPercent: 100 },
    });

    const productionPlans = await api("GET", "plans");
    expectOk(productionPlans);
    expect(
      productionPlans.data.items.find(
        (item: { id: string }) => item.id === planId,
      )?.features,
    ).toMatchObject({ videoGeneration: true });

    await prisma.generationModelProfile.update({
      where: { id: "seed-profile-video-beta-v1" },
      data: { rolloutPercent: 0 },
    });
    await prisma.generationModelProfile.create({
      data: {
        id: alternateProfileId,
        profileKey: alternateProfileId,
        label: "Alternate video route",
        mode: "video",
        runner: "comfyui",
        pipelineModel: "alternate-video",
        allowedOrientations: ["2:3"],
        maxCount: 1,
        enabled: true,
        rolloutPercent: 100,
        status: "active",
      },
    });

    try {
      const plans = await api("GET", "plans");
      expectOk(plans);
      expect(
        plans.data.items.find((item: { id: string }) => item.id === planId)
          ?.features,
      ).toMatchObject({ videoGeneration: false });
    } finally {
      await prisma.generationModelProfile.delete({
        where: { id: alternateProfileId },
      });
      await prisma.generationModelProfile.update({
        where: { id: "seed-profile-video-beta-v1" },
        data: productionProfile,
      });
      await prisma.featureFlag.update({
        where: { key: "video_gen" },
        data: videoFlag,
      });
    }
  });
});

describe("checkout (auto-confirm) activates entitlements + grants coins", () => {
  it("requires a bounded Idempotency-Key before creating a durable intent", async () => {
    const userId = await setupUser("missing-key");
    const planId = await setupPlan("missing-key");

    const missing = await api("POST", "billing/checkout", {
      userId,
      body: { planId, autoConfirm: false },
    });
    expect(missing.status).toBe(400);
    expect(missing.error?.message).toContain("Idempotency-Key");
    expect(await prisma.checkoutSession.count({ where: { userId } })).toBe(0);
  });

  it("activates a subscription, derives entitlements, and grants included dreamcoins", async () => {
    const userId = await setupUser("checkout");
    const planId = await setupPlan("checkout", 1000);

    const checkout = await checkoutApi(userId, { planId, autoConfirm: true });
    expectOk(checkout);
    expect(checkout.data.subscription).toMatchObject({ status: "active", planId });
    expect(checkout.data.billingAccess).toMatchObject({
      provider: "mock",
      billingModel: "prepaid_period",
      renewalCapability: "none",
      renewsAt: null,
    });
    expect(checkout.data.billingAccess.benefitsEndAt).toEqual(
      expect.any(String),
    );

    const me = await api("GET", "me", { userId });
    expect(me.data.dreamcoins.balance).toBe(1000);
    expect(me.data.entitlements).toMatchObject({
      premium_controls: true,
      video_generation: true,
      // camelCase plan feature → snake_case entitlement; gates on-demand voice.
      voice_enabled: true,
      custom_prompt: true,
    });
    await expect(
      prisma.entitlement.findUniqueOrThrow({
        where: { userId_key: { userId, key: "video_generation" } },
        select: { value: true },
      }),
    ).resolves.toEqual({ value: true });
    expect(
      await prisma.analyticsEvent.count({
        where: { userId, name: "subscription_started" },
      }),
    ).toBe(1);
    const subscription = await prisma.subscription.findFirstOrThrow({ where: { userId } });
    expect(
      await prisma.analyticsEvent.count({
        where: {
          userId,
          name: "subscription.activated.v2",
          sourceEventId: `subscription:${subscription.id}:activated`,
        },
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

    const idempotencyKey = `${P}repeat-checkout-key`;
    const first = await checkoutApi(
      userId,
      { planId, autoConfirm: true },
      idempotencyKey,
    );
    expectOk(first);
    expect(first.data.subscription).toMatchObject({ status: "active", planId });
    expect(await dreamcoinBalance(userId)).toBe(1000);

    // Replaying checkout must not mint coins again or stack a second subscription.
    const second = await checkoutApi(
      userId,
      { planId, autoConfirm: true },
      idempotencyKey,
    );
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

  it("converges concurrent same-key requests to one provider invoice", async () => {
    const userId = await setupUser("concurrent");
    const planId = await setupPlan("concurrent", 900);
    const idempotencyKey = `${P}concurrent-checkout-key`;
    const createInvoice = vi.spyOn(providers.payment, "createInvoice");

    try {
      const [first, second] = await Promise.all([
        checkoutApi(
          userId,
          { planId, autoConfirm: false },
          idempotencyKey,
        ),
        checkoutApi(
          userId,
          { planId, autoConfirm: false },
          idempotencyKey,
        ),
      ]);
      expectOk(first);
      expectOk(second);
      expect(first.data.invoice.invoiceId).toBe(second.data.invoice.invoiceId);
      expect(createInvoice).toHaveBeenCalledTimes(1);
      expect(
        await prisma.checkoutSession.count({ where: { userId } }),
      ).toBe(1);
    } finally {
      createInvoice.mockRestore();
    }
  });

  it("rejects reuse of the same key for a different checkout request", async () => {
    const userId = await setupUser("key-conflict");
    const planId = await setupPlan("key-conflict");
    const idempotencyKey = `${P}checkout-conflict-key`;
    expectOk(
      await checkoutApi(
        userId,
        { planId, autoConfirm: false, returnPath: "/profile" },
        idempotencyKey,
      ),
    );

    const conflict = await checkoutApi(
      userId,
      { planId, autoConfirm: false, returnPath: "/generate" },
      idempotencyKey,
    );
    expect(conflict.status).toBe(409);
    expect(conflict.error?.code).toBe("conflict");
    expect(conflict.error?.details).toMatchObject({
      idempotencyAction: "new_key",
    });
    expect(await prisma.checkoutSession.count({ where: { userId } })).toBe(1);
  });

  it("tells a concurrent checkout replay to retain the same key", async () => {
    const userId = await setupUser("dispatch-in-progress-contract");
    const planId = await setupPlan("dispatch-in-progress-contract");
    const idempotencyKey = `${P}dispatch-in-progress-contract-key`;
    const created = await checkoutApi(
      userId,
      { planId, autoConfirm: false },
      idempotencyKey,
    );
    expectOk(created);
    await prisma.checkoutSession.update({
      where: { id: created.data.checkout.id as string },
      data: {
        providerSessionId: null,
        checkoutUrl: null,
        providerInvoiceStatus: null,
        status: "provider_dispatching",
        dispatchToken: `${P}dispatch-in-progress-token`,
        dispatchLeaseUntil: new Date(Date.now() + 10_000),
      },
    });

    const replay = await checkoutApi(
      userId,
      { planId, autoConfirm: false },
      idempotencyKey,
    );
    expect(replay.status).toBe(409);
    expect(replay.error?.details).toMatchObject({
      checkoutId: created.data.checkout.id,
      idempotencyAction: "same_key",
    });
  });

  it("replays from the durable price snapshot after the mutable plan changes", async () => {
    const userId = await setupUser("plan-replay");
    const planId = await setupPlan("plan-replay", 725);
    const idempotencyKey = `${P}plan-replay-key`;
    const first = await checkoutApi(
      userId,
      { planId, autoConfirm: false },
      idempotencyKey,
    );
    expectOk(first);

    await prisma.plan.update({
      where: { id: planId },
      data: { active: false, priceCents: 999_999, includedDreamcoins: 1 },
    });
    const replay = await checkoutApi(
      userId,
      { planId, autoConfirm: false },
      idempotencyKey,
    );
    expectOk(replay);
    expect(replay.data.invoice.invoiceId).toBe(first.data.invoice.invoiceId);
    const intent = await prisma.checkoutSession.findFirstOrThrow({
      where: { userId, idempotencyKey },
    });
    expect(intent.amountCents).not.toBe(999_999);
    expect(intent.offerSnapshot).toMatchObject({
      planId,
      includedDreamcoins: 725,
    });
    expect(replay.data.checkout).not.toHaveProperty("idempotencyKey");
    expect(replay.data.checkout).not.toHaveProperty("requestHash");
    expect(replay.data.checkout).not.toHaveProperty("dispatchToken");
  });

  it("recovers an ambiguous provider attempt by lookup without a second POST", async () => {
    const userId = await setupUser("ambiguous-recovery");
    const planId = await setupPlan("ambiguous-recovery", 640);
    const idempotencyKey = `${P}ambiguous-recovery-key`;
    const createInvoice = vi
      .spyOn(providers.payment, "createInvoice")
      .mockResolvedValue({
        ok: false,
        error: {
          code: "invoice_create_timeout",
          message: "provider response was lost",
          retryable: true,
        },
      });
    const lookup = vi
      .spyOn(providers.payment, "findInvoiceByOrderId")
      .mockResolvedValueOnce({ ok: true, data: null })
      .mockResolvedValueOnce({ ok: true, data: null });

    try {
      const ambiguous = await checkoutApi(
        userId,
        { planId, autoConfirm: false },
        idempotencyKey,
      );
      expect(ambiguous.status).toBe(503);
      const intent = await prisma.checkoutSession.findFirstOrThrow({
        where: { userId, idempotencyKey },
      });
      expect(intent).toMatchObject({
        status: "provider_unknown",
        needsReconciliation: true,
      });

      const invoice = {
        provider: "mock" as const,
        invoiceId: `${P}recovered-invoice`,
        checkoutUrl: `https://mock-payments.idream.local/invoices/${P}recovered-invoice`,
        status: "settled" as const,
        additionalStatus: "none" as const,
        orderId: intent.id,
        amountCents: 1999,
        currency: "usd",
      };
      lookup.mockResolvedValueOnce({ ok: true, data: invoice });
      const settled = await api("POST", "billing/webhooks/mock", {
        headers: { "x-provider-event-id": `${P}evt-webhook-first` },
        body: {
          invoiceId: invoice.invoiceId,
          orderId: intent.id,
          providerEventId: `${P}evt-webhook-first`,
        },
      });
      expectOk(settled);

      const recovered = await checkoutApi(
        userId,
        { planId, autoConfirm: false },
        idempotencyKey,
      );
      expectOk(recovered);
      expect(recovered.data.checkout.status).toBe("completed");
      expect(recovered.data.invoice.invoiceId).toBe(invoice.invoiceId);
      expect(recovered.data.subscription).toMatchObject({
        userId,
        planId,
        status: "active",
      });
      expect(createInvoice).toHaveBeenCalledTimes(1);
      expect(lookup).toHaveBeenCalledTimes(3);
      expect(await dreamcoinBalance(userId)).toBe(640);
    } finally {
      createInvoice.mockRestore();
      lookup.mockRestore();
    }
  });

  it("never re-POSTs after a committed dispatch marker survives a crash", async () => {
    const userId = await setupUser("dispatch-marker-crash");
    const planId = await setupPlan("dispatch-marker-crash", 635);
    const checkoutId = `${P}dispatch-marker-crash-checkout`;
    const idempotencyKey = `${P}dispatch-marker-crash-key`;
    await createDurableCheckoutIntent({
      checkoutId,
      idempotencyKey,
      planId,
      userId,
    });
    const providerAttemptedAt = new Date(Date.now() - 5_000);
    await prisma.checkoutSession.update({
      where: { id: checkoutId },
      data: {
        status: "provider_dispatching",
        dispatchToken: `${P}dispatch-marker-crash-token`,
        dispatchLeaseUntil: new Date(Date.now() - 1_000),
        providerAttemptedAt,
      },
    });
    const lookup = vi
      .spyOn(providers.payment, "findInvoiceByOrderId")
      .mockResolvedValue({ ok: true, data: null });
    const createInvoice = vi.spyOn(providers.payment, "createInvoice");

    try {
      const replay = await checkoutApi(
        userId,
        { planId, autoConfirm: false },
        idempotencyKey,
      );
      expect(replay.status).toBe(503);
      expect(createInvoice).not.toHaveBeenCalled();
      expect(lookup).toHaveBeenCalledTimes(1);
      await expect(
        prisma.checkoutSession.findUniqueOrThrow({
          where: { id: checkoutId },
          select: {
            status: true,
            dispatchToken: true,
            dispatchLeaseUntil: true,
            providerAttemptedAt: true,
            providerSessionId: true,
            providerLookupMissCount: true,
            needsReconciliation: true,
          },
        }),
      ).resolves.toEqual({
        status: "provider_unknown",
        dispatchToken: null,
        dispatchLeaseUntil: null,
        providerAttemptedAt,
        providerSessionId: null,
        providerLookupMissCount: 1,
        needsReconciliation: true,
      });
    } finally {
      createInvoice.mockRestore();
      lookup.mockRestore();
    }
  });

  it("aborts a slow provider request without holding the user database lock", async () => {
    const userId = await setupUser("provider-request-deadline");
    const planId = await setupPlan("provider-request-deadline", 625);
    const checkoutId = `${P}provider-request-deadline-checkout`;
    const idempotencyKey = `${P}provider-request-deadline-key`;
    await createDurableCheckoutIntent({
      checkoutId,
      idempotencyKey,
      planId,
      userId,
    });

    let signalCreateStarted: (() => void) | undefined;
    const createStarted = new Promise<void>((resolve) => {
      signalCreateStarted = resolve;
    });
    let aborted = false;
    const lookup = vi
      .spyOn(providers.payment, "findInvoiceByOrderId")
      .mockResolvedValue({ ok: true, data: null });
    const createInvoice = vi
      .spyOn(providers.payment, "createInvoice")
      .mockImplementation(
        ({ signal }) =>
          new Promise((resolve) => {
            signalCreateStarted?.();
            const onAbort = () => {
              aborted = true;
              resolve({
                ok: false,
                error: {
                  code: "payment_request_aborted",
                  message: "provider request aborted",
                  retryable: true,
                },
              });
            };
            if (signal?.aborted) {
              onAbort();
              return;
            }
            signal?.addEventListener("abort", onAbort, { once: true });
          }),
      );
    let replay: ReturnType<typeof checkoutApi> | undefined;
    let lockProbe: Promise<"acquired"> | undefined;

    try {
      const startedAt = Date.now();
      replay = checkoutApi(
        userId,
        { planId, autoConfirm: false },
        idempotencyKey,
      );
      await createStarted;

      lockProbe = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "users" WHERE id = ${userId} FOR UPDATE`;
        return "acquired" as const;
      });
      const lockState = await Promise.race([
        lockProbe,
        new Promise<"blocked">((resolve) =>
          setTimeout(() => resolve("blocked"), 400),
        ),
      ]);
      expect(lockState).toBe("acquired");

      const result = await replay;
      expect(result.status).toBe(503);
      expect(Date.now() - startedAt).toBeLessThan(3_000);
      expect(aborted).toBe(true);
      expect(createInvoice).toHaveBeenCalledTimes(1);
      expect(lookup).toHaveBeenCalledTimes(2);
      await expect(
        prisma.checkoutSession.findUniqueOrThrow({
          where: { id: checkoutId },
          select: {
            status: true,
            dispatchToken: true,
            dispatchLeaseUntil: true,
            providerSessionId: true,
            needsReconciliation: true,
          },
        }),
      ).resolves.toEqual({
        status: "provider_unknown",
        dispatchToken: null,
        dispatchLeaseUntil: null,
        providerSessionId: null,
        needsReconciliation: true,
      });
    } finally {
      await Promise.allSettled([
        ...(replay ? [replay] : []),
        ...(lockProbe ? [lockProbe] : []),
      ]);
      createInvoice.mockRestore();
      lookup.mockRestore();
    }
  });

  it("does not let a stale null lookup overwrite a concurrently bound invoice", async () => {
    const userId = await setupUser("stale-null-after-bind");
    const planId = await setupPlan("stale-null-after-bind", 615);
    const idempotencyKey = `${P}stale-null-after-bind-key`;
    const createInvoice = vi
      .spyOn(providers.payment, "createInvoice")
      .mockResolvedValue({
        ok: false,
        error: {
          code: "invoice_create_timeout",
          message: "provider response was lost",
          retryable: true,
        },
      });
    const lookup = vi
      .spyOn(providers.payment, "findInvoiceByOrderId")
      .mockResolvedValueOnce({ ok: true, data: null })
      .mockResolvedValueOnce({ ok: true, data: null });

    try {
      expect(
        (
          await checkoutApi(
            userId,
            { planId, autoConfirm: false },
            idempotencyKey,
          )
        ).status,
      ).toBe(503);
      const intent = await prisma.checkoutSession.findFirstOrThrow({
        where: { userId, idempotencyKey },
      });
      const invoice = {
        provider: "mock" as const,
        invoiceId: `${P}stale-null-after-bind-invoice`,
        checkoutUrl: `https://mock-payments.idream.local/invoices/${P}stale-null-after-bind-invoice`,
        status: "created" as const,
        additionalStatus: "none" as const,
        orderId: intent.id,
        amountCents: 1999,
        currency: "usd",
      };
      let releaseStaleLookup: ((value: {
        ok: true;
        data: null;
      }) => void) | undefined;
      const staleLookup = new Promise<{ ok: true; data: null }>((resolve) => {
        releaseStaleLookup = resolve;
      });
      let signalLookupStarted: (() => void) | undefined;
      const lookupStarted = new Promise<void>((resolve) => {
        signalLookupStarted = resolve;
      });
      lookup
        .mockImplementationOnce(async () => {
          signalLookupStarted?.();
          return staleLookup;
        })
        .mockResolvedValueOnce({ ok: true, data: invoice });

      const staleRequest = checkoutApi(
        userId,
        { planId, autoConfirm: false },
        idempotencyKey,
      );
      await lookupStarted;
      const boundRequest = await checkoutApi(
        userId,
        { planId, autoConfirm: false },
        idempotencyKey,
      );
      expectOk(boundRequest);
      releaseStaleLookup?.({ ok: true, data: null });
      const converged = await staleRequest;
      expectOk(converged);
      expect(converged.data.invoice.invoiceId).toBe(invoice.invoiceId);
      await expect(
        prisma.checkoutSession.findUniqueOrThrow({
          where: { id: intent.id },
          select: {
            failureCode: true,
            needsReconciliation: true,
            providerInvoiceStatus: true,
            providerLookupMissCount: true,
            providerSessionId: true,
            status: true,
          },
        }),
      ).resolves.toEqual({
        failureCode: null,
        needsReconciliation: false,
        providerInvoiceStatus: "created",
        providerLookupMissCount: 0,
        providerSessionId: invoice.invoiceId,
        status: "created",
      });
    } finally {
      createInvoice.mockRestore();
      lookup.mockRestore();
    }
  });

  it("terminates a missing provider attempt after the grace window and repeated authoritative misses", async () => {
    const userId = await setupUser("missing-after-grace");
    const planId = await setupPlan("missing-after-grace");
    const idempotencyKey = `${P}missing-after-grace-key`;
    const createInvoice = vi
      .spyOn(providers.payment, "createInvoice")
      .mockResolvedValue({
        ok: false,
        error: {
          code: "invoice_create_timeout",
          message: "provider response was lost",
          retryable: true,
        },
      });
    const lookup = vi
      .spyOn(providers.payment, "findInvoiceByOrderId")
      .mockResolvedValue({ ok: true, data: null });

    try {
      expect(
        (
          await checkoutApi(
            userId,
            { planId, autoConfirm: false },
            idempotencyKey,
          )
        ).status,
      ).toBe(503);
      const intent = await prisma.checkoutSession.findFirstOrThrow({
        where: { userId, idempotencyKey },
      });
      await prisma.checkoutSession.update({
        where: { id: intent.id },
        data: {
          providerAttemptedAt: new Date(Date.now() - 31 * 60 * 1_000),
          providerLookupMissCount: 2,
        },
      });

      const terminal = await checkoutApi(
        userId,
        { planId, autoConfirm: false },
        idempotencyKey,
      );
      expect(terminal.status).toBe(409);
      expect(terminal.error?.details).toMatchObject({
        checkoutId: intent.id,
        idempotencyAction: "new_key",
      });
      await expect(
        prisma.checkoutSession.findUniqueOrThrow({
          where: { id: intent.id },
          select: {
            failureCode: true,
            needsReconciliation: true,
            providerLookupMissCount: true,
            status: true,
          },
        }),
      ).resolves.toEqual({
        failureCode: "provider_invoice_not_found_after_grace",
        needsReconciliation: false,
        providerLookupMissCount: 3,
        status: "canceled",
      });
      expect(createInvoice).toHaveBeenCalledTimes(1);
    } finally {
      createInvoice.mockRestore();
      lookup.mockRestore();
    }
  });

  it("quarantines a settled provider result that races with terminal abandonment", async () => {
    const userId = await setupUser("settled-races-terminal");
    const planId = await setupPlan("settled-races-terminal", 777);
    const idempotencyKey = `${P}settled-races-terminal-key`;
    const createInvoice = vi
      .spyOn(providers.payment, "createInvoice")
      .mockResolvedValue({
        ok: false,
        error: {
          code: "invoice_create_timeout",
          message: "provider response was lost",
          retryable: true,
        },
      });
    const lookup = vi
      .spyOn(providers.payment, "findInvoiceByOrderId")
      .mockResolvedValueOnce({ ok: true, data: null })
      .mockResolvedValueOnce({ ok: true, data: null });

    try {
      expect(
        (
          await checkoutApi(
            userId,
            { planId, autoConfirm: false },
            idempotencyKey,
          )
        ).status,
      ).toBe(503);
      const intent = await prisma.checkoutSession.findFirstOrThrow({
        where: { userId, idempotencyKey },
      });
      await prisma.checkoutSession.update({
        where: { id: intent.id },
        data: {
          providerAttemptedAt: new Date(Date.now() - 31 * 60 * 1_000),
          providerLookupMissCount: 2,
        },
      });
      const invoice = {
        provider: "mock" as const,
        invoiceId: `${P}settled-races-terminal-invoice`,
        checkoutUrl: `https://mock-payments.idream.local/invoices/${P}settled-races-terminal-invoice`,
        status: "settled" as const,
        additionalStatus: "none" as const,
        orderId: intent.id,
        amountCents: 1999,
        currency: "usd",
      };
      let releaseSettledLookup: ((value: {
        ok: true;
        data: typeof invoice;
      }) => void) | undefined;
      const settledLookup = new Promise<{
        ok: true;
        data: typeof invoice;
      }>((resolve) => {
        releaseSettledLookup = resolve;
      });
      let signalLookupStarted: (() => void) | undefined;
      const lookupStarted = new Promise<void>((resolve) => {
        signalLookupStarted = resolve;
      });
      lookup
        .mockImplementationOnce(async () => {
          signalLookupStarted?.();
          return settledLookup;
        })
        .mockResolvedValueOnce({ ok: true, data: null });

      const recoveredRequest = checkoutApi(
        userId,
        { planId, autoConfirm: false },
        idempotencyKey,
      );
      await lookupStarted;
      const terminalRequest = await checkoutApi(
        userId,
        { planId, autoConfirm: false },
        idempotencyKey,
      );
      expect(terminalRequest.status).toBe(409);
      releaseSettledLookup?.({ ok: true, data: invoice });
      const recovered = await recoveredRequest;
      expect(recovered.status).toBe(503);

      await expect(
        prisma.checkoutSession.findUniqueOrThrow({
          where: { id: intent.id },
          select: {
            failureCode: true,
            needsReconciliation: true,
            providerInvoiceStatus: true,
            providerSessionId: true,
            status: true,
          },
        }),
      ).resolves.toEqual({
        failureCode: "provider_invoice_settled_after_abandonment",
        needsReconciliation: true,
        providerInvoiceStatus: "settled",
        providerSessionId: invoice.invoiceId,
        status: "provider_unknown",
      });
      expect(await dreamcoinBalance(userId)).toBe(0);
      expect(
        await prisma.subscription.count({ where: { userId } }),
      ).toBe(0);

      const webhook = await api("POST", "billing/webhooks/mock", {
        headers: {
          "x-provider-event-id": `${P}settled-races-terminal-event`,
        },
        body: {
          invoiceId: invoice.invoiceId,
          orderId: intent.id,
          providerEventId: `${P}settled-races-terminal-event`,
        },
      });
      expectOk(webhook);
      expect(webhook.data).toMatchObject({
        processed: true,
        reconciliationRequired: true,
      });
      expect(await dreamcoinBalance(userId)).toBe(0);
    } finally {
      createInvoice.mockRestore();
      lookup.mockRestore();
    }
  });

  it("keeps completed provider status monotonic when a stale recovery says created", async () => {
    const userId = await setupUser("completed-recovery-monotonic");
    const planId = await setupPlan("completed-recovery-monotonic", 321);
    const idempotencyKey = `${P}completed-recovery-monotonic-key`;
    const completed = await checkoutApi(
      userId,
      { planId, autoConfirm: true },
      idempotencyKey,
    );
    expectOk(completed);
    const checkoutId = completed.data.checkout.id as string;
    const invoiceId = completed.data.invoice.invoiceId as string;
    await prisma.checkoutSession.update({
      where: { id: checkoutId },
      data: { checkoutUrl: null },
    });
    const lookup = vi
      .spyOn(providers.payment, "findInvoiceByOrderId")
      .mockResolvedValue({
        ok: true,
        data: {
          provider: "mock",
          invoiceId,
          checkoutUrl: `https://mock-payments.idream.local/invoices/${invoiceId}`,
          status: "created",
          additionalStatus: "none",
          orderId: checkoutId,
          amountCents: 1999,
          currency: "usd",
        },
      });

    try {
      expectOk(
        await checkoutApi(
          userId,
          { planId, autoConfirm: true },
          idempotencyKey,
        ),
      );
      await expect(
        prisma.checkoutSession.findUniqueOrThrow({
          where: { id: checkoutId },
          select: { providerInvoiceStatus: true, status: true },
        }),
      ).resolves.toEqual({
        providerInvoiceStatus: "settled",
        status: "completed",
      });
    } finally {
      lookup.mockRestore();
    }
  });

  it("uses a calendar year for yearly subscription authority", async () => {
    const userId = await setupUser("yearly-period");
    const planId = await setupPlan("yearly-period", 1200, "yearly");
    const before = Date.now();
    expectOk(
      await checkoutApi(userId, {
        planId,
        autoConfirm: true,
      }),
    );
    const after = Date.now();
    const subscription = await prisma.subscription.findFirstOrThrow({
      where: { userId, planId, status: "active" },
    });
    const minimum = before + 364 * 24 * 60 * 60 * 1_000;
    const maximum = after + 367 * 24 * 60 * 60 * 1_000;
    expect(subscription.currentPeriodEnd?.getTime()).toBeGreaterThanOrEqual(
      minimum,
    );
    expect(subscription.currentPeriodEnd?.getTime()).toBeLessThanOrEqual(
      maximum,
    );
  });

  it("activates a settled invoice discovered during order-id recovery", async () => {
    const userId = await setupUser("settled-recovery");
    const planId = await setupPlan("settled-recovery", 510);
    const createInvoice = vi.spyOn(providers.payment, "createInvoice");
    const lookup = vi
      .spyOn(providers.payment, "findInvoiceByOrderId")
      .mockImplementation(async ({ orderId }) => ({
        ok: true,
        data: {
          provider: "mock",
          invoiceId: `${P}settled-recovery-invoice`,
          checkoutUrl: `https://mock-payments.idream.local/invoices/${P}settled-recovery-invoice`,
          status: "settled",
          additionalStatus: "none",
          orderId,
          amountCents: 1999,
          currency: "usd",
        },
      }));

    try {
      const checkout = await checkoutApi(
        userId,
        { planId, autoConfirm: false },
        `${P}settled-recovery-key`,
      );
      expectOk(checkout);
      expect(checkout.data.checkout.status).toBe("completed");
      expect(checkout.data.invoice.status).toBe("settled");
      expect(checkout.data.subscription).toMatchObject({
        userId,
        planId,
        status: "active",
      });
      expect(await dreamcoinBalance(userId)).toBe(510);
      expect(createInvoice).not.toHaveBeenCalled();
    } finally {
      createInvoice.mockRestore();
      lookup.mockRestore();
    }
  });

  it.each([
    ["expired", "none", 409, "expired", false],
    ["invalid", "none", 409, "canceled", false],
    ["expired", "paid_late", 503, "provider_unknown", true],
  ] as const)(
    "does not revive a %s / %s recovery invoice",
    async (
      providerStatus,
      additionalStatus,
      expectedHttpStatus,
      expectedCheckoutStatus,
      needsReconciliation,
    ) => {
      const suffix = `${providerStatus}-${additionalStatus}`;
      const userId = await setupUser(`terminal-recovery-${suffix}`);
      const planId = await setupPlan(`terminal-recovery-${suffix}`);
      const createInvoice = vi.spyOn(providers.payment, "createInvoice");
      const lookup = vi
        .spyOn(providers.payment, "findInvoiceByOrderId")
        .mockImplementation(async ({ orderId }) => ({
          ok: true,
          data: {
            provider: "mock",
            invoiceId: `${P}${suffix}-invoice`,
            checkoutUrl: `https://mock-payments.idream.local/invoices/${P}${suffix}-invoice`,
            status: providerStatus,
            additionalStatus,
            orderId,
            amountCents: 1999,
            currency: "usd",
          },
        }));

      try {
        const checkout = await checkoutApi(
          userId,
          { planId, autoConfirm: false },
          `${P}${suffix}-key`,
        );
        expect(checkout.status).toBe(expectedHttpStatus);
        const intent = await prisma.checkoutSession.findFirstOrThrow({
          where: { userId, idempotencyKey: `${P}${suffix}-key` },
        });
        expect(intent).toMatchObject({
          status: expectedCheckoutStatus,
          providerInvoiceStatus: providerStatus,
          providerInvoiceAdditionalStatus: additionalStatus,
          needsReconciliation,
        });
        expect(await prisma.subscription.count({ where: { userId } })).toBe(0);
        expect(createInvoice).not.toHaveBeenCalled();
      } finally {
        createInvoice.mockRestore();
        lookup.mockRestore();
      }
    },
  );

  it("rejects a new same-plan checkout before invoicing while prepaid access is active", async () => {
    const userId = await setupUser("active-prepaid");
    const planId = await setupPlan("active-prepaid", 1000);
    const benefitsEndAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const subscription = await prisma.subscription.create({
      data: {
        id: `${P}sub-active-prepaid`,
        userId,
        planId,
        provider: "mock",
        providerSubscriptionId: `${P}invoice-active-prepaid`,
        status: "active",
        currentPeriodEnd: benefitsEndAt,
      },
    });
    const createInvoice = vi.spyOn(providers.payment, "createInvoice");

    try {
      const checkout = await checkoutApi(userId, {
        planId,
        autoConfirm: true,
      });
      expect(checkout.status).toBe(409);
      expect(checkout.error?.details).toMatchObject({
        code: "active_prepaid_access_exists",
        idempotencyAction: "new_key",
        billingModel: "prepaid_period",
        renewalCapability: "none",
        benefitsEndAt: benefitsEndAt.toISOString(),
      });
      expect(createInvoice).not.toHaveBeenCalled();
      expect(
        await prisma.checkoutSession.count({ where: { userId } }),
      ).toBe(0);
      await expect(
        prisma.subscription.findUniqueOrThrow({
          where: { id: subscription.id },
          select: { status: true, currentPeriodEnd: true },
        }),
      ).resolves.toEqual({
        status: "active",
        currentPeriodEnd: benefitsEndAt,
      });
      expect(await dreamcoinBalance(userId)).toBe(0);
    } finally {
      createInvoice.mockRestore();
    }
  });

  it("rechecks active same-plan access before dispatching a replayed durable intent", async () => {
    const userId = await setupUser("durable-intent-active-gate");
    const planId = await setupPlan("durable-intent-active-gate", 630);
    const plan = await prisma.plan.findUniqueOrThrow({ where: { id: planId } });
    const idempotencyKey = `${P}durable-intent-active-gate-key`;
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify({
          selector: { planId },
          returnPath: "/profile",
          autoConfirm: false,
          provider: "mock",
        }),
      )
      .digest("hex");
    await prisma.checkoutSession.create({
      data: {
        id: `${P}durable-intent-active-gate-checkout`,
        userId,
        planId,
        provider: "mock",
        idempotencyKey,
        requestHash,
        amountCents: plan.priceCents,
        currency: plan.currency,
        offerSnapshot: {
          version: 1,
          planId,
          slug: plan.slug,
          name: plan.name,
          billingPeriod: plan.billingPeriod,
          priceCents: plan.priceCents,
          currency: plan.currency,
          includedDreamcoins: plan.includedDreamcoins,
          features: plan.features,
        },
        autoConfirm: false,
        returnPath: "/profile",
        status: "provider_pending",
      },
    });
    expectOk(
      await checkoutApi(
        userId,
        { planId, autoConfirm: true },
        `${P}durable-intent-active-authority`,
      ),
    );
    const createInvoice = vi.spyOn(providers.payment, "createInvoice");
    const findInvoice = vi.spyOn(providers.payment, "findInvoiceByOrderId");

    try {
      const [firstTab, secondTab] = await Promise.all([
        checkoutApi(
          userId,
          { planId, autoConfirm: false },
          idempotencyKey,
        ),
        checkoutApi(
          userId,
          { planId, autoConfirm: false },
          idempotencyKey,
        ),
      ]);
      for (const replay of [firstTab, secondTab]) {
        expect(replay.status).toBe(409);
        expect(replay.error?.details).toMatchObject({
          code: "active_prepaid_access_exists",
          idempotencyAction: "new_key",
        });
      }
      expect(findInvoice).not.toHaveBeenCalled();
      expect(createInvoice).not.toHaveBeenCalled();
      await expect(
        prisma.checkoutSession.findUniqueOrThrow({
          where: { id: `${P}durable-intent-active-gate-checkout` },
          select: {
            dispatchToken: true,
            providerAttemptedAt: true,
            providerSessionId: true,
            status: true,
          },
        }),
      ).resolves.toEqual({
        dispatchToken: null,
        providerAttemptedAt: null,
        providerSessionId: null,
        status: "provider_pending",
      });
    } finally {
      createInvoice.mockRestore();
      findInvoice.mockRestore();
    }
  });

  it("defers same-plan settlement while provider dispatch is in flight, then replays it", async () => {
    const userId = await setupUser("provider-dispatch-exclusion");
    const planId = await setupPlan("provider-dispatch-exclusion", 645);
    const plan = await prisma.plan.findUniqueOrThrow({ where: { id: planId } });
    const payable = await checkoutApi(
      userId,
      { planId, autoConfirm: false },
      `${P}provider-dispatch-exclusion-payable`,
    );
    expectOk(payable);

    const idempotencyKey = `${P}provider-dispatch-exclusion-replay`;
    const checkoutId = `${P}provider-dispatch-exclusion-checkout`;
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify({
          selector: { planId },
          returnPath: "/profile",
          autoConfirm: false,
          provider: "mock",
        }),
      )
      .digest("hex");
    await prisma.checkoutSession.create({
      data: {
        id: checkoutId,
        userId,
        planId,
        provider: "mock",
        idempotencyKey,
        requestHash,
        amountCents: plan.priceCents,
        currency: plan.currency,
        offerSnapshot: {
          version: 1,
          planId,
          slug: plan.slug,
          name: plan.name,
          billingPeriod: plan.billingPeriod,
          priceCents: plan.priceCents,
          currency: plan.currency,
          includedDreamcoins: plan.includedDreamcoins,
          features: plan.features,
        },
        autoConfirm: false,
        returnPath: "/profile",
        status: "provider_pending",
      },
    });

    const invoiceResult = {
      ok: true as const,
      data: {
        provider: "mock" as const,
        invoiceId: `${P}provider-dispatch-exclusion-invoice`,
        checkoutUrl:
          `https://mock-payments.idream.local/invoices/` +
          `${P}provider-dispatch-exclusion-invoice`,
        status: "created" as const,
        additionalStatus: "none" as const,
        orderId: checkoutId,
        amountCents: plan.priceCents,
        currency: plan.currency,
      },
    };
    let releaseCreate:
      | ((value: typeof invoiceResult) => void)
      | undefined;
    let signalCreateStarted: (() => void) | undefined;
    const createStarted = new Promise<void>((resolve) => {
      signalCreateStarted = resolve;
    });
    const deferredCreate = new Promise<typeof invoiceResult>((resolve) => {
      releaseCreate = resolve;
    });
    const findInvoice = vi
      .spyOn(providers.payment, "findInvoiceByOrderId")
      .mockResolvedValue({ ok: true, data: null });
    const createInvoice = vi
      .spyOn(providers.payment, "createInvoice")
      .mockImplementation(async () => {
        signalCreateStarted?.();
        return deferredCreate;
      });
    let replay:
      | ReturnType<typeof checkoutApi>
      | undefined;
    let settlement:
      | ReturnType<typeof api>
      | undefined;

    try {
      replay = checkoutApi(
        userId,
        { planId, autoConfirm: false },
        idempotencyKey,
      );
      await createStarted;
      settlement = api("POST", "billing/webhooks/mock", {
        headers: {
          "x-provider-event-id": `${P}provider-dispatch-exclusion-settled`,
        },
        body: {
          invoiceId: payable.data.invoice.invoiceId,
          providerEventId: `${P}provider-dispatch-exclusion-settled`,
        },
      });
      const deferredSettlement = await settlement;
      expect(deferredSettlement.status).toBe(503);
      expect(deferredSettlement.error?.message).toContain(
        "checkout intent is not available yet",
      );
      await expect(
        prisma.providerEvent.findUniqueOrThrow({
          where: {
            provider_providerEventId: {
              provider: "mock",
              providerEventId:
                `${P}provider-dispatch-exclusion-settled`,
            },
          },
          select: { processedAt: true },
        }),
      ).resolves.toEqual({ processedAt: null });

      releaseCreate?.(invoiceResult);
      expectOk(await replay);
      const replayedSettlement = await api(
        "POST",
        "billing/webhooks/mock",
        {
          headers: {
            "x-provider-event-id":
              `${P}provider-dispatch-exclusion-settled`,
          },
          body: {
            invoiceId: payable.data.invoice.invoiceId,
            providerEventId:
              `${P}provider-dispatch-exclusion-settled`,
          },
        },
      );
      expectOk(replayedSettlement);
      expect(replayedSettlement.data).toMatchObject({
        processed: true,
      });
      expect(createInvoice).toHaveBeenCalledTimes(1);
      await expect(
        prisma.checkoutSession.findUniqueOrThrow({
          where: { id: checkoutId },
          select: { providerSessionId: true, status: true },
        }),
      ).resolves.toEqual({
        providerSessionId: invoiceResult.data.invoiceId,
        status: "created",
      });
      expect(
        (
          await prisma.providerEvent.findUniqueOrThrow({
            where: {
              provider_providerEventId: {
                provider: "mock",
                providerEventId:
                  `${P}provider-dispatch-exclusion-settled`,
              },
            },
          })
        ).processedAt,
      ).toBeInstanceOf(Date);
    } finally {
      releaseCreate?.(invoiceResult);
      await Promise.allSettled([
        ...(replay ? [replay] : []),
        ...(settlement ? [settlement] : []),
      ]);
      createInvoice.mockRestore();
      findInvoice.mockRestore();
    }
  });

  it("expires stale active authority before allowing a new prepaid purchase", async () => {
    const userId = await setupUser("expired-prepaid");
    const planId = await setupPlan("expired-prepaid", 610);
    const oldSubscription = await prisma.subscription.create({
      data: {
        id: `${P}sub-expired-prepaid`,
        userId,
        planId,
        provider: "mock",
        providerSubscriptionId: `${P}invoice-expired-prepaid`,
        status: "active",
        currentPeriodEnd: new Date(Date.now() - 60_000),
      },
    });

    const checkout = await checkoutApi(userId, {
      planId,
      autoConfirm: true,
    });
    expectOk(checkout);
    expect(checkout.data.subscription.id).not.toBe(oldSubscription.id);
    expect(checkout.data.billingAccess).toMatchObject({
      billingModel: "prepaid_period",
      renewsAt: null,
    });
    await expect(
      prisma.subscription.findUniqueOrThrow({
        where: { id: oldSubscription.id },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: "expired" });
    expect(
      await prisma.subscription.count({
        where: { userId, status: "active" },
      }),
    ).toBe(1);
    expect(await dreamcoinBalance(userId)).toBe(610);
  });

  it("creates an invoice without activating when auto-confirm is false", async () => {
    const userId = await setupUser("manual-checkout");
    const planId = await setupPlan("manual-checkout", 1000);

    const checkout = await checkoutApi(userId, { planId, autoConfirm: false });
    expectOk(checkout);
    expect(checkout.data).toMatchObject({
      billing: {
        provider: "mock",
        demoMode: true,
        autoConfirmAvailable: true,
        billingModel: "prepaid_period",
        renewalCapability: "none",
      },
      subscription: null,
      billingAccess: null,
    });
    expect(checkout.data.invoice.checkoutUrl).toContain("mock-payments.idream.local");
    expect(await dreamcoinBalance(userId)).toBe(0);
    expect(await prisma.subscription.count({ where: { userId } })).toBe(0);
  });

  it("treats distinct settled invoices as distinct prepaid purchases", async () => {
    const userId = await setupUser("distinct-invoices");
    const planId = await setupPlan("distinct-invoices", 425);
    const firstCheckout = await checkoutApi(
      userId,
      { planId, autoConfirm: false },
      `${P}distinct-invoices-first`,
    );
    const secondCheckout = await checkoutApi(
      userId,
      { planId, autoConfirm: false },
      `${P}distinct-invoices-second`,
    );
    expectOk(firstCheckout);
    expectOk(secondCheckout);
    const firstInvoiceId = firstCheckout.data.invoice.invoiceId as string;
    const secondInvoiceId = secondCheckout.data.invoice.invoiceId as string;
    expect(secondInvoiceId).not.toBe(firstInvoiceId);

    expectOk(
      await api("POST", "billing/webhooks/mock", {
        headers: { "x-provider-event-id": `${P}distinct-first-settled` },
        body: {
          invoiceId: firstInvoiceId,
          providerEventId: `${P}distinct-first-settled`,
        },
      }),
    );
    const firstAccess = await prisma.subscription.findFirstOrThrow({
      where: {
        userId,
        provider: "mock",
        providerSubscriptionId: firstInvoiceId,
      },
    });

    expectOk(
      await api("POST", "billing/webhooks/mock", {
        headers: { "x-provider-event-id": `${P}distinct-second-settled` },
        body: {
          invoiceId: secondInvoiceId,
          providerEventId: `${P}distinct-second-settled`,
        },
      }),
    );
    const secondAccess = await prisma.subscription.findFirstOrThrow({
      where: {
        userId,
        provider: "mock",
        providerSubscriptionId: secondInvoiceId,
      },
    });

    expect(firstAccess.status).toBe("active");
    await expect(
      prisma.subscription.findUniqueOrThrow({
        where: { id: firstAccess.id },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: "canceled" });
    expect(secondAccess.status).toBe("active");
    expect(secondAccess.currentPeriodEnd?.getTime()).toBeGreaterThan(
      firstAccess.currentPeriodEnd?.getTime() ?? 0,
    );
    expect(
      (secondAccess.currentPeriodEnd?.getTime() ?? 0) -
        (firstAccess.currentPeriodEnd?.getTime() ?? 0),
    ).toBeGreaterThan(27 * 24 * 60 * 60 * 1_000);
    expect(await dreamcoinBalance(userId)).toBe(850);
    expect(await prisma.subscription.count({ where: { userId } })).toBe(2);
  });

  it("applies a late older different-plan settlement without downgrading newer prepaid access", async () => {
    const userId = await setupUser("late-older-plan");
    const oldPlanId = await setupPlan("late-older-plan-old", 410);
    const newPlanId = await setupPlan("late-older-plan-new", 920);
    await prisma.plan.update({
      where: { id: oldPlanId },
      data: {
        name: "Older Premium",
        features: {
          unlimitedMessages: true,
          imageGeneration: true,
          videoGeneration: false,
          voiceEnabled: false,
          customPrompt: false,
        },
      },
    });
    await prisma.plan.update({
      where: { id: newPlanId },
      data: {
        name: "Newer Deluxe",
        features: {
          unlimitedMessages: true,
          imageGeneration: true,
          videoGeneration: true,
          voiceEnabled: true,
          customPrompt: true,
        },
      },
    });

    const olderCheckout = await checkoutApi(
      userId,
      { planId: oldPlanId, autoConfirm: false },
      `${P}late-older-plan-intent`,
    );
    expectOk(olderCheckout);
    const newerCheckout = await checkoutApi(
      userId,
      { planId: newPlanId, autoConfirm: true },
      `${P}late-newer-plan-intent`,
    );
    expectOk(newerCheckout);
    const newerAccessBefore = await prisma.subscription.findFirstOrThrow({
      where: { userId, status: "active" },
    });
    expect(newerAccessBefore.planId).toBe(newPlanId);
    const newerEndBefore = newerAccessBefore.currentPeriodEnd?.getTime() ?? 0;

    const settled = await api("POST", "billing/webhooks/mock", {
      headers: { "x-provider-event-id": `${P}late-older-plan-settled` },
      body: {
        invoiceId: olderCheckout.data.invoice.invoiceId,
        providerEventId: `${P}late-older-plan-settled`,
      },
    });
    expectOk(settled);

    const active = await prisma.subscription.findMany({
      where: { userId, status: "active" },
    });
    expect(active).toHaveLength(1);
    expect(active[0]?.id).toBe(newerAccessBefore.id);
    expect(active[0]?.planId).toBe(newPlanId);
    expect(active[0]?.currentPeriodEnd?.getTime()).toBeGreaterThan(
      newerEndBefore + 27 * 24 * 60 * 60 * 1_000,
    );
    await expect(
      prisma.subscription.findFirstOrThrow({
        where: {
          provider: "mock",
          providerSubscriptionId: olderCheckout.data.invoice.invoiceId,
        },
        select: { planId: true, status: true },
      }),
    ).resolves.toEqual({
      planId: oldPlanId,
      status: "checkout_completed",
    });
    const me = await api("GET", "me", { userId });
    expect(me.data.entitlements).toMatchObject({
      custom_prompt: true,
      video_generation: true,
      voice_enabled: true,
    });
    await expect(
      prisma.entitlement.findUniqueOrThrow({
        where: { userId_key: { userId, key: "video_generation" } },
        select: { value: true },
      }),
    ).resolves.toEqual({ value: true });
    expect(await dreamcoinBalance(userId)).toBe(1_330);
    const replayedOlderCheckout = await checkoutApi(
      userId,
      { planId: oldPlanId, autoConfirm: false },
      `${P}late-older-plan-intent`,
    );
    expectOk(replayedOlderCheckout);
    expect(replayedOlderCheckout.data.subscription).toMatchObject({
      id: newerAccessBefore.id,
      planId: newPlanId,
      offerAuthority: "checkout_snapshot",
      plan: { name: "Newer Deluxe" },
    });
  });

  it("converts a cheaper late purchase into proportional newer-tier access", async () => {
    const userId = await setupUser("late-cheaper-plan");
    const oldPlanId = await setupPlan("late-cheaper-plan-old", 310);
    const newPlanId = await setupPlan("late-cheaper-plan-new", 940);
    await prisma.plan.update({
      where: { id: oldPlanId },
      data: { name: "Premium Value", priceCents: 1_000 },
    });
    await prisma.plan.update({
      where: { id: newPlanId },
      data: { name: "Deluxe Value", priceCents: 4_000 },
    });

    const olderCheckout = await checkoutApi(
      userId,
      { planId: oldPlanId, autoConfirm: false },
      `${P}late-cheaper-plan-intent`,
    );
    expectOk(olderCheckout);
    expectOk(
      await checkoutApi(
        userId,
        { planId: newPlanId, autoConfirm: true },
        `${P}late-costlier-plan-intent`,
      ),
    );
    const newerBefore = await prisma.subscription.findFirstOrThrow({
      where: { userId, status: "active" },
    });
    const endBefore = newerBefore.currentPeriodEnd?.getTime() ?? 0;

    expectOk(
      await api("POST", "billing/webhooks/mock", {
        headers: { "x-provider-event-id": `${P}late-cheaper-plan-settled` },
        body: {
          invoiceId: olderCheckout.data.invoice.invoiceId,
          providerEventId: `${P}late-cheaper-plan-settled`,
        },
      }),
    );

    const newerAfter = await prisma.subscription.findUniqueOrThrow({
      where: { id: newerBefore.id },
    });
    const convertedDuration =
      (newerAfter.currentPeriodEnd?.getTime() ?? 0) - endBefore;
    expect(newerAfter).toMatchObject({
      planId: newPlanId,
      status: "active",
    });
    expect(convertedDuration).toBeGreaterThan(
      6 * 24 * 60 * 60 * 1_000,
    );
    expect(convertedDuration).toBeLessThan(
      9 * 24 * 60 * 60 * 1_000,
    );
    expect(await dreamcoinBalance(userId)).toBe(1_250);
  });

  it.each([
    ["missing-provider-invoice", null],
    ["unmatched-provider-invoice", `${P}legacy-unmatched-provider-invoice`],
  ] as const)(
    "reconciles a late settlement when active access has %s authority",
    async (suffix, providerSubscriptionId) => {
      const userId = await setupUser(`legacy-active-${suffix}`);
      const oldPlanId = await setupPlan(`legacy-active-${suffix}-old`, 330);
      const activePlanId = await setupPlan(
        `legacy-active-${suffix}-current`,
        950,
      );
      const olderCheckout = await checkoutApi(
        userId,
        { planId: oldPlanId, autoConfirm: false },
        `${P}legacy-active-${suffix}-old-intent`,
      );
      expectOk(olderCheckout);
      const benefitsEndAt = new Date(
        Date.now() + 30 * 24 * 60 * 60 * 1_000,
      );
      const legacyAccess = await prisma.subscription.create({
        data: {
          id: `${P}legacy-active-${suffix}-subscription`,
          userId,
          planId: activePlanId,
          provider: "legacy-processor",
          providerSubscriptionId,
          status: "active",
          currentPeriodEnd: benefitsEndAt,
        },
      });
      await prisma.entitlement.create({
        data: {
          userId,
          key: "custom_prompt",
          value: true,
          source: "subscription",
          expiresAt: benefitsEndAt,
        },
      });

      const settled = await api("POST", "billing/webhooks/mock", {
        headers: {
          "x-provider-event-id": `${P}legacy-active-${suffix}-settled`,
        },
        body: {
          invoiceId: olderCheckout.data.invoice.invoiceId,
          providerEventId: `${P}legacy-active-${suffix}-settled`,
        },
      });
      expectOk(settled);
      expect(settled.data).toMatchObject({
        processed: true,
        reconciliationRequired: true,
      });
      await expect(
        prisma.subscription.findUniqueOrThrow({
          where: { id: legacyAccess.id },
          select: {
            currentPeriodEnd: true,
            planId: true,
            status: true,
          },
        }),
      ).resolves.toEqual({
        currentPeriodEnd: benefitsEndAt,
        planId: activePlanId,
        status: "active",
      });
      await expect(
        prisma.checkoutSession.findUniqueOrThrow({
          where: { id: olderCheckout.data.checkout.id as string },
          select: {
            failureCode: true,
            needsReconciliation: true,
            status: true,
          },
        }),
      ).resolves.toEqual({
        failureCode: "active_purchase_authority_unavailable",
        needsReconciliation: true,
        status: "provider_unknown",
      });
      await expect(
        prisma.entitlement.findUniqueOrThrow({
          where: {
            userId_key: { userId, key: "custom_prompt" },
          },
          select: { expiresAt: true, value: true },
        }),
      ).resolves.toEqual({
        expiresAt: benefitsEndAt,
        value: true,
      });
      expect(
        await prisma.subscription.count({
          where: {
            provider: "mock",
            providerSubscriptionId: olderCheckout.data.invoice.invoiceId,
          },
        }),
      ).toBe(0);
      expect(await dreamcoinBalance(userId)).toBe(0);
    },
  );
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
      billingAccess: null,
    });
  });

  it("derives public capabilities from the persisted provider, not the current environment", async () => {
    const userId = await setupUser("persisted-provider");
    const planId = await setupPlan("persisted-provider", 1000);
    await prisma.subscription.create({
      data: {
        id: `${P}sub-persisted-provider`,
        userId,
        planId,
        provider: "legacy-processor",
        providerSubscriptionId: `${P}invoice-persisted-provider`,
        status: "active",
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
      },
    });

    const profile = await api("GET", "profile", { userId });
    expectOk(profile);
    expect(profile.data.billingAccess).toMatchObject({
      provider: "legacy-processor",
      billingModel: "unknown",
      renewalCapability: "none",
      renewsAt: null,
    });
    const portal = await api("POST", "billing/portal", { userId });
    expectOk(portal);
    expect(portal.data.billingAccess).toMatchObject({
      provider: "legacy-processor",
      billingModel: "unknown",
      renewalCapability: "none",
      renewsAt: null,
    });
  });

  it("reports prepaid access and rejects renewal mutations without writing", async () => {
    const userId = await setupUser("portal-active");
    const planId = await setupPlan("portal-active", 1000);
    const checkout = await checkoutApi(userId, { planId, autoConfirm: true });
    expectOk(checkout);
    const before = await prisma.subscription.findFirstOrThrow({
      where: { userId, planId },
      select: {
        id: true,
        cancelAtPeriodEnd: true,
        currentPeriodEnd: true,
        updatedAt: true,
      },
    });

    const portal = await api("POST", "billing/portal", { userId });
    expectOk(portal);
    expect(portal.data).toMatchObject({
      mode: "access",
      url: "/profile#billing",
      billingAccess: {
        provider: "mock",
        billingModel: "prepaid_period",
        renewalCapability: "none",
        benefitsEndAt: before.currentPeriodEnd?.toISOString(),
        renewsAt: null,
      },
    });
    expect(portal.data.subscription).not.toHaveProperty("cancelAtPeriodEnd");
    expect(portal.data.subscription).not.toHaveProperty("currentPeriodEnd");

    const canceled = await api("POST", "billing/cancel", { userId });
    expect(canceled.status).toBe(409);
    expect(canceled.error?.details).toMatchObject({
      code: "renewal_not_supported",
      billingModel: "prepaid_period",
      renewalCapability: "none",
    });

    const resumed = await api("POST", "billing/resume", { userId });
    expect(resumed.status).toBe(409);
    expect(resumed.error?.details).toMatchObject({
      code: "renewal_not_supported",
      billingModel: "prepaid_period",
      renewalCapability: "none",
    });

    const profile = await api("GET", "profile", { userId });
    expectOk(profile);
    expect(profile.data.billingAccess).toMatchObject({
      billingModel: "prepaid_period",
      benefitsEndAt: before.currentPeriodEnd?.toISOString(),
      renewsAt: null,
    });
    expect(profile.data.subscription).not.toHaveProperty("cancelAtPeriodEnd");
    expect(profile.data.entitlements).toMatchObject({
      premium_controls: true,
      voice_enabled: true,
    });

    await expect(
      prisma.subscription.findUniqueOrThrow({
        where: { id: before.id },
        select: {
          cancelAtPeriodEnd: true,
          currentPeriodEnd: true,
          updatedAt: true,
        },
      }),
    ).resolves.toEqual({
      cancelAtPeriodEnd: before.cancelAtPeriodEnd,
      currentPeriodEnd: before.currentPeriodEnd,
      updatedAt: before.updatedAt,
    });
    expect(
      await prisma.analyticsEvent.count({
        where: { userId, name: { in: ["subscription_cancel_requested", "subscription_resume_requested"] } },
      }),
    ).toBe(0);
  });
});

describe("webhook idempotency", () => {
  it("acknowledges a legacy completed checkout replay without clearing its reconciliation evidence", async () => {
    const userId = await setupUser("legacy-completed-replay");
    const planId = await setupPlan("legacy-completed-replay", 435);
    const checkout = await checkoutApi(userId, {
      planId,
      autoConfirm: true,
    });
    expectOk(checkout);
    const checkoutId = checkout.data.checkout.id as string;
    const invoiceId = checkout.data.invoice.invoiceId as string;
    await prisma.checkoutSession.update({
      where: { id: checkoutId },
      data: {
        planId: null,
        offerSnapshot: Prisma.DbNull,
        failureCode: "legacy_completed_checkout_evidence_incomplete",
        needsReconciliation: true,
        reconciliationEvidence: {
          schemaVersion: "checkout-reconciliation-evidence-v1",
          reason: "legacy_completed_checkout_evidence_incomplete",
          missingPlanId: true,
          missingOfferSnapshot: true,
        },
      },
    });

    const replay = await api("POST", "billing/webhooks/mock", {
      headers: {
        "x-provider-event-id": `${P}legacy-completed-replay-event`,
      },
      body: {
        invoiceId,
        providerEventId: `${P}legacy-completed-replay-event`,
      },
    });
    expectOk(replay);
    expect(replay.data).toMatchObject({
      idempotent: true,
      processed: true,
    });
    expect(await dreamcoinBalance(userId)).toBe(435);
    await expect(
      prisma.checkoutSession.findUniqueOrThrow({
        where: { id: checkoutId },
        select: {
          failureCode: true,
          needsReconciliation: true,
          reconciliationEvidence: true,
          status: true,
        },
      }),
    ).resolves.toMatchObject({
      failureCode: "legacy_completed_checkout_evidence_incomplete",
      needsReconciliation: true,
      reconciliationEvidence: {
        schemaVersion: "checkout-reconciliation-evidence-v1",
        reason: "legacy_completed_checkout_evidence_incomplete",
        missingPlanId: true,
        missingOfferSnapshot: true,
      },
      status: "completed",
    });
    await expect(
      prisma.providerEvent.findUniqueOrThrow({
        where: {
          provider_providerEventId: {
            provider: "mock",
            providerEventId: `${P}legacy-completed-replay-event`,
          },
        },
        select: { processedAt: true },
      }),
    ).resolves.toMatchObject({ processedAt: expect.any(Date) });
  });

  it("settles the immutable purchased offer after the mutable plan changes", async () => {
    const userId = await setupUser("offer-snapshot");
    const planId = await setupPlan("offer-snapshot", 777);
    const checkout = await checkoutApi(userId, {
      planId,
      autoConfirm: false,
    });
    expectOk(checkout);

    await prisma.plan.update({
      where: { id: planId },
      data: {
        name: "Mutable replacement",
        priceCents: 1,
        includedDreamcoins: 1,
        features: {
          unlimitedMessages: false,
          imageGeneration: false,
          videoGeneration: false,
          voiceEnabled: false,
          customPrompt: false,
        },
      },
    });
    const providerEventId = `${P}evt-offer-snapshot`;
    const settled = await api("POST", "billing/webhooks/mock", {
      headers: { "x-provider-event-id": providerEventId },
      body: {
        invoiceId: checkout.data.invoice.invoiceId,
        planId: `${P}forged-plan`,
        providerEventId,
      },
    });
    expectOk(settled);
    expect(await dreamcoinBalance(userId)).toBe(777);
    const me = await api("GET", "me", { userId });
    expect(me.data.entitlements).toMatchObject({
      custom_prompt: true,
      video_generation: true,
      voice_enabled: true,
    });
    await expect(
      prisma.entitlement.findUniqueOrThrow({
        where: { userId_key: { userId, key: "video_generation" } },
        select: { value: true },
      }),
    ).resolves.toEqual({ value: true });
    const profile = await api("GET", "profile", { userId });
    expectOk(profile);
    expect(profile.data.subscription).toMatchObject({
      planId,
      offerAuthority: "checkout_snapshot",
      plan: {
        id: planId,
        name: "Premium",
        priceCents: 1999,
        includedDreamcoins: 777,
        features: {
          customPrompt: true,
          videoGeneration: true,
          voiceEnabled: true,
        },
      },
    });
    const storedCheckout = await prisma.checkoutSession.findUniqueOrThrow({
      where: {
        provider_providerSessionId: {
          provider: "mock",
          providerSessionId: checkout.data.invoice.invoiceId,
        },
      },
      select: { offerSnapshot: true },
    });
    expect(storedCheckout.offerSnapshot).toMatchObject({
      features: {
        customPrompt: true,
        videoGeneration: true,
        voiceEnabled: true,
      },
    });
  });

  it("activates once on first event and is a no-op on replay", async () => {
    const userId = await setupUser("webhook");
    const planId = await setupPlan("webhook", 800);

    const checkout = await checkoutApi(userId, { planId, autoConfirm: false });
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

  it("does not reactivate an old completed purchase when a new provider event arrives after a plan switch", async () => {
    const userId = await setupUser("old-event-after-switch");
    const oldPlanId = await setupPlan("old-event-after-switch-old", 400);
    const newPlanId = await setupPlan("old-event-after-switch-new", 900);
    const oldCheckout = await checkoutApi(userId, {
      planId: oldPlanId,
      autoConfirm: false,
    });
    expectOk(oldCheckout);
    const invoiceId = oldCheckout.data.invoice.invoiceId as string;
    expectOk(
      await api("POST", "billing/webhooks/mock", {
        headers: { "x-provider-event-id": `${P}old-event-first` },
        body: {
          invoiceId,
          providerEventId: `${P}old-event-first`,
        },
      }),
    );
    expectOk(
      await checkoutApi(userId, {
        planId: newPlanId,
        autoConfirm: true,
      }),
    );
    const balanceBeforeReplay = await dreamcoinBalance(userId);

    const lateDuplicate = await api("POST", "billing/webhooks/mock", {
      headers: { "x-provider-event-id": `${P}old-event-second` },
      body: {
        invoiceId,
        providerEventId: `${P}old-event-second`,
      },
    });
    expectOk(lateDuplicate);
    expect(lateDuplicate.data).toMatchObject({
      idempotent: true,
      processed: true,
    });
    expect(await dreamcoinBalance(userId)).toBe(balanceBeforeReplay);
    await expect(
      prisma.subscription.findFirstOrThrow({
        where: { userId, status: "active" },
        select: { planId: true },
      }),
    ).resolves.toEqual({ planId: newPlanId });
  });

  it("records legitimate redeliveries without settling twice", async () => {
    const userId = await setupUser("redelivery");
    const planId = await setupPlan("redelivery", 810);
    const checkout = await checkoutApi(userId, {
      planId,
      autoConfirm: false,
    });
    expectOk(checkout);
    const invoiceId = checkout.data.invoice.invoiceId as string;
    const providerEventId = `${P}evt-redelivery`;

    expectOk(
      await api("POST", "billing/webhooks/mock", {
        headers: { "x-provider-event-id": "transport-event-one" },
        body: {
          invoiceId,
          deliveryId: `${P}delivery-one`,
          originalDeliveryId: providerEventId,
        },
      }),
    );
    const replay = await api("POST", "billing/webhooks/mock", {
      headers: { "x-provider-event-id": "transport-event-two" },
      body: {
        invoiceId,
        deliveryId: `${P}delivery-two`,
        originalDeliveryId: providerEventId,
      },
    });
    expectOk(replay);
    expect(replay.data).toMatchObject({ idempotent: true, processed: false });
    expect(await dreamcoinBalance(userId)).toBe(810);
    const event = await prisma.providerEvent.findUniqueOrThrow({
      where: {
        provider_providerEventId: {
          provider: "mock",
          providerEventId,
        },
      },
    });
    expect(
      await prisma.providerEventDelivery.count({
        where: { eventId: event.id },
      }),
    ).toBe(2);
  });

  it.each([
    ["wrong-amount", 9_999, "usd", "settled"],
    ["wrong-currency", 1_999, "eur", "settled"],
    ["not-settled", 1_999, "usd", "processing"],
  ] as const)(
    "rejects an unbound order fallback whose provider authority is %s",
    async (suffix, amountCents, currency, providerStatus) => {
      const userId = await setupUser(`fallback-${suffix}`);
      const planId = await setupPlan(`fallback-${suffix}`, 555);
      const idempotencyKey = `${P}fallback-${suffix}-key`;
      const createInvoice = vi
        .spyOn(providers.payment, "createInvoice")
        .mockResolvedValue({
          ok: false,
          error: {
            code: "invoice_create_timeout",
            message: "provider response was lost",
            retryable: true,
          },
        });
      const lookup = vi
        .spyOn(providers.payment, "findInvoiceByOrderId")
        .mockResolvedValueOnce({ ok: true, data: null })
        .mockResolvedValueOnce({ ok: true, data: null });

      try {
        expect(
          (
            await checkoutApi(
              userId,
              { planId, autoConfirm: false },
              idempotencyKey,
            )
          ).status,
        ).toBe(503);
        const intent = await prisma.checkoutSession.findFirstOrThrow({
          where: { userId, idempotencyKey },
        });
        const invoiceId = `${P}fallback-${suffix}-invoice`;
        lookup.mockResolvedValueOnce({
          ok: true,
          data: {
            provider: "mock",
            invoiceId,
            checkoutUrl: `https://mock-payments.idream.local/invoices/${invoiceId}`,
            status: providerStatus,
            additionalStatus: "none",
            orderId: intent.id,
            amountCents,
            currency,
          },
        });

        const result = await api("POST", "billing/webhooks/mock", {
          headers: { "x-provider-event-id": `${P}fallback-${suffix}-event` },
          body: {
            invoiceId,
            orderId: intent.id,
            providerEventId: `${P}fallback-${suffix}-event`,
          },
        });
        expect(result.status).toBe(409);
        expect(await dreamcoinBalance(userId)).toBe(0);
        expect(
          await prisma.subscription.count({ where: { userId } }),
        ).toBe(0);
      } finally {
        createInvoice.mockRestore();
        lookup.mockRestore();
      }
    },
  );

  it("serializes distinct settlement events that concurrently bind the same recovered order", async () => {
    const userId = await setupUser("concurrent-order-bind");
    const planId = await setupPlan("concurrent-order-bind", 675);
    const idempotencyKey = `${P}concurrent-order-bind-key`;
    const createInvoice = vi
      .spyOn(providers.payment, "createInvoice")
      .mockResolvedValue({
        ok: false,
        error: {
          code: "invoice_create_timeout",
          message: "provider response was lost",
          retryable: true,
        },
      });
    const lookup = vi
      .spyOn(providers.payment, "findInvoiceByOrderId")
      .mockResolvedValueOnce({ ok: true, data: null })
      .mockResolvedValueOnce({ ok: true, data: null });

    try {
      expect(
        (
          await checkoutApi(
            userId,
            { planId, autoConfirm: false },
            idempotencyKey,
          )
        ).status,
      ).toBe(503);
      const intent = await prisma.checkoutSession.findFirstOrThrow({
        where: { userId, idempotencyKey },
      });
      const invoiceId = `${P}concurrent-order-bind-invoice`;
      lookup.mockResolvedValue({
        ok: true,
        data: {
          provider: "mock",
          invoiceId,
          checkoutUrl: `https://mock-payments.idream.local/invoices/${invoiceId}`,
          status: "settled",
          additionalStatus: "none",
          orderId: intent.id,
          amountCents: 1999,
          currency: "usd",
        },
      });

      const results = await Promise.all([
        api("POST", "billing/webhooks/mock", {
          headers: { "x-provider-event-id": `${P}concurrent-order-event-a` },
          body: {
            invoiceId,
            orderId: intent.id,
            providerEventId: `${P}concurrent-order-event-a`,
          },
        }),
        api("POST", "billing/webhooks/mock", {
          headers: { "x-provider-event-id": `${P}concurrent-order-event-b` },
          body: {
            invoiceId,
            orderId: intent.id,
            providerEventId: `${P}concurrent-order-event-b`,
          },
        }),
      ]);
      results.forEach((result) => expectOk(result));
      expect(await dreamcoinBalance(userId)).toBe(675);
      expect(
        await prisma.subscription.count({
          where: { userId, planId },
        }),
      ).toBe(1);
    } finally {
      createInvoice.mockRestore();
      lookup.mockRestore();
    }
  });

  it("rejects a signed invoice/order mismatch before activation", async () => {
    const firstUserId = await setupUser("order-mismatch-a");
    const secondUserId = await setupUser("order-mismatch-b");
    const firstPlanId = await setupPlan("order-mismatch-a", 500);
    const secondPlanId = await setupPlan("order-mismatch-b", 600);
    const first = await checkoutApi(firstUserId, {
      planId: firstPlanId,
      autoConfirm: false,
    });
    const second = await checkoutApi(secondUserId, {
      planId: secondPlanId,
      autoConfirm: false,
    });
    expectOk(first);
    expectOk(second);

    const mismatch = await api("POST", "billing/webhooks/mock", {
      headers: { "x-provider-event-id": `${P}evt-order-mismatch` },
      body: {
        invoiceId: first.data.invoice.invoiceId,
        orderId: second.data.checkout.id,
        providerEventId: `${P}evt-order-mismatch`,
      },
    });
    expect(mismatch.status).toBe(409);
    expect(await dreamcoinBalance(firstUserId)).toBe(0);
    expect(await dreamcoinBalance(secondUserId)).toBe(0);
  });

  it("activates from the local checkout authority when the payload omits planId", async () => {
    const userId = await setupUser("noplan");
    const planId = await setupPlan("noplan", 700);

    const checkout = await checkoutApi(userId, { planId, autoConfirm: false });
    expectOk(checkout);
    const invoiceId = checkout.data.invoice.invoiceId as string;

    const webhookBody = { invoiceId, providerEventId: `${P}evt-noplan` };
    const result = await api("POST", "billing/webhooks/mock", {
      headers: { "x-provider-event-id": `${P}evt-noplan` },
      body: webhookBody,
    });
    expectOk(result);
    expect(result.data).toMatchObject({ processed: true });
    expect(await dreamcoinBalance(userId)).toBe(700);
    expect(await prisma.subscription.count({ where: { userId, planId } })).toBe(1);
  });

  it("rejects mutation of an immutable provider delivery payload", async () => {
    const userId = await setupUser("retryable-webhook");
    const planId = await setupPlan("retryable-webhook", 650);

    const checkout = await checkoutApi(userId, { planId, autoConfirm: false });
    expectOk(checkout);
    const invoiceId = checkout.data.invoice.invoiceId as string;
    const providerEventId = `${P}evt-retryable`;

    const first = await api("POST", "billing/webhooks/mock", {
      headers: { "x-provider-event-id": providerEventId },
      body: { invoiceId, planId: `${P}missing-plan`, providerEventId },
    });
    expectOk(first);
    const eventAfterFirst = await prisma.providerEvent.findUniqueOrThrow({
      where: { provider_providerEventId: { provider: "mock", providerEventId } },
    });
    expect(eventAfterFirst.processedAt).not.toBeNull();
    expect(await dreamcoinBalance(userId)).toBe(650);

    const mutated = await api("POST", "billing/webhooks/mock", {
      headers: { "x-provider-event-id": providerEventId },
      body: { invoiceId, planId, providerEventId },
    });
    expect(mutated.status).toBe(409);
    expect(mutated.error?.code).toBe("conflict");
    expect(await dreamcoinBalance(userId)).toBe(650);
    expect(
      await prisma.providerEventDelivery.count({
        where: { eventId: eventAfterFirst.id },
      }),
    ).toBe(1);
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
