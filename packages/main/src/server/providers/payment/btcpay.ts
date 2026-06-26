import { createHmac, timingSafeEqual } from "node:crypto";
import type { PaymentProvider, ProviderResult } from "../types";

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
          },
        }),
      });
      const json = (await response.json().catch(() => ({}))) as unknown;
      if (!response.ok) return paymentFailure("invoice_create_failed", response.status, json);
      const record = asRecord(json);
      const invoiceId = stringField(record, "id");
      const checkoutUrl = stringField(record, "checkoutLink");
      if (!invoiceId || !checkoutUrl) {
        return {
          ok: false as const,
          error: {
            code: "invoice_create_failed",
            message: "BTCPay invoice response missing id or checkoutLink",
            retryable: true,
          },
        };
      }
      return {
        ok: true as const,
        data: {
          provider: "btcpay" as const,
          invoiceId,
          checkoutUrl,
          status: "created" as const,
        },
      };
    } catch (error) {
      return networkFailure("invoice_create_failed", error);
    }
  }

  async parseWebhook(input: Parameters<PaymentProvider["parseWebhook"]>[0]) {
    const signatureResult = this.verifySignature(input.rawBody, input.signature);
    if (!signatureResult.ok) return signatureResult;

    const payload = asRecord(input.payload);
    const invoiceId = invoiceIdFromPayload(payload);
    const eventType = stringField(payload, "type") ?? stringField(payload, "eventType");
    const providerEventId =
      stringField(payload, "deliveryId") ??
      stringField(payload, "id") ??
      input.providerEventId;

    if (!eventType || !confirmedEventTypes.has(eventType)) {
      return {
        ok: true as const,
        data: {
          providerEventId,
          type: "invoice.ignored" as const,
          invoiceId,
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
        type: "invoice.confirmed" as const,
        invoiceId,
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
