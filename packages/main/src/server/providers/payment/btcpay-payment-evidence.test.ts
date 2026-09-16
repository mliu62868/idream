import { describe, expect, it, vi } from "vitest";
import { BtcPayPaymentProvider } from "./btcpay";
import { MockPaymentProvider } from "./mock";

const invoice = { id: "inv-1", checkoutLink: "https://btcpay.example.test/i/inv-1", status: "Settled", additionalStatus: "PaidOver", amount: "19.99", currency: "USD", metadata: { orderId: "checkout-1" } };
const payment = { id: "tx-1:0", value: "0.00005500", receivedDate: 1789200000, status: "Settled" };
const methods = [{ paymentMethodId: "BTC-CHAIN", currency: "BTC", payments: [payment] }];
function providerWith(response: unknown = methods, invoiceResponse: unknown = invoice) {
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
    void _init;
    return Response.json(String(url).includes("payment-methods") ? response : invoiceResponse);
  });
  const provider = new BtcPayPaymentProvider({ baseUrl: "https://btcpay.example.test", storeId: "store-1", apiKey: "test-key", webhookSecret: "test-secret", fetchImpl });
  return { provider, fetchImpl };
}
const input = { invoiceId: "inv-1", orderId: "checkout-1" };

describe("BTCPay actual settled payment evidence", () => {
  it("uses accounted settled payment amounts in original currency, independently of invoice face value", async () => {
    const { provider, fetchImpl } = providerWith();
    const result = await provider.readInvoicePaymentEvidence(input);
    expect(result).toEqual({ ok: true, data: {
      status: "verified", provider: "btcpay", merchantAccountId: "store-1", ...input,
      source: "btcpay_accounted_invoice_payments",
      payments: [{ paymentId: "tx-1:0", paymentMethodId: "BTC-CHAIN", amount: "0.00005500", currency: "BTC", receivedAt: new Date(payment.receivedDate * 1000).toISOString(), settledAt: null }],
    } });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const url = new URL(String(fetchImpl.mock.calls[1]?.[0]));
    expect(url.pathname).toBe("/api/v1/invoices/inv-1/payment-methods");
    expect(url.searchParams.get("onlyAccountedPayments")).toBe("true");
    expect(url.searchParams.get("includeSensitive")).toBe("false");
  });

  it("keeps payment methods and currencies separate without applying the invoice exchange rate", async () => {
    const result = await providerWith([
      methods[0],
      { paymentMethodId: "LTC-CHAIN", currency: "LTC", rate: "99999", totalPaid: "999", payments: [{ ...payment, id: "ltc-tx:0", value: "0.125" }] },
    ]).provider.readInvoicePaymentEvidence(input);
    expect(result).toMatchObject({ ok: true, data: { status: "verified", payments: [
      { paymentMethodId: "BTC-CHAIN", amount: "0.00005500", currency: "BTC" },
      { paymentMethodId: "LTC-CHAIN", amount: "0.125", currency: "LTC" },
    ] } });
  });

  it.each([403, 404, 503])("does not certify missing or failed payment-method responses (%i)", async (status) => {
    const { provider, fetchImpl } = providerWith();
    fetchImpl.mockResolvedValueOnce(Response.json(invoice)).mockResolvedValueOnce(Response.json({ message: "unavailable" }, { status }));
    expect(await provider.readInvoicePaymentEvidence(input)).toMatchObject({ ok: false, error: { code: "invoice_payment_lookup_failed" } });
  });

  it("does not mistake an invoice marked settled for an actual payment", async () => {
    const result = await providerWith([], { ...invoice, additionalStatus: "Marked" }).provider.readInvoicePaymentEvidence(input);
    expect(result).toMatchObject({ ok: true, data: { status: "unknown", reason: "settled_payments_missing", payments: [] } });
  });

  it("excludes processing and invalid payments without converting their amounts", async () => {
    const result = await providerWith([{ ...methods[0], payments: [payment, { ...payment, id: "processing", status: "Processing", value: "5.0" }, { ...payment, id: "invalid", status: "Invalid", value: "8.0" }] }]).provider.readInvoicePaymentEvidence(input);
    expect(result).toMatchObject({ ok: true, data: { status: "verified", payments: [{ paymentId: "tx-1:0", amount: "0.00005500" }] } });
  });

  it.each([
    { ...payment, id: undefined }, { ...payment, receivedDate: undefined },
    { ...payment, receivedDate: 0 }, { ...payment, receivedDate: "1789200000" },
    { ...payment, value: 0.1 }, { ...payment, value: "NaN" }, { ...payment, value: "-1" },
    { ...payment, value: "0" }, { ...payment, value: "1e-8" }, { ...payment, status: "FutureState" },
  ])("fails closed on missing or malformed actual payment evidence (%j)", async (row) => {
    const result = await providerWith([{ ...methods[0], payments: [payment, row] }]).provider.readInvoicePaymentEvidence(input);
    expect(result).toMatchObject({ ok: true, data: { status: "unknown", reason: "payment_evidence_incomplete", payments: [] } });
  });

  it("never infers payment currency from invoice currency or the method ID", async () => {
    const result = await providerWith([{ paymentMethodId: "BTC-CHAIN", payments: [payment] }]).provider.readInvoicePaymentEvidence(input);
    expect(result).toMatchObject({ ok: true, data: { status: "unknown", reason: "payment_evidence_incomplete", payments: [] } });
  });

  it("rejects duplicate payment identities instead of double counting", async () => {
    const result = await providerWith([{ ...methods[0], payments: [payment, payment] }]).provider.readInvoicePaymentEvidence(input);
    expect(result).toMatchObject({ ok: true, data: { status: "unknown", reason: "payment_evidence_incomplete", payments: [] } });
  });

  it("checks the merchant invoice and order identity before reading payment methods", async () => {
    const { provider, fetchImpl } = providerWith(methods, { ...invoice, metadata: { orderId: "other-checkout" } });
    expect(await provider.readInvoicePaymentEvidence(input)).toMatchObject({ ok: false, error: { code: "invoice_payment_identity_mismatch", retryable: false } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("propagates request cancellation and reports provider transport failure", async () => {
    const { provider, fetchImpl } = providerWith();
    const signal = new AbortController().signal;
    await provider.readInvoicePaymentEvidence({ ...input, signal });
    expect(fetchImpl.mock.calls.every((call) => call[1]?.signal === signal)).toBe(true);
    fetchImpl.mockRejectedValue(new Error("offline"));
    expect(await provider.readInvoicePaymentEvidence(input)).toMatchObject({ ok: false, error: { code: "invoice_payment_lookup_failed", retryable: true } });
  });

  it("never promotes mock invoices into cash capture evidence", async () => {
    expect(await new MockPaymentProvider().readInvoicePaymentEvidence(input)).toMatchObject({ ok: true, data: { provider: "mock", status: "unknown", reason: "provider_has_no_cash_authority", payments: [] } });
  });
});
