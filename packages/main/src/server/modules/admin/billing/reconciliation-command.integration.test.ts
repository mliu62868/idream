import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import {
  api,
  createPlan,
  createUser,
  expectOk,
  purgeTestData,
} from "@/server/test/helpers";

const P = "zt-admin-billing-reconcile-";
const actorId = `${P}actor`;
const supportId = `${P}support`;
const customerId = `${P}customer`;
const planId = `${P}plan`;
const checkoutId = `${P}checkout`;
const invoiceId = `${P}invoice`;
const providerReference = `${P}provider-refund`;

async function cleanup() {
  await prisma.controlPlaneCommand.deleteMany({
    where: { actorId: { startsWith: P } },
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
    billingPeriod: "monthly",
    includedDreamcoins: 500,
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
      amountCents: 1999,
      currency: "usd",
      status: "provider_unknown",
      failureCode: "provider_invoice_settled_after_abandonment",
      needsReconciliation: true,
      reconciliationEvidence: {
        schemaVersion: "checkout-reconciliation-evidence-v1",
        reason: "provider_invoice_settled_after_abandonment",
      },
    },
  });
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("admin late-settlement reconciliation command", () => {
  it("requires the dedicated reconciliation permission", async () => {
    const denied = await api(
      "POST",
      `admin/billing/reconciliation/${checkoutId}/resolve`,
      {
        userId: supportId,
        role: "support",
        body: {
          resolution: "refund_acknowledged",
          providerReference,
          reason: "Provider refund was completed and verified.",
          confirmation: `${checkoutId}:refund_acknowledged`,
        },
      },
    );
    expect(denied.status).toBe(403);
    expect(denied.error?.details).toMatchObject({
      permission: "billing.checkout.reconcile",
    });
  });

  it("closes a late settlement once with audit, outbox, evidence, and replay receipt", async () => {
    const idempotencyKey = `${P}idempotency`;
    const body = {
      resolution: "refund_acknowledged" as const,
      providerReference,
      reason: "Provider refund was completed and verified.",
      confirmation: `${checkoutId}:refund_acknowledged`,
    };
    const first = await api(
      "POST",
      `admin/billing/reconciliation/${checkoutId}/resolve`,
      {
        userId: actorId,
        role: "admin",
        headers: { "idempotency-key": idempotencyKey },
        body,
      },
    );
    expectOk(first);
    expect(first.data).toMatchObject({
      checkout: {
        id: checkoutId,
        failureCode: "provider_invoice_refund_acknowledged",
        needsReconciliation: false,
        status: "canceled",
      },
      replayed: false,
      resolution: {
        providerReference,
        type: "refund_acknowledged",
      },
    });

    const replay = await api(
      "POST",
      `admin/billing/reconciliation/${checkoutId}/resolve`,
      {
        userId: actorId,
        role: "admin",
        headers: { "idempotency-key": idempotencyKey },
        body,
      },
    );
    expectOk(replay);
    expect(replay.data).toMatchObject({ replayed: true });
    await expect(
      prisma.checkoutSession.findUniqueOrThrow({
        where: { id: checkoutId },
        select: {
          failureCode: true,
          needsReconciliation: true,
          providerInvoiceStatus: true,
          reconciliationEvidence: true,
          status: true,
        },
      }),
    ).resolves.toMatchObject({
      failureCode: "provider_invoice_refund_acknowledged",
      needsReconciliation: false,
      providerInvoiceStatus: "settled",
      reconciliationEvidence: {
        resolution: {
          providerReference,
          type: "refund_acknowledged",
        },
      },
      status: "canceled",
    });
    await expect(
      prisma.adminAuditLog.count({
        where: {
          action: "billing.checkout.reconcile_refund",
          targetId: checkoutId,
        },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.mainOutboxEvent.count({
        where: {
          aggregateId: checkoutId,
          eventType: "billing.checkout.reconciliation_resolved.v1",
        },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.controlPlaneCommand.count({
        where: { actorId, idempotencyKey },
      }),
    ).resolves.toBe(1);

    const lateReplay = await api("POST", "billing/webhooks/mock", {
      headers: {
        "x-provider-event-id": `${P}post-refund-webhook`,
      },
      body: {
        invoiceId,
        providerEventId: `${P}post-refund-webhook`,
      },
    });
    expectOk(lateReplay);
    expect(lateReplay.data).toMatchObject({
      idempotent: true,
      processed: true,
    });
    await expect(
      prisma.checkoutSession.findUniqueOrThrow({
        where: { id: checkoutId },
        select: {
          failureCode: true,
          needsReconciliation: true,
          status: true,
        },
      }),
    ).resolves.toEqual({
      failureCode: "provider_invoice_refund_acknowledged",
      needsReconciliation: false,
      status: "canceled",
    });
  });
});
