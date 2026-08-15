import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { BtcPayPaymentProvider } from "./btcpay";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function createProvider(fetchImpl?: FetchLike) {
  return new BtcPayPaymentProvider({
    baseUrl: "https://btcpay.example.com",
    storeId: "store-1",
    apiKey: "api-key",
    webhookSecret: "webhook-secret",
    fetchImpl:
      fetchImpl ??
      (async () =>
        Response.json({
          id: "inv-1",
          checkoutLink: "https://btcpay.example.com/i/inv-1",
          status: "New",
          additionalStatus: "None",
          amount: "19.99",
          currency: "USD",
          metadata: { orderId: "checkout-1" },
        })),
  });
}

function signature(rawBody: string) {
  return `sha256=${createHmac("sha256", "webhook-secret").update(rawBody).digest("hex")}`;
}

describe("BtcPayPaymentProvider", () => {
  it("declares one-period prepaid billing without renewal controls", () => {
    expect(createProvider().capabilities).toEqual({
      billingModel: "prepaid_period",
      renewalCapability: "none",
    });
  });

  it("creates a BTCPay invoice through the Greenfield API", async () => {
    const fetchMock = vi.fn(
      async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => {
        void _input;
        void _init;
        return Response.json({
          id: "inv-123",
          checkoutLink: "https://btcpay.example.com/i/inv-123",
          status: "New",
          additionalStatus: "None",
          amount: "19.99",
          currency: "USD",
          metadata: { orderId: "checkout-1" },
        });
      },
    );
    const provider = createProvider(fetchMock);

    const result = await provider.createInvoice({
      orderId: "checkout-1",
      userId: "user-1",
      amountCents: 1999,
      currency: "usd",
      metadata: { planId: "premium" },
    });

    expect(result).toEqual({
      ok: true,
      data: {
        provider: "btcpay",
        invoiceId: "inv-123",
        checkoutUrl: "https://btcpay.example.com/i/inv-123",
        status: "created",
        additionalStatus: "none",
        orderId: "checkout-1",
        amountCents: 1999,
        currency: "usd",
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://btcpay.example.com/api/v1/stores/store-1/invoices");
    expect(init?.headers).toMatchObject({
      authorization: "token api-key",
      "content-type": "application/json",
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      amount: "19.99",
      currency: "USD",
      metadata: { userId: "user-1", planId: "premium", orderId: "checkout-1" },
    });
  });

  it("forwards request cancellation to both BTCPay invoice operations", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "GET") return Response.json([]);
        return Response.json({
          id: "inv-signal",
          checkoutLink: "https://btcpay.example.com/i/inv-signal",
          status: "New",
          additionalStatus: "None",
          amount: "19.99",
          currency: "USD",
          metadata: { orderId: "checkout-signal" },
        });
      },
    );
    const provider = createProvider(fetchMock);
    const createController = new AbortController();
    const lookupController = new AbortController();

    await provider.createInvoice({
      orderId: "checkout-signal",
      userId: "user-signal",
      amountCents: 1999,
      currency: "usd",
      signal: createController.signal,
    });
    await provider.findInvoiceByOrderId({
      orderId: "checkout-signal",
      signal: lookupController.signal,
    });

    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(
      createController.signal,
    );
    expect(fetchMock.mock.calls[1]?.[1]?.signal).toBe(
      lookupController.signal,
    );
  });

  it("rejects a create response that does not prove order, amount, currency, and status", async () => {
    const provider = createProvider(
      vi.fn(async () =>
        Response.json({
          id: "inv-unproven",
          checkoutLink: "https://btcpay.example.com/i/inv-unproven",
        }),
      ),
    );

    await expect(
      provider.createInvoice({
        orderId: "checkout-1",
        userId: "user-1",
        amountCents: 1999,
        currency: "usd",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "invoice_create_invalid",
        retryable: false,
      },
    });
  });

  it("rejects a create response whose amount differs from the immutable checkout", async () => {
    const provider = createProvider(
      vi.fn(async () =>
        Response.json({
          id: "inv-wrong-amount",
          checkoutLink: "https://btcpay.example.com/i/inv-wrong-amount",
          status: "New",
          additionalStatus: "None",
          amount: "99.99",
          currency: "USD",
          metadata: { orderId: "checkout-1" },
        }),
      ),
    );

    await expect(
      provider.createInvoice({
        orderId: "checkout-1",
        userId: "user-1",
        amountCents: 1999,
        currency: "usd",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "invoice_create_invalid",
      },
    });
  });

  it("returns retryable failures for transient invoice errors", async () => {
    const provider = createProvider(
      vi.fn(async () => Response.json({ message: "processor unavailable" }, { status: 503 })),
    );

    await expect(
      provider.createInvoice({
        orderId: "checkout-1",
        userId: "user-1",
        amountCents: 1999,
        currency: "usd",
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "invoice_create_failed",
        message: "processor unavailable",
        retryable: true,
      },
    });
  });

  it("recovers a previously-created invoice by the durable checkout order id", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => {
        void _input;
        void _init;
        return Response.json([
          {
            id: "inv-recovered",
            checkoutLink: "https://btcpay.example.com/i/inv-recovered",
            status: "New",
            additionalStatus: "None",
            amount: "19.99",
            currency: "USD",
            metadata: { orderId: "checkout-recovery-1" },
          },
        ]);
      },
    );
    const provider = createProvider(fetchMock);

    await expect(
      provider.findInvoiceByOrderId({ orderId: "checkout-recovery-1" }),
    ).resolves.toEqual({
      ok: true,
      data: {
        provider: "btcpay",
        invoiceId: "inv-recovered",
        checkoutUrl: "https://btcpay.example.com/i/inv-recovered",
        status: "created",
        additionalStatus: "none",
        orderId: "checkout-recovery-1",
        amountCents: 1999,
        currency: "usd",
      },
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      "https://btcpay.example.com/api/v1/stores/store-1/invoices?orderId=checkout-recovery-1&take=1",
    );
    expect(init?.method).toBe("GET");
  });

  it("creates a full on-chain invoice refund with a durable product reference", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        id: "pull-refund-1",
        name: "idream-refund:checkout-1",
        description: "Customer requested a full refund.",
        currency: "USD",
        amount: "19.99",
        archived: false,
        viewLink: "https://btcpay.example.com/pull-payments/pull-refund-1",
      }),
    );
    const provider = createProvider(fetchMock);

    await expect(
      provider.createRefund({
        invoiceId: "inv-123",
        reference: "idream-refund:checkout-1",
        reason: "Customer requested a full refund.",
        amountCents: 1_999,
        currency: "usd",
      }),
    ).resolves.toEqual({
      ok: true,
      data: {
        provider: "btcpay",
        refundId: "pull-refund-1",
        reference: "idream-refund:checkout-1",
        claimUrl: "https://btcpay.example.com/pull-payments/pull-refund-1",
        amount: "19.99",
        currency: "usd",
        state: "claimable",
        payouts: [],
      },
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      "https://btcpay.example.com/api/v1/invoices/inv-123/refund",
    );
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      name: "idream-refund:checkout-1",
      description: "Customer requested a full refund.",
      payoutMethodId: "BTC-CHAIN",
      refundVariant: "Custom",
      customAmount: "19.99",
      customCurrency: "USD",
      subtractPercentage: "0",
    });
  });

  it("rejects a provider refund whose amount exceeds the product purchase", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        id: "pull-refund-overpaid",
        name: "idream-refund:checkout-1",
        description: "Customer requested a full refund.",
        currency: "BTC",
        amount: "0.000055",
        archived: false,
        viewLink: "https://btcpay.example.com/pull-payments/pull-refund-overpaid",
      }),
    );
    const provider = createProvider(fetchMock);

    await expect(
      provider.createRefund({
        invoiceId: "inv-overpaid",
        reference: "idream-refund:checkout-1",
        reason: "Customer requested a full refund.",
        amountCents: 1_999,
        currency: "usd",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "refund_create_invalid", retryable: false },
    });
  });

  it("projects an archived unclaimed pull payment as canceled", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/stores/store-1/pull-payments")) {
        return Response.json([
          {
            id: "pull-refund-archived",
            name: "idream-refund:checkout-1:command-1",
            description: "Canceled before a customer claim.",
            currency: "USD",
            amount: "19.99",
            archived: true,
            viewLink:
              "https://btcpay.example.com/pull-payments/pull-refund-archived",
          },
        ]);
      }
      return Response.json([]);
    });
    const provider = createProvider(fetchMock);

    await expect(
      provider.findRefund({
        reference: "idream-refund:checkout-1:command-1",
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        refundId: "pull-refund-archived",
        state: "canceled",
        amount: "19.99",
        currency: "usd",
      },
    });
  });

  it("recovers a refund by its durable reference and proves its completed payout", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/stores/store-1/pull-payments")) {
        return Response.json([
          {
            id: "pull-refund-1",
            name: "idream-refund:checkout-1",
            description: "Customer requested a full refund.",
            currency: "BTC",
            amount: "0.00001999",
            archived: false,
            viewLink: "https://btcpay.example.com/pull-payments/pull-refund-1",
          },
        ]);
      }
      return Response.json([
        {
          id: "payout-1",
          pullPaymentId: "pull-refund-1",
          originalCurrency: "BTC",
          originalAmount: "0.00001999",
          payoutCurrency: "BTC",
          payoutAmount: "0.00001999",
          payoutMethodId: "BTC-CHAIN",
          state: "Completed",
          paymentProof: { id: "refund-transaction-1" },
        },
      ]);
    });
    const provider = createProvider(fetchMock);

    await expect(
      provider.findRefund({ reference: "idream-refund:checkout-1" }),
    ).resolves.toEqual({
      ok: true,
      data: {
        provider: "btcpay",
        refundId: "pull-refund-1",
        reference: "idream-refund:checkout-1",
        claimUrl: "https://btcpay.example.com/pull-payments/pull-refund-1",
        amount: "0.00001999",
        currency: "btc",
        state: "completed",
        payouts: [
          {
            payoutId: "payout-1",
            amount: "0.00001999",
            currency: "btc",
            state: "completed",
            paymentProofId: "refund-transaction-1",
          },
        ],
      },
    });
  });

  it("rejects a completed refund with an additional payout in another currency", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/stores/store-1/pull-payments")) {
        return Response.json([
          {
            id: "pull-refund-cross-currency",
            name: "idream-refund:checkout-cross-currency",
            currency: "USD",
            amount: "19.99",
            archived: false,
            viewLink:
              "https://btcpay.example.com/pull-payments/pull-refund-cross-currency",
          },
        ]);
      }
      return Response.json([
        {
          id: "payout-usd",
          originalCurrency: "USD",
          originalAmount: "19.99",
          state: "Completed",
        },
        {
          id: "payout-eur-extra",
          originalCurrency: "EUR",
          originalAmount: "1.00",
          state: "Completed",
        },
      ]);
    });
    const provider = createProvider(fetchMock);

    await expect(
      provider.findRefund({
        reference: "idream-refund:checkout-cross-currency",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "refund_lookup_invalid", retryable: false },
    });
  });

  it("parses payout updates as refund events after signature verification", async () => {
    const provider = createProvider();
    const rawBody = JSON.stringify({
      deliveryId: "delivery-refund-1",
      type: "PayoutUpdated",
      payoutId: "payout-1",
      pullPaymentId: "pull-refund-1",
      payoutState: "Completed",
    });

    await expect(
      provider.parseWebhook({
        providerEventId: "fallback-event",
        payload: JSON.parse(rawBody) as unknown,
        rawBody,
        signature: signature(rawBody),
      }),
    ).resolves.toEqual({
      ok: true,
      data: {
        providerEventId: "delivery-refund-1",
        deliveryId: "delivery-refund-1",
        type: "refund.updated",
        refundId: "pull-refund-1",
        payoutId: "payout-1",
        payoutState: "completed",
      },
    });
  });

  it.each([
    ["Processing", "None", "processing", "none"],
    ["Settled", "PaidOver", "settled", "paid_over"],
    ["Expired", "PaidLate", "expired", "paid_late"],
    ["Invalid", "PaidPartial", "invalid", "paid_partial"],
  ] as const)(
    "preserves BTCPay %s / %s recovery status",
    async (status, additionalStatus, expectedStatus, expectedAdditionalStatus) => {
      const provider = createProvider(
        vi.fn(async () =>
          Response.json([
            {
              id: `inv-${status.toLowerCase()}`,
              checkoutLink: `https://btcpay.example.com/i/${status.toLowerCase()}`,
              status,
              additionalStatus,
              amount: 24.5,
              currency: "USD",
              metadata: { orderId: "checkout-status-1" },
            },
          ]),
        ),
      );

      await expect(
        provider.findInvoiceByOrderId({ orderId: "checkout-status-1" }),
      ).resolves.toMatchObject({
        ok: true,
        data: {
          status: expectedStatus,
          additionalStatus: expectedAdditionalStatus,
          orderId: "checkout-status-1",
          amountCents: 2450,
          currency: "usd",
        },
      });
    },
  );

  it("rejects a recovery response whose order authority is incomplete", async () => {
    const provider = createProvider(
      vi.fn(async () =>
        Response.json([
          {
            id: "inv-wrong-order",
            checkoutLink: "https://btcpay.example.com/i/inv-wrong-order",
            status: "New",
            additionalStatus: "None",
            amount: "19.99",
            currency: "USD",
            metadata: { orderId: "some-other-order" },
          },
        ]),
      ),
    );

    await expect(
      provider.findInvoiceByOrderId({ orderId: "checkout-recovery-1" }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "invoice_lookup_invalid",
        retryable: false,
      },
    });
  });

  it("parses settled invoice webhooks after signature verification", async () => {
    const provider = createProvider();
    const rawBody = JSON.stringify({
      deliveryId: "delivery-1",
      type: "InvoiceSettled",
      invoiceId: "inv-123",
    });

    await expect(
      provider.parseWebhook({
        providerEventId: "fallback-event",
        payload: JSON.parse(rawBody) as unknown,
        rawBody,
        signature: signature(rawBody),
      }),
    ).resolves.toEqual({
      ok: true,
      data: {
        providerEventId: "delivery-1",
        deliveryId: "delivery-1",
        type: "invoice.confirmed",
        invoiceId: "inv-123",
      },
    });
  });

  it("marks unrelated BTCPay events as ignored but processed", async () => {
    const provider = createProvider();
    const rawBody = JSON.stringify({
      deliveryId: "delivery-ignored",
      type: "InvoiceCreated",
      invoiceId: "inv-123",
    });

    await expect(
      provider.parseWebhook({
        providerEventId: "fallback-event",
        payload: JSON.parse(rawBody) as unknown,
        rawBody,
        signature: signature(rawBody),
      }),
    ).resolves.toEqual({
      ok: true,
      data: {
        providerEventId: "delivery-ignored",
        deliveryId: "delivery-ignored",
        type: "invoice.ignored",
        invoiceId: "inv-123",
      },
    });
  });

  it("rejects invalid webhook signatures", async () => {
    const provider = createProvider();
    const rawBody = JSON.stringify({
      deliveryId: "delivery-1",
      type: "InvoiceSettled",
      invoiceId: "inv-123",
    });

    await expect(
      provider.parseWebhook({
        providerEventId: "fallback-event",
        payload: JSON.parse(rawBody) as unknown,
        rawBody,
        signature: "sha256=bad",
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "invalid_signature",
        message: "BTCPay webhook signature is invalid",
        retryable: false,
      },
    });
  });
});
