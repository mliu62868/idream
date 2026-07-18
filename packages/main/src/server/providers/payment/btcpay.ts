import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  PaymentInvoiceAdditionalStatus,
  PaymentInvoiceStatus,
  PaymentProvider,
  ProviderResult,
} from "../types";
import { paymentProviderCapabilities } from "./capabilities";

export interface BtcPayPaymentProviderConfig {
  baseUrl: string;
  storeId: string;
  apiKey: string;
  webhookSecret: string;
  fetchImpl?: FetchLike;
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const confirmedEventTypes = new Set(["InvoiceSettled"]);

export class BtcPayPaymentProvider implements PaymentProvider {
  readonly capabilities = paymentProviderCapabilities("btcpay");

  private readonly baseUrl: URL;
  private readonly storeId: string;
  private readonly apiKey: string;
  private readonly webhookSecret: string;
  private readonly fetchImpl: FetchLike;

  constructor(config: BtcPayPaymentProviderConfig) {
    this.baseUrl = new URL(config.baseUrl);
    this.storeId = config.storeId;
    this.apiKey = config.apiKey;
    this.webhookSecret = config.webhookSecret;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async createInvoice(input: Parameters<PaymentProvider["createInvoice"]>[0]) {
    const endpoint = this.apiUrl(`/api/v1/stores/${encodeURIComponent(this.storeId)}/invoices`);
    try {
      const response = await this.fetchImpl(endpoint, {
        method: "POST",
        signal: input.signal,
        headers: {
          authorization: `token ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          amount: (input.amountCents / 100).toFixed(2),
          currency: input.currency.toUpperCase(),
          metadata: {
            userId: input.userId,
            ...(input.metadata ?? {}),
            orderId: input.orderId,
          },
        }),
      });
      const json = (await response.json().catch(() => ({}))) as unknown;
      if (!response.ok) return paymentFailure("invoice_create_failed", response.status, json);
      const invoice = invoiceFromRecord(asRecord(json), input.orderId);
      if (
        !invoice ||
        invoice.amountCents !== input.amountCents ||
        invoice.currency !== input.currency.toLowerCase()
      ) {
        return invalidInvoice(
          "invoice_create_invalid",
          "BTCPay create response did not prove the requested order, amount, currency, and status",
        );
      }
      return {
        ok: true as const,
        data: invoice,
      };
    } catch (error) {
      return networkFailure("invoice_create_failed", error);
    }
  }

  async findInvoiceByOrderId(
    input: Parameters<PaymentProvider["findInvoiceByOrderId"]>[0],
  ) {
    const endpoint = this.apiUrl(
      `/api/v1/stores/${encodeURIComponent(this.storeId)}/invoices`,
    );
    endpoint.searchParams.set("orderId", input.orderId);
    endpoint.searchParams.set("take", "1");
    try {
      const response = await this.fetchImpl(endpoint, {
        method: "GET",
        signal: input.signal,
        headers: { authorization: `token ${this.apiKey}` },
      });
      const json = (await response.json().catch(() => [])) as unknown;
      if (!response.ok) {
        return paymentFailure("invoice_lookup_failed", response.status, json);
      }
      const first = Array.isArray(json) ? json[0] : undefined;
      if (!first) return { ok: true as const, data: null };
      const invoice = invoiceFromRecord(asRecord(first), input.orderId);
      if (!invoice) {
        return invalidLookup(
          "BTCPay invoice lookup response was missing authoritative identity, amount, currency, or status",
        );
      }
      return {
        ok: true as const,
        data: invoice,
      };
    } catch (error) {
      return networkFailure("invoice_lookup_failed", error);
    }
  }

  async parseWebhook(input: Parameters<PaymentProvider["parseWebhook"]>[0]) {
    const signatureResult = this.verifySignature(input.rawBody, input.signature);
    if (!signatureResult.ok) return signatureResult;

    const payload = asRecord(input.payload);
    const invoiceId = invoiceIdFromPayload(payload);
    const eventType = stringField(payload, "type") ?? stringField(payload, "eventType");
    const deliveryId =
      stringField(payload, "deliveryId") ??
      stringField(payload, "id") ??
      input.providerEventId;
    const providerEventId =
      stringField(payload, "originalDeliveryId") ??
      deliveryId;
    const metadata = asRecord(payload.metadata);
    const orderId = stringField(metadata, "orderId");

    if (!eventType || !confirmedEventTypes.has(eventType)) {
      return {
        ok: true as const,
        data: {
          providerEventId,
          deliveryId,
          type: "invoice.ignored" as const,
          invoiceId,
          ...(orderId ? { orderId } : {}),
        },
      };
    }
    if (!invoiceId) {
      return {
        ok: false as const,
        error: {
          code: "invalid_webhook",
          message: "BTCPay settled webhook missing invoice id",
          retryable: false,
        },
      };
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

  private apiUrl(pathname: string) {
    return new URL(pathname, this.baseUrl);
  }

  private verifySignature(
    rawBody: string | undefined,
    signature: string | undefined,
  ): ProviderResult<null> {
    if (!rawBody || !signature) {
      return {
        ok: false,
        error: {
          code: "invalid_signature",
          message: "BTCPay webhook signature is required",
          retryable: false,
        },
      };
    }

    const expected = createHmac("sha256", this.webhookSecret)
      .update(rawBody)
      .digest("hex");
    const provided = signature.replace(/^sha256=/, "").trim();
    if (!isHexSignature(provided)) {
      return invalidSignature();
    }

    const expectedBuffer = Buffer.from(expected, "hex");
    const providedBuffer = Buffer.from(provided, "hex");
    if (
      providedBuffer.length !== expectedBuffer.length ||
      !timingSafeEqual(providedBuffer, expectedBuffer)
    ) {
      return invalidSignature();
    }

    return { ok: true, data: null };
  }
}

function invoiceIdFromPayload(payload: Record<string, unknown>) {
  const direct = stringField(payload, "invoiceId");
  if (direct) return direct;
  const nested = payload.invoice;
  if (isRecord(nested)) return stringField(nested, "id");
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function invoiceStatus(value: string | undefined): PaymentInvoiceStatus | null {
  switch (value?.trim().toLowerCase()) {
    case "new":
      return "created";
    case "processing":
      return "processing";
    case "settled":
      return "settled";
    case "expired":
      return "expired";
    case "invalid":
      return "invalid";
    default:
      return null;
  }
}

function invoiceAdditionalStatus(
  value: string | undefined,
): PaymentInvoiceAdditionalStatus | null {
  switch (value?.replace(/[^a-z]/gi, "").toLowerCase()) {
    case "none":
      return "none";
    case "marked":
      return "marked";
    case "paidlate":
      return "paid_late";
    case "paidover":
      return "paid_over";
    case "paidpartial":
      return "paid_partial";
    default:
      return null;
  }
}

function decimalAmountCents(value: unknown) {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  const cents = Math.round(numeric * 100);
  return Math.abs(cents / 100 - numeric) < 1e-9 ? cents : null;
}

function invoiceFromRecord(
  record: Record<string, unknown>,
  expectedOrderId: string,
) {
  const invoiceId = stringField(record, "id");
  const checkoutUrl = stringField(record, "checkoutLink");
  const status = invoiceStatus(stringField(record, "status"));
  const additionalStatus = invoiceAdditionalStatus(
    stringField(record, "additionalStatus"),
  );
  const metadata = asRecord(record.metadata);
  const orderId =
    stringField(metadata, "orderId") ?? stringField(record, "orderId");
  const amountCents = decimalAmountCents(record.amount);
  const currency = stringField(record, "currency")?.toLowerCase();
  if (
    !invoiceId ||
    !checkoutUrl ||
    !status ||
    !additionalStatus ||
    orderId !== expectedOrderId ||
    amountCents === null ||
    !currency
  ) {
    return null;
  }
  return {
    provider: "btcpay" as const,
    invoiceId,
    checkoutUrl,
    status,
    additionalStatus,
    orderId,
    amountCents,
    currency,
  };
}

function invalidLookup(message: string): ProviderResult<never> {
  return {
    ok: false,
    error: {
      code: "invoice_lookup_invalid",
      message,
      retryable: false,
    },
  };
}

function invalidInvoice(code: string, message: string): ProviderResult<never> {
  return {
    ok: false,
    error: {
      code,
      message,
      retryable: false,
    },
  };
}

function isHexSignature(value: string) {
  return /^[a-fA-F0-9]{64}$/.test(value);
}

function invalidSignature(): ProviderResult<never> {
  return {
    ok: false,
    error: {
      code: "invalid_signature",
      message: "BTCPay webhook signature is invalid",
      retryable: false,
    },
  };
}

function paymentFailure(
  code: string,
  status: number,
  value: unknown,
): ProviderResult<never> {
  const record = asRecord(value);
  const message =
    stringField(record, "message") ??
    stringField(record, "error") ??
    `BTCPay request failed with HTTP ${status}`;
  return {
    ok: false,
    error: {
      code,
      message,
      retryable: status === 429 || status >= 500,
    },
  };
}

function networkFailure(code: string, error: unknown): ProviderResult<never> {
  return {
    ok: false,
    error: {
      code,
      message: error instanceof Error ? error.message : "BTCPay request failed",
      retryable: true,
    },
  };
}
