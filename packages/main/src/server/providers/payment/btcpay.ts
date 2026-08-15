import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  PaymentInvoiceAdditionalStatus,
  PaymentInvoiceStatus,
  PaymentProvider,
  PaymentRefund,
  PaymentRefundPayout,
  PaymentRefundState,
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
const payoutEventTypes = new Set([
  "PayoutCreated",
  "PayoutApproved",
  "PayoutUpdated",
]);

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

  async createRefund(input: Parameters<PaymentProvider["createRefund"]>[0]) {
    const endpoint = this.apiUrl(
      `/api/v1/invoices/${encodeURIComponent(input.invoiceId)}/refund`,
    );
    try {
      const response = await this.fetchImpl(endpoint, {
        method: "POST",
        signal: input.signal,
        headers: {
          authorization: `token ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: input.reference,
          description: input.reason,
          payoutMethodId: "BTC-CHAIN",
          // INVARIANT: invoice-level variants refund the total provider receipt,
          // including overpayment. Product authority is the settled checkout price.
          refundVariant: "Custom",
          customAmount: (input.amountCents / 100).toFixed(2),
          customCurrency: input.currency.toUpperCase(),
          subtractPercentage: "0",
        }),
      });
      const json = (await response.json().catch(() => ({}))) as unknown;
      if (!response.ok) {
        return paymentFailure("refund_create_failed", response.status, json);
      }
      const refund = refundFromRecord(asRecord(json), input.reference, []);
      if (
        !refund ||
        decimalAmountCents(refund.amount) !== input.amountCents ||
        refund.currency !== input.currency.toLowerCase()
      ) {
        return invalidRefund(
          "refund_create_invalid",
          "BTCPay refund response did not prove the exact product purchase amount, currency, identity, and claim URL",
        );
      }
      return { ok: true as const, data: refund };
    } catch (error) {
      return networkFailure("refund_create_failed", error);
    }
  }

  async findRefund(input: Parameters<PaymentProvider["findRefund"]>[0]) {
    try {
      const refundRecord = input.refundId
        ? await this.fetchRefundById(input.refundId, input.signal)
        : input.reference
          ? await this.fetchRefundByReference(input.reference, input.signal)
          : { ok: true as const, data: null };
      if (!refundRecord.ok) return refundRecord;
      if (!refundRecord.data) return { ok: true as const, data: null };

      const refundId = stringField(refundRecord.data, "id");
      if (!refundId) {
        return invalidRefund(
          "refund_lookup_invalid",
          "BTCPay refund lookup response was missing the pull payment id",
        );
      }
      const payoutsEndpoint = this.apiUrl(
        `/api/v1/pull-payments/${encodeURIComponent(refundId)}/payouts`,
      );
      const payoutsResponse = await this.fetchImpl(payoutsEndpoint, {
        method: "GET",
        signal: input.signal,
        headers: { authorization: `token ${this.apiKey}` },
      });
      const payoutsJson = (await payoutsResponse.json().catch(() => [])) as unknown;
      if (!payoutsResponse.ok) {
        return paymentFailure(
          "refund_payout_lookup_failed",
          payoutsResponse.status,
          payoutsJson,
        );
      }
      if (!Array.isArray(payoutsJson)) {
        return invalidRefund(
          "refund_payout_lookup_invalid",
          "BTCPay refund payout lookup did not return a list",
        );
      }
      const payouts = payoutsJson.map(payoutFromRecord);
      if (payouts.some((payout) => payout === null)) {
        return invalidRefund(
          "refund_payout_lookup_invalid",
          "BTCPay refund payout response was missing identity, amount, currency, or state",
        );
      }
      const refund = refundFromRecord(
        refundRecord.data,
        input.reference ?? stringField(refundRecord.data, "name") ?? "",
        payouts as PaymentRefundPayout[],
      );
      if (!refund) {
        return invalidRefund(
          "refund_lookup_invalid",
          "BTCPay refund lookup response did not match the durable product reference",
        );
      }
      return { ok: true as const, data: refund };
    } catch (error) {
      return networkFailure("refund_lookup_failed", error);
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

    if (eventType && payoutEventTypes.has(eventType)) {
      const refundId = stringField(payload, "pullPaymentId");
      const payoutId = stringField(payload, "payoutId");
      const payoutState = paymentRefundState(
        stringField(payload, "payoutState"),
      );
      if (!refundId || !payoutId || !payoutState) {
        return invalidRefund(
          "invalid_webhook",
          "BTCPay payout webhook is missing its refund, payout, or state identity",
        );
      }
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

  private async fetchRefundByReference(
    reference: string,
    signal: AbortSignal | undefined,
  ): Promise<ProviderResult<Record<string, unknown> | null>> {
    const endpoint = this.apiUrl(
      `/api/v1/stores/${encodeURIComponent(this.storeId)}/pull-payments`,
    );
    endpoint.searchParams.set("includeArchived", "true");
    const response = await this.fetchImpl(endpoint, {
      method: "GET",
      signal,
      headers: { authorization: `token ${this.apiKey}` },
    });
    const json = (await response.json().catch(() => [])) as unknown;
    if (!response.ok) {
      return paymentFailure("refund_lookup_failed", response.status, json);
    }
    if (!Array.isArray(json)) {
      return invalidRefund(
        "refund_lookup_invalid",
        "BTCPay pull payment lookup did not return a list",
      );
    }
    const matches = json
      .map(asRecord)
      .filter((record) => stringField(record, "name") === reference);
    if (matches.length > 1) {
      return invalidRefund(
        "refund_lookup_ambiguous",
        "BTCPay returned multiple pull payments for the durable refund reference",
      );
    }
    return { ok: true, data: matches[0] ?? null };
  }

  private async fetchRefundById(
    refundId: string,
    signal: AbortSignal | undefined,
  ): Promise<ProviderResult<Record<string, unknown> | null>> {
    const endpoint = this.apiUrl(
      `/api/v1/pull-payments/${encodeURIComponent(refundId)}`,
    );
    const response = await this.fetchImpl(endpoint, {
      method: "GET",
      signal,
      headers: { authorization: `token ${this.apiKey}` },
    });
    if (response.status === 404) return { ok: true, data: null };
    const json = (await response.json().catch(() => ({}))) as unknown;
    if (!response.ok) {
      return paymentFailure("refund_lookup_failed", response.status, json);
    }
    return { ok: true, data: asRecord(json) };
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

function paymentRefundState(
  value: string | undefined,
): Exclude<PaymentRefundState, "claimable"> | null {
  switch (value?.replace(/[^a-z]/gi, "").toLowerCase()) {
    case "awaitingapproval":
      return "awaiting_approval";
    case "awaitingpayment":
      return "awaiting_payment";
    case "inprogress":
      return "in_progress";
    case "completed":
      return "completed";
    case "cancelled":
    case "canceled":
      return "canceled";
    default:
      return null;
  }
}

function refundFromRecord(
  record: Record<string, unknown>,
  expectedReference: string,
  payouts: PaymentRefundPayout[],
): PaymentRefund | null {
  const refundId = stringField(record, "id");
  const reference = stringField(record, "name");
  const claimUrl = stringField(record, "viewLink");
  const amount = decimalString(record.amount);
  const currency = stringField(record, "currency")?.toLowerCase();
  if (
    !refundId ||
    reference !== expectedReference ||
    !claimUrl ||
    !amount ||
    !currency
  ) {
    return null;
  }
  if (payouts.some((payout) => payout.currency !== currency)) return null;
  const liveAmount = sumDecimals(
    payouts
      .filter((payout) => payout.state !== "canceled")
      .map((payout) => payout.amount),
  );
  if (
    liveAmount === null ||
    compareDecimals(liveAmount, amount) > 0
  ) {
    return null;
  }
  return {
    provider: "btcpay",
    refundId,
    reference,
    claimUrl,
    amount,
    currency,
    state: aggregateRefundState(
      amount,
      currency,
      payouts,
      record.archived === true,
    ),
    payouts,
  };
}

function payoutFromRecord(value: unknown): PaymentRefundPayout | null {
  const record = asRecord(value);
  const payoutId = stringField(record, "id");
  const amount = decimalString(record.originalAmount);
  const currency = stringField(record, "originalCurrency")?.toLowerCase();
  const state = paymentRefundState(stringField(record, "state"));
  const proof = asRecord(record.paymentProof);
  const paymentProofId = stringField(proof, "id");
  if (!payoutId || !amount || !currency || !state) return null;
  return {
    payoutId,
    amount,
    currency,
    state,
    ...(paymentProofId ? { paymentProofId } : {}),
  };
}

function aggregateRefundState(
  amount: string,
  currency: string,
  payouts: PaymentRefundPayout[],
  archived: boolean,
): PaymentRefundState {
  if (payouts.length === 0) return archived ? "canceled" : "claimable";
  const completed = payouts.filter(
    (payout) => payout.state === "completed" && payout.currency === currency,
  );
  const completeAmount = sumDecimals(completed.map((payout) => payout.amount));
  if (
    completeAmount === normalizeDecimal(amount) &&
    payouts.every((payout) =>
      payout.state === "completed" || payout.state === "canceled"
    )
  ) {
    return "completed";
  }
  const live = payouts.filter((payout) => payout.state !== "canceled");
  if (live.length === 0 || archived) return "canceled";
  if (live.some((payout) => payout.state === "in_progress")) {
    return "in_progress";
  }
  if (live.some((payout) => payout.state === "awaiting_payment")) {
    return "awaiting_payment";
  }
  return "awaiting_approval";
}

function decimalString(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = normalizeDecimal(String(value));
  return normalized === null || normalized === "0" ? null : normalized;
}

function normalizeDecimal(value: string): string | null {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return null;
  const whole = (match[1] ?? "0").replace(/^0+(?=\d)/, "");
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function sumDecimals(values: string[]): string | null {
  if (values.length === 0) return "0";
  const scale = Math.max(
    ...values.map((value) => value.split(".")[1]?.length ?? 0),
  );
  let total = "0";
  for (const value of values) {
    const normalized = normalizeDecimal(value);
    if (!normalized) return null;
    const [whole, fraction = ""] = normalized.split(".");
    total = addUnsignedIntegers(
      total,
      `${whole}${fraction.padEnd(scale, "0")}`,
    );
  }
  const digits = total.padStart(scale + 1, "0");
  if (scale === 0) return digits;
  return normalizeDecimal(
    `${digits.slice(0, -scale)}.${digits.slice(-scale)}`,
  );
}

function compareDecimals(left: string, right: string) {
  const normalizedLeft = normalizeDecimal(left);
  const normalizedRight = normalizeDecimal(right);
  if (!normalizedLeft || !normalizedRight) return 0;
  const scale = Math.max(
    normalizedLeft.split(".")[1]?.length ?? 0,
    normalizedRight.split(".")[1]?.length ?? 0,
  );
  const comparable = (value: string) => {
    const [whole, fraction = ""] = value.split(".");
    return `${whole}${fraction.padEnd(scale, "0")}`.replace(/^0+(?=\d)/, "");
  };
  const comparableLeft = comparable(normalizedLeft);
  const comparableRight = comparable(normalizedRight);
  if (comparableLeft.length !== comparableRight.length) {
    return comparableLeft.length > comparableRight.length ? 1 : -1;
  }
  return comparableLeft.localeCompare(comparableRight);
}

function addUnsignedIntegers(left: string, right: string) {
  const width = Math.max(left.length, right.length);
  const a = left.padStart(width, "0");
  const b = right.padStart(width, "0");
  let carry = 0;
  let output = "";
  for (let index = width - 1; index >= 0; index -= 1) {
    const sum = Number(a[index]) + Number(b[index]) + carry;
    output = `${sum % 10}${output}`;
    carry = Math.floor(sum / 10);
  }
  return `${carry || ""}${output}`.replace(/^0+(?=\d)/, "");
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

function invalidRefund(code: string, message: string): ProviderResult<never> {
  return {
    ok: false,
    error: { code, message, retryable: false },
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
