import type { PaymentProvider } from "../types";
import { paymentProviderCapabilities } from "./capabilities";

export class MockPaymentProvider implements PaymentProvider {
  readonly capabilities = paymentProviderCapabilities("mock");

  private readonly invoices = new Map<
    string,
    {
      provider: "mock";
      invoiceId: string;
      checkoutUrl: string;
      status: "created";
      additionalStatus: "none";
      orderId: string;
      amountCents: number;
      currency: string;
    }
  >();

  async createInvoice(input: Parameters<PaymentProvider["createInvoice"]>[0]) {
    if (input.signal?.aborted) return abortedPaymentRequest();
    const invoiceId = `mock-invoice-${input.orderId}`;
    const data = {
      provider: "mock" as const,
      invoiceId,
      checkoutUrl: `https://mock-payments.idream.local/invoices/${invoiceId}`,
      status: "created" as const,
      additionalStatus: "none" as const,
      orderId: input.orderId,
      amountCents: input.amountCents,
      currency: input.currency.toLowerCase(),
    };
    this.invoices.set(input.orderId, data);

    return {
      ok: true as const,
      data,
    };
  }

  async findInvoiceByOrderId(
    input: Parameters<PaymentProvider["findInvoiceByOrderId"]>[0],
  ) {
    if (input.signal?.aborted) return abortedPaymentRequest();
    return {
      ok: true as const,
      data: this.invoices.get(input.orderId) ?? null,
    };
  }

  async parseWebhook(input: Parameters<PaymentProvider["parseWebhook"]>[0]) {
    const payload =
      typeof input.payload === "object" && input.payload !== null
        ? (input.payload as Record<string, unknown>)
        : {};
    const invoiceId =
      typeof payload.invoiceId === "string" ? payload.invoiceId : "mock-invoice";
    const deliveryId =
      typeof payload.deliveryId === "string"
        ? payload.deliveryId
        : input.providerEventId;
    const providerEventId =
      typeof payload.originalDeliveryId === "string"
        ? payload.originalDeliveryId
        : deliveryId;
    const metadata =
      typeof payload.metadata === "object" &&
      payload.metadata !== null &&
      !Array.isArray(payload.metadata)
        ? payload.metadata as Record<string, unknown>
        : {};
    const orderId =
      typeof metadata.orderId === "string"
        ? metadata.orderId
        : typeof payload.orderId === "string"
          ? payload.orderId
          : undefined;

    return {
      ok: true as const,
      data: {
        providerEventId,
        deliveryId,
        type: "invoice.confirmed" as const,
        invoiceId,
        ...(orderId ? { orderId } : {}),
      },
    };
  }
}

function abortedPaymentRequest() {
  return {
    ok: false as const,
    error: {
      code: "payment_request_aborted",
      message: "Payment provider request was aborted",
      retryable: true,
    },
  };
}
