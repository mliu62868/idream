import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/lib/db";
import { providers } from "@/server/providers";
import { billingWebhook } from "../ourdream/billing-checkout";
import { env } from "@/server/lib/env";
import type { PaymentInvoicePaymentEvidence } from "@/server/providers/types";
import { recordInvoiceCashCapturesInTx } from "./cash-capture";

describe("immutable provider cash capture authority", () => {
  const prefix = `cash-capture-${randomUUID()}`;
  const userId = `${prefix}-user`;
  const checkoutId = `${prefix}-checkout`;
  const invoiceId = `${prefix}-invoice`;
  const paymentId = `${prefix}-payment`;
  const receivedAt = "2026-09-13T01:02:03.000Z";
  const checkout = { id: checkoutId, userId, provider: "btcpay", providerSessionId: invoiceId };
  function evidence(amount = "0.00005500"): PaymentInvoicePaymentEvidence {
    return { provider: "btcpay", invoiceId, orderId: checkoutId, status: "verified", merchantAccountId: "store-test",
      source: "btcpay_accounted_invoice_payments", payments: [{ paymentId, paymentMethodId: "BTC-CHAIN", amount, currency: "BTC", receivedAt, settledAt: null }] };
  }
  beforeAll(async () => {
    await prisma.user.create({ data: { id: userId, email: `${userId}@customer.invalid`, role: "user", status: "active" } });
    await prisma.checkoutSession.create({ data: { ...checkout, amountCents: 1200, currency: "USD", status: "completed" } });
  });
  afterAll(async () => {
    await prisma.providerEvent.deleteMany({ where: { providerEventId: { startsWith: prefix } } });
    await prisma.dataQualityCheck.deleteMany({ where: { checkKey: "billing.cash_capture_evidence", evidence: { path: ["checkoutId"], string_starts_with: prefix } } });
    await prisma.cashCaptureFact.deleteMany({ where: { checkoutId: { startsWith: prefix } } });
    await prisma.checkoutSession.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("does not turn a settled invoice's USD face value or missing independent payments into cash", async () => {
    const result = await prisma.$transaction((tx) => recordInvoiceCashCapturesInTx(tx, checkout, {
      provider: "btcpay", invoiceId, orderId: checkoutId, status: "unknown", reason: "settled_payments_missing", payments: [],
    }));
    expect(result).toMatchObject({ status: "unavailable", createdCount: 0 });
    expect(await prisma.cashCaptureFact.count({ where: { checkoutId } })).toBe(0);
    expect(await prisma.dataQualityCheck.findFirst({ where: { checkKey: "billing.cash_capture_evidence", evidence: { path: ["checkoutId"], equals: checkoutId } } })).toMatchObject({ status: "unavailable" });
  });

  it("records exact original-currency payments once across concurrent delivery and lexical replays", async () => {
    const results = await Promise.all([
      prisma.$transaction((tx) => recordInvoiceCashCapturesInTx(tx, checkout, evidence())),
      prisma.$transaction((tx) => recordInvoiceCashCapturesInTx(tx, checkout, evidence("0.000055"))),
    ]);
    expect(results.reduce((sum, row) => sum + row.createdCount, 0)).toBe(1);
    expect(results.reduce((sum, row) => sum + row.duplicateCount, 0)).toBe(1);
    const facts = await prisma.cashCaptureFact.findMany({ where: { checkoutId } });
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ amount: "0.000055", currency: "BTC", receivedAt: new Date(receivedAt), environment: env.APP_ENV, dataClass: "customer" });
  });

  it("rejects amount changes or reattaching the same payment to another invoice without rewriting its receipt", async () => {
    await expect(prisma.$transaction((tx) => recordInvoiceCashCapturesInTx(tx, checkout, evidence("0.000056"))))
      .rejects.toMatchObject({ code: "conflict", details: expect.objectContaining({ blocker: "cash_capture_identity_conflict" }) });
    const second = { ...checkout, id: `${prefix}-checkout-other`, providerSessionId: `${prefix}-invoice-other` };
    await prisma.checkoutSession.create({ data: { ...second, amountCents: 1200, currency: "USD", status: "completed" } });
    await expect(prisma.$transaction((tx) => recordInvoiceCashCapturesInTx(tx, second, { ...evidence(), invoiceId: second.providerSessionId, orderId: second.id })))
      .rejects.toMatchObject({ code: "conflict", details: expect.objectContaining({ blocker: "cash_capture_identity_conflict" }) });
    expect(await prisma.cashCaptureFact.findMany({ where: { providerPaymentId: paymentId }, select: { checkoutId: true, amount: true } }))
      .toEqual([{ checkoutId, amount: "0.000055" }]);
  });

  it("enforces receipt immutability in PostgreSQL, independently of application checks", async () => {
    await expect(prisma.cashCaptureFact.updateMany({ where: { checkoutId }, data: { amount: "1" } })).rejects.toThrow("immutable");
  });
  it("persists verified payment receipts through settled webhook handling and processed-event replay", async () => {
    const originalProvider = env.PAYMENT_PROVIDER;
    env.PAYMENT_PROVIDER = "btcpay";
    const providerEventId = `${prefix}-webhook-event`;
    const webhookPaymentId = `${prefix}-webhook-payment`;
    vi.spyOn(providers.payment, "parseWebhook").mockResolvedValue({ ok: true, data: {
      type: "invoice.confirmed", providerEventId, deliveryId: `${prefix}-delivery`, invoiceId, orderId: checkoutId,
    } });
    vi.spyOn(providers.payment, "findInvoiceByOrderId").mockResolvedValue({ ok: true, data: {
      provider: "btcpay", invoiceId, orderId: checkoutId, status: "settled", additionalStatus: "none",
      checkoutUrl: "https://pay.invalid/invoice", amountCents: 1200, currency: "USD",
    } });
    const actual = evidence();
    if (actual.status !== "verified") throw new Error("Invalid test evidence");
    vi.spyOn(providers.payment, "readInvoicePaymentEvidence").mockResolvedValue({ ok: true, data: {
      ...actual, payments: actual.payments.map((payment) => ({ ...payment, paymentId: webhookPaymentId })),
    } });
    const request = () => new Request("http://localhost/api/webhooks/btcpay", {
      method: "POST", headers: { "content-type": "application/json", "x-provider-event-id": providerEventId },
      body: JSON.stringify({ invoiceId, orderId: checkoutId }),
    });
    try {
      expect((await billingWebhook(request(), "btcpay")).status).toBe(200);
      const replay = await billingWebhook(request(), "btcpay");
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ data: { idempotent: true } });
      expect(await prisma.cashCaptureFact.count({ where: { providerPaymentId: webhookPaymentId } })).toBe(1);
      expect(await prisma.checkoutSession.findUniqueOrThrow({ where: { id: checkoutId } })).toMatchObject({ status: "completed", amountCents: 1200, currency: "USD" });
    } finally {
      env.PAYMENT_PROVIDER = originalProvider;
      vi.restoreAllMocks();
    }
  });

});
