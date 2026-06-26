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
        })),
  });
}

function signature(rawBody: string) {
  return `sha256=${createHmac("sha256", "webhook-secret").update(rawBody).digest("hex")}`;
}

describe("BtcPayPaymentProvider", () => {
  it("creates a BTCPay invoice through the Greenfield API", async () => {
    const fetchMock = vi.fn(
      async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => {
        void _input;
        void _init;
        return Response.json({
          id: "inv-123",
          checkoutLink: "https://btcpay.example.com/i/inv-123",
        });
      },
    );
    const provider = createProvider(fetchMock);

    const result = await provider.createInvoice({
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
      metadata: { userId: "user-1", planId: "premium" },
    });
  });

  it("returns retryable failures for transient invoice errors", async () => {
    const provider = createProvider(
      vi.fn(async () => Response.json({ message: "processor unavailable" }, { status: 503 })),
    );

    await expect(
      provider.createInvoice({
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
