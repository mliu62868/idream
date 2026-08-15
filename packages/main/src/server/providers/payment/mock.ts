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
  private readonly refunds = new Map<
    string,
    {
      provider: "mock";
      refundId: string;
      reference: string;
      claimUrl: string;
      amount: string;
      currency: string;
      state: "claimable";
      payouts: [];
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

  async createRefund(input: Parameters<PaymentProvider["createRefund"]>[0]) {
    if (input.signal?.aborted) return abortedPaymentRequest();
    const refundId = `mock-refund-${input.invoiceId}`;
    const data = {
      provider: "mock" as const,
      refundId,
      reference: input.reference,
      claimUrl: `https://mock-payments.idream.local/refunds/${refundId}`,
      amount: (input.amountCents / 100).toFixed(2),
      currency: input.currency.toLowerCase(),
      state: "claimable" as const,
      payouts: [] as [],
    };
    this.refunds.set(input.reference, data);
    return { ok: true as const, data };
  }

  async findRefund(input: Parameters<PaymentProvider["findRefund"]>[0]) {
    if (input.signal?.aborted) return abortedPaymentRequest();
    const data = input.reference
      ? this.refunds.get(input.reference) ?? null
      : [...this.refunds.values()].find(
          (refund) => refund.refundId === input.refundId,
        ) ?? null;
    return { ok: true as const, data };
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

    if (payload.type === "refund.updated" || payload.type === "PayoutUpdated") {
      const refundId =
        typeof payload.refundId === "string"
          ? payload.refundId
          : typeof payload.pullPaymentId === "string"
            ? payload.pullPaymentId
            : null;
      const payoutId =
        typeof payload.payoutId === "string" ? payload.payoutId : null;
      const payoutState =
        typeof payload.payoutState === "string" &&
        [
          "awaiting_approval",
          "awaiting_payment",
          "in_progress",
          "completed",
          "canceled",
        ].includes(payload.payoutState)
          ? payload.payoutState as
              | "awaiting_approval"
              | "awaiting_payment"
              | "in_progress"
              | "completed"
              | "canceled"
          : null;
      if (refundId && payoutId && payoutState) {
        return {
          ok: true as const,
          data: {
            providerEventId,
            deliveryId,
            type: "refund.updated" as const,
            refundId,
            payoutId,
            payoutState,
          },
        };
      }
    }

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
