import { describe, expect, it, vi } from "vitest";
import type { PaymentAuthorityReader } from "./probe-payment-provider";
import { runProbe } from "./probe-payment-provider";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function passingReader(deliveryCount = 2): PaymentAuthorityReader {
  const payload = {
    type: "InvoiceSettled",
    invoiceId: "invoice-1",
    metadata: { orderId: "checkout-1" },
  };
  return {
    findCheckout: vi.fn(async () => ({
      id: "checkout-1",
      userId: "user-1",
      planId: "plan-1",
      provider: "btcpay",
      providerSessionId: "invoice-1",
      providerInvoiceStatus: "settled",
      providerInvoiceAdditionalStatus: "none",
      checkoutUrl: "https://btcpay.example.com/i/invoice-1",
      amountCents: 499,
      currency: "usd",
      status: "completed",
      returnPath: "/profile#billing",
    })),
    findProviderEvents: vi.fn(async ({ targetHash }) => [
      {
        id: "event-row-1",
        providerEventId: "event-1",
        type: "invoice.confirmed",
        payload,
        targetHash,
        processedAt: new Date("2026-08-11T20:00:00.000Z"),
        deliveries: Array.from({ length: deliveryCount }, (_, index) => ({
          deliveryId: `delivery-${index + 1}`,
          payload,
          payloadHash: "a".repeat(64),
        })),
      },
    ]),
    findSubscriptions: vi.fn(async () => [
      {
        id: "subscription-1",
        status: "active",
        provider: "btcpay",
        providerSubscriptionId: "invoice-1",
      },
    ]),
    countSubscriptionEntitlements: vi.fn(async () => 3),
    findLedgerEntries: vi.fn(async () => [
      {
        id: "ledger-1",
        userId: "user-1",
        reason: "subscription_grant",
        sourceId: "subscription-1",
        idempotencyKey: "subscription:grant:btcpay:invoice-1",
      },
    ]),
  };
}

describe("probe-payment-provider", () => {
  it("audits one real product checkout without creating a detached invoice", async () => {
    const fetchMock = vi.fn<FetchLike>(async (input, init) => {
      expect(String(input)).toBe("https://btcpay.example.com/api/v1/stores/store-1");
      expect(init?.method).toBe("GET");
      return Response.json({ id: "store-1" });
    });
    const findInvoiceByOrderId = vi.fn(async ({ orderId }: { orderId: string }) => ({
      ok: true as const,
      data: {
        provider: "btcpay" as const,
        invoiceId: "invoice-1",
        checkoutUrl: "https://btcpay.example.com/i/invoice-1",
        status: "settled" as const,
        additionalStatus: "none" as const,
        orderId,
        amountCents: 499,
        currency: "usd",
      },
    }));

    const report = await runProbe({
      provider: "btcpay",
      baseUrl: "https://btcpay.example.com",
      storeId: "store-1",
      apiKey: "api-key",
      checkoutId: "checkout-1",
      fetchImpl: fetchMock,
      authorityReader: passingReader(),
      paymentProvider: { findInvoiceByOrderId },
      now: () => new Date("2026-08-11T20:01:00.000Z"),
    });

    expect(report).toMatchObject({
      ok: true,
      checkedAt: "2026-08-11T20:01:00.000Z",
      canViewStore: true,
      canLookupInvoice: true,
      canCreateInvoice: false,
      invoiceId: "invoice-1",
      invoiceAmountCents: 499,
      invoiceCurrency: "USD",
      terminal: {
        checkoutId: "checkout-1",
        checkoutStatus: "completed",
        providerInvoiceId: "invoice-1",
        providerLookupVerified: true,
        providerDeliveryCount: 2,
        replayVerified: true,
        subscriptionId: "subscription-1",
        entitlementCount: 3,
        ledgerEntryId: "ledger-1",
        ledgerEntryCount: 1,
      },
      error: null,
    });
    expect(findInvoiceByOrderId).toHaveBeenCalledWith({ orderId: "checkout-1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps terminal evidence red until a second real webhook delivery exists", async () => {
    const report = await runProbe({
      provider: "btcpay",
      baseUrl: "https://btcpay.example.com",
      storeId: "store-1",
      apiKey: "api-key",
      checkoutId: "checkout-1",
      fetchImpl: vi.fn(async () => Response.json({ id: "store-1" })),
      authorityReader: passingReader(1),
      paymentProvider: {
        findInvoiceByOrderId: vi.fn(async () => ({
          ok: true as const,
          data: {
            provider: "btcpay" as const,
            invoiceId: "invoice-1",
            checkoutUrl: "https://btcpay.example.com/i/invoice-1",
            status: "settled" as const,
            additionalStatus: "none" as const,
            orderId: "checkout-1",
            amountCents: 499,
            currency: "usd",
          },
        })),
      },
    });

    expect(report).toMatchObject({
      ok: false,
      terminal: null,
      error: {
        code: "payment_terminal_authority_invalid",
        message: expect.stringContaining("two exact target deliveries"),
      },
    });
  });

  it("requires an existing product checkout identity", async () => {
    const report = await runProbe({
      provider: "btcpay",
      baseUrl: "https://btcpay.example.com",
      storeId: "store-1",
      apiKey: "api-key",
      checkoutId: null,
    });

    expect(report).toMatchObject({
      ok: false,
      terminal: null,
      error: { code: "payment_probe_checkout_id_required", retryable: false },
    });
  });
});
