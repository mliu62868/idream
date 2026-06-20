import type { PaymentProvider } from "../types";

export class MockPaymentProvider implements PaymentProvider {
  async createInvoice(input: Parameters<PaymentProvider["createInvoice"]>[0]) {
    const invoiceId = `mock-invoice-${input.userId}-${input.amountCents}-${input.currency}`;

    return {
      ok: true as const,
      data: {
        provider: "mock" as const,
        invoiceId,
        checkoutUrl: `https://mock-payments.idream.local/invoices/${invoiceId}`,
        status: "created" as const,
      },
    };
  }

  async parseWebhook(input: Parameters<PaymentProvider["parseWebhook"]>[0]) {
    const payload =
      typeof input.payload === "object" && input.payload !== null
        ? (input.payload as Record<string, unknown>)
        : {};
    const invoiceId =
      typeof payload.invoiceId === "string" ? payload.invoiceId : "mock-invoice";

    return {
      ok: true as const,
      data: {
        providerEventId: input.providerEventId,
        type: "invoice.confirmed" as const,
        invoiceId,
      },
    };
  }
}
