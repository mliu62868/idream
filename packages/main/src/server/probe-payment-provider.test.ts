import { describe, expect, it, vi } from "vitest";
import { runProbe } from "./probe-payment-provider";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

describe("probe-payment-provider", () => {
  it("reads the BTCPay store and creates a launch-test invoice", async () => {
    const fetchMock = vi.fn<FetchLike>(async (input, init) => {
      if (String(input).endsWith("/api/v1/stores/store-1")) {
        expect(init?.method).toBe("GET");
        return Response.json({ id: "store-1" });
      }
      if (String(input).endsWith("/api/v1/stores/store-1/invoices")) {
        expect(init?.method).toBe("POST");
        return Response.json({
          id: "probe-invoice-1",
          checkoutLink: "https://btcpay.example.com/i/probe-invoice-1",
        });
      }
      return Response.json({ message: "unexpected endpoint" }, { status: 404 });
    });

    const report = await runProbe({
      provider: "btcpay",
      baseUrl: "https://btcpay.example.com",
      storeId: "store-1",
      apiKey: "api-key",
      invoiceAmountCents: 1,
      invoiceCurrency: "usd",
      fetchImpl: fetchMock,
    });

    expect(report).toMatchObject({
      ok: true,
      provider: "btcpay",
      baseUrl: "https://btcpay.example.com",
      storeId: "store-1",
      canViewStore: true,
      returnedStoreId: "store-1",
      canCreateInvoice: true,
      invoiceId: "probe-invoice-1",
      checkoutUrl: "https://btcpay.example.com/i/probe-invoice-1",
      invoiceAmountCents: 1,
      invoiceCurrency: "USD",
      error: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [, invoiceInit] = fetchMock.mock.calls[1] ?? [];
    expect(invoiceInit?.headers).toMatchObject({
      authorization: "token api-key",
      accept: "application/json",
      "content-type": "application/json",
    });
    expect(JSON.parse(String(invoiceInit?.body))).toEqual({
      amount: "0.01",
      currency: "USD",
      metadata: expect.objectContaining({
        launchProbe: true,
        source: "idream-check-launch",
      }),
    });
  });

  it("fails when BTCPay cannot create the launch-test invoice", async () => {
    const fetchMock = vi.fn<FetchLike>(async (input) => {
      if (String(input).endsWith("/api/v1/stores/store-1")) {
        return Response.json({ id: "store-1" });
      }
      return Response.json({ message: "missing Create invoice permission" }, { status: 403 });
    });

    const report = await runProbe({
      provider: "btcpay",
      baseUrl: "https://btcpay.example.com",
      storeId: "store-1",
      apiKey: "api-key",
      fetchImpl: fetchMock,
    });

    expect(report).toMatchObject({
      ok: false,
      canViewStore: true,
      returnedStoreId: "store-1",
      canCreateInvoice: false,
      invoiceId: null,
      checkoutUrl: null,
      error: {
        code: "btcpay_invoice_create_failed",
        message: "missing Create invoice permission",
        retryable: false,
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
