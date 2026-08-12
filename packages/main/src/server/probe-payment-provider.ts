import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { prisma } from "./lib/db";
import { BtcPayPaymentProvider } from "./providers/payment/btcpay";
import type { PaymentInvoice, PaymentProvider } from "./providers/types";
import type { PaymentProviderProbeEvidence, ProbeReportOf } from "./readiness/evidence";
import {
  probeCliArg,
  probeReportPath,
  writeProbeReport,
} from "./readiness/probe-report";

type ProbeOptions = {
  report: string | null;
  checkoutId: string | null;
};

// SPEC: 写出的 JSON 由 launch gate 的 evidence 契约约束，两端共用 readiness/evidence.ts。
type PaymentProbeReport = ProbeReportOf<PaymentProviderProbeEvidence>;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type PaymentCheckoutSnapshot = {
  id: string;
  userId: string;
  planId: string | null;
  provider: string;
  providerSessionId: string | null;
  providerInvoiceStatus: string | null;
  providerInvoiceAdditionalStatus: string | null;
  checkoutUrl: string | null;
  amountCents: number | null;
  currency: string | null;
  status: string;
  returnPath: string | null;
};

type PaymentProviderEventSnapshot = {
  id: string;
  providerEventId: string;
  type: string | null;
  payload: unknown;
  targetHash: string | null;
  processedAt: Date | null;
  deliveries: Array<{
    deliveryId: string;
    payload: unknown;
    payloadHash: string;
  }>;
};

type PaymentSubscriptionSnapshot = {
  id: string;
  status: string;
  provider: string;
  providerSubscriptionId: string | null;
};

type PaymentLedgerSnapshot = {
  id: string;
  userId: string;
  reason: string;
  sourceId: string | null;
  idempotencyKey: string | null;
};

export type PaymentAuthorityReader = {
  findCheckout(checkoutId: string): Promise<PaymentCheckoutSnapshot | null>;
  findProviderEvents(input: {
    provider: string;
    targetHash: string;
  }): Promise<PaymentProviderEventSnapshot[]>;
  findSubscriptions(input: {
    userId: string;
    planId: string;
    provider: string;
    providerSubscriptionId: string;
  }): Promise<PaymentSubscriptionSnapshot[]>;
  countSubscriptionEntitlements(userId: string): Promise<number>;
  findLedgerEntries(idempotencyKey: string): Promise<PaymentLedgerSnapshot[]>;
};

function readOptions(): ProbeOptions {
  return {
    report: probeReportPath("paymentProviderProbe"),
    checkoutId:
      probeCliArg("checkout-id") ??
      process.env.PAYMENT_PROVIDER_PROBE_CHECKOUT_ID ??
      null,
  };
}

async function main() {
  const options = readOptions();
  const report = await runProbe({
    provider: process.env.PAYMENT_PROVIDER ?? "mock",
    baseUrl: process.env.BTCPAY_BASE_URL ?? null,
    storeId: process.env.BTCPAY_STORE_ID ?? null,
    apiKey: process.env.BTCPAY_API_KEY ?? null,
    checkoutId: options.checkoutId,
  });

  if (options.report) {
    await writeProbeReport(options.report, report);
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

// SPEC: production payment readiness is a read-only audit of one checkout created by
// the real product flow. The probe never POSTs a detached invoice or fabricates a webhook.
export async function runProbe(input: {
  provider: string;
  baseUrl: string | null;
  storeId: string | null;
  apiKey: string | null;
  checkoutId: string | null;
  fetchImpl?: FetchLike;
  authorityReader?: PaymentAuthorityReader;
  paymentProvider?: Pick<PaymentProvider, "findInvoiceByOrderId">;
  now?: () => Date;
}): Promise<PaymentProbeReport> {
  const now = input.now ?? (() => new Date());
  const checkedAt = now().toISOString();
  const startedAt = Date.now();
  const baseReport = {
    checkedAt,
    provider: input.provider,
    baseUrl: input.baseUrl,
    storeId: input.storeId,
    canViewStore: false,
    returnedStoreId: null,
    // Legacy evidence is intentionally false: this probe no longer creates orphan invoices.
    canCreateInvoice: false,
    canLookupInvoice: false,
    invoiceId: null,
    checkoutUrl: null,
    invoiceAmountCents: 0,
    invoiceCurrency: null,
    terminal: null,
  } satisfies Omit<PaymentProbeReport, "ok" | "durationMs" | "error">;

  if (input.provider !== "btcpay") {
    return failedReport(baseReport, startedAt, {
      code: "unsupported_payment_provider",
      message: `Payment terminal probe requires btcpay, received ${input.provider}`,
      retryable: false,
    });
  }
  if (!input.checkoutId?.trim()) {
    return failedReport(baseReport, startedAt, {
      code: "payment_probe_checkout_id_required",
      message:
        "--checkout-id (or PAYMENT_PROVIDER_PROBE_CHECKOUT_ID) must identify a checkout created and settled through the real product flow",
      retryable: false,
    });
  }

  try {
    const baseUrl = requireValue("BTCPAY_BASE_URL", input.baseUrl);
    const storeId = requireValue("BTCPAY_STORE_ID", input.storeId);
    const apiKey = requireValue("BTCPAY_API_KEY", input.apiKey);
    const fetchImpl = input.fetchImpl ?? fetch;
    const authorityReader = input.authorityReader ?? prismaPaymentAuthorityReader;
    const checkout = await authorityReader.findCheckout(input.checkoutId);
    if (!checkout) {
      return failedReport(baseReport, startedAt, {
        code: "payment_probe_checkout_not_found",
        message: `Checkout ${input.checkoutId} was not found in Main`,
        retryable: false,
      });
    }

    const checkoutReport = {
      ...baseReport,
      invoiceId: checkout.providerSessionId,
      checkoutUrl: checkout.checkoutUrl,
      invoiceAmountCents: checkout.amountCents ?? 0,
      invoiceCurrency: checkout.currency?.toUpperCase() ?? null,
    };
    const store = await readStore({ baseUrl, storeId, apiKey, fetchImpl });
    if (!store.ok) {
      return failedReport(checkoutReport, startedAt, store.error);
    }

    const paymentProvider =
      input.paymentProvider ??
      new BtcPayPaymentProvider({
        baseUrl,
        storeId,
        apiKey,
        // Lookup is read-only and never evaluates webhook signatures.
        webhookSecret: "unused-by-read-only-payment-probe",
        fetchImpl,
      });
    const lookup = await paymentProvider.findInvoiceByOrderId({ orderId: checkout.id });
    if (!lookup.ok) {
      return failedReport(
        {
          ...checkoutReport,
          canViewStore: true,
          returnedStoreId: store.returnedStoreId,
        },
        startedAt,
        lookup.error,
      );
    }
    if (!lookup.data) {
      return failedReport(
        {
          ...checkoutReport,
          canViewStore: true,
          returnedStoreId: store.returnedStoreId,
        },
        startedAt,
        {
          code: "payment_probe_invoice_not_found",
          message: `BTCPay returned no invoice for product checkout ${checkout.id}`,
          retryable: true,
        },
      );
    }

    const authority = await inspectPaymentTerminalAuthority({
      authorityReader,
      checkout,
      invoice: lookup.data,
    });
    const evidence = {
      ...checkoutReport,
      canViewStore: true,
      returnedStoreId: store.returnedStoreId,
      canLookupInvoice: true,
      invoiceId: lookup.data.invoiceId,
      checkoutUrl: lookup.data.checkoutUrl,
      invoiceAmountCents: lookup.data.amountCents,
      invoiceCurrency: lookup.data.currency.toUpperCase(),
    };
    if (!authority.ok) {
      return failedReport(evidence, startedAt, {
        code: "payment_terminal_authority_invalid",
        message: authority.problems.join("; "),
        retryable: false,
      });
    }

    return {
      ...evidence,
      ok: true,
      durationMs: Date.now() - startedAt,
      terminal: authority.terminal,
      error: null,
    };
  } catch (error) {
    return failedReport(baseReport, startedAt, {
      code: "payment_probe_failed",
      message: error instanceof Error ? error.message : String(error),
      retryable: true,
    });
  }
}

export async function inspectPaymentTerminalAuthority(input: {
  authorityReader: PaymentAuthorityReader;
  checkout: PaymentCheckoutSnapshot;
  invoice: PaymentInvoice;
}): Promise<
  | { ok: true; terminal: NonNullable<PaymentProbeReport["terminal"]> }
  | { ok: false; problems: string[] }
> {
  const { authorityReader, checkout, invoice } = input;
  const problems: string[] = [];
  if (checkout.provider !== "btcpay") problems.push("checkout provider is not btcpay");
  if (checkout.status !== "completed") problems.push("checkout is not completed");
  if (!checkout.planId) problems.push("checkout has no plan authority");
  if (!checkout.returnPath) problems.push("checkout has no return path");
  if (checkout.providerSessionId !== invoice.invoiceId) {
    problems.push("provider invoice id does not match the checkout");
  }
  if (invoice.provider !== "btcpay" || invoice.orderId !== checkout.id) {
    problems.push("provider lookup does not bind the exact checkout order");
  }
  if (
    checkout.amountCents === null ||
    checkout.amountCents !== invoice.amountCents ||
    !checkout.currency ||
    checkout.currency.toLowerCase() !== invoice.currency.toLowerCase()
  ) {
    problems.push("provider invoice amount or currency does not match the checkout");
  }
  if (checkout.checkoutUrl && checkout.checkoutUrl !== invoice.checkoutUrl) {
    problems.push("provider checkout URL does not match the product checkout");
  }
  if (
    invoice.status !== "settled" ||
    checkout.providerInvoiceStatus !== "settled" ||
    checkout.providerInvoiceAdditionalStatus !== invoice.additionalStatus ||
    !acceptedSettlementAdditionalStatuses.has(invoice.additionalStatus)
  ) {
    problems.push("provider and product settlement statuses are not exact");
  }

  if (!checkout.providerSessionId || !checkout.planId) {
    return { ok: false, problems };
  }
  const targetHash = paymentTargetHash({
    type: "invoice.confirmed",
    invoiceId: checkout.providerSessionId,
    orderId: checkout.id,
  });
  const [events, subscriptions, entitlementCount, ledgerEntries] = await Promise.all([
    authorityReader.findProviderEvents({ provider: checkout.provider, targetHash }),
    authorityReader.findSubscriptions({
      userId: checkout.userId,
      planId: checkout.planId,
      provider: checkout.provider,
      providerSubscriptionId: checkout.providerSessionId,
    }),
    authorityReader.countSubscriptionEntitlements(checkout.userId),
    authorityReader.findLedgerEntries(
      `subscription:grant:${checkout.provider}:${checkout.providerSessionId}`,
    ),
  ]);

  if (events.length !== 1) problems.push("settlement must map to exactly one provider event");
  const event = events[0];
  if (
    !event ||
    event.type !== "invoice.confirmed" ||
    event.targetHash !== targetHash ||
    !event.processedAt ||
    !paymentPayloadMatches(event.payload, checkout.id, checkout.providerSessionId)
  ) {
    problems.push("processed settlement event identity or payload is invalid");
  }
  const deliveries = event?.deliveries ?? [];
  if (
    deliveries.length < 2 ||
    new Set(deliveries.map((delivery) => delivery.deliveryId)).size !== deliveries.length ||
    deliveries.some(
      (delivery) =>
        !/^[a-f0-9]{64}$/i.test(delivery.payloadHash) ||
        !paymentPayloadMatches(delivery.payload, checkout.id, checkout.providerSessionId!),
    )
  ) {
    problems.push("settlement replay does not contain two exact target deliveries");
  }

  if (subscriptions.length !== 1) {
    problems.push("settlement must produce exactly one invoice-bound subscription");
  }
  const subscription = subscriptions[0];
  if (
    !subscription ||
    subscription.provider !== checkout.provider ||
    subscription.providerSubscriptionId !== checkout.providerSessionId ||
    !acceptedSubscriptionStatuses.has(subscription.status)
  ) {
    problems.push("invoice-bound subscription authority is invalid");
  }
  if (entitlementCount < 1) problems.push("subscription produced no entitlement");
  if (ledgerEntries.length !== 1) {
    problems.push("settlement must produce exactly one ledger grant");
  }
  const ledger = ledgerEntries[0];
  if (
    !ledger ||
    !subscription ||
    ledger.userId !== checkout.userId ||
    ledger.reason !== "subscription_grant" ||
    ledger.sourceId !== subscription.id ||
    ledger.idempotencyKey !==
      `subscription:grant:${checkout.provider}:${checkout.providerSessionId}`
  ) {
    problems.push("ledger grant is not bound to the invoice subscription");
  }

  if (problems.length > 0 || !event || !subscription || !ledger) {
    return { ok: false, problems };
  }
  return {
    ok: true,
    terminal: {
      authorityVersion: "payment_product_settlement_v1",
      checkoutId: checkout.id,
      checkoutStatus: checkout.status,
      checkoutReturnPath: checkout.returnPath,
      providerInvoiceId: invoice.invoiceId,
      providerInvoiceStatus: invoice.status,
      providerInvoiceAdditionalStatus: invoice.additionalStatus,
      providerLookupVerified: true,
      providerEventId: event.providerEventId,
      providerEventType: event.type,
      providerEventProcessedAt: event.processedAt!.toISOString(),
      providerEventTargetHash: targetHash,
      providerDeliveryCount: deliveries.length,
      providerDeliveryIds: deliveries.map((delivery) => delivery.deliveryId),
      providerDeliveryPayloadHashes: deliveries.map((delivery) => delivery.payloadHash),
      replayVerified: true,
      subscriptionId: subscription.id,
      subscriptionStatus: subscription.status,
      subscriptionEffectCount: subscriptions.length,
      entitlementCount,
      ledgerEntryId: ledger.id,
      ledgerEntryCount: ledgerEntries.length,
    },
  };
}

const prismaPaymentAuthorityReader: PaymentAuthorityReader = {
  findCheckout: (checkoutId) =>
    prisma.checkoutSession.findUnique({
      where: { id: checkoutId },
      select: {
        id: true,
        userId: true,
        planId: true,
        provider: true,
        providerSessionId: true,
        providerInvoiceStatus: true,
        providerInvoiceAdditionalStatus: true,
        checkoutUrl: true,
        amountCents: true,
        currency: true,
        status: true,
        returnPath: true,
      },
    }),
  findProviderEvents: (input) =>
    prisma.providerEvent.findMany({
      where: {
        provider: input.provider,
        type: "invoice.confirmed",
        targetHash: input.targetHash,
      },
      include: {
        deliveries: {
          select: {
            deliveryId: true,
            payload: true,
            payloadHash: true,
          },
          orderBy: { receivedAt: "asc" },
        },
      },
      orderBy: { createdAt: "asc" },
    }),
  findSubscriptions: (input) =>
    prisma.subscription.findMany({
      where: input,
      select: {
        id: true,
        status: true,
        provider: true,
        providerSubscriptionId: true,
      },
      orderBy: { createdAt: "asc" },
    }),
  countSubscriptionEntitlements: (userId) =>
    prisma.entitlement.count({ where: { userId, source: "subscription" } }),
  findLedgerEntries: (idempotencyKey) =>
    prisma.dreamcoinLedger.findMany({
      where: { idempotencyKey },
      select: {
        id: true,
        userId: true,
        reason: true,
        sourceId: true,
        idempotencyKey: true,
      },
    }),
};

const acceptedSettlementAdditionalStatuses = new Set([
  "none",
  "marked",
  "paid_late",
  "paid_over",
]);
const acceptedSubscriptionStatuses = new Set(["active", "checkout_completed"]);

function paymentTargetHash(input: {
  type: "invoice.confirmed";
  invoiceId: string;
  orderId: string;
}) {
  return createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex");
}

function paymentPayloadMatches(value: unknown, orderId: string, invoiceId: string) {
  const payload = asRecord(value);
  const metadata = asRecord(payload.metadata);
  const nestedInvoice = asRecord(payload.invoice);
  const type = stringField(payload, "type") ?? stringField(payload, "eventType");
  const payloadInvoiceId =
    stringField(payload, "invoiceId") ?? stringField(nestedInvoice, "id");
  const payloadOrderId = stringField(metadata, "orderId") ?? stringField(payload, "orderId");
  return type === "InvoiceSettled" && payloadInvoiceId === invoiceId && payloadOrderId === orderId;
}

async function readStore(input: {
  baseUrl: string;
  storeId: string;
  apiKey: string;
  fetchImpl: FetchLike;
}): Promise<
  | { ok: true; returnedStoreId: string | null }
  | {
      ok: false;
      error: { code: string; message: string; retryable: boolean };
    }
> {
  const endpoint = new URL(
    `/api/v1/stores/${encodeURIComponent(input.storeId)}`,
    input.baseUrl,
  );
  const response = await input.fetchImpl(endpoint, {
    method: "GET",
    headers: {
      authorization: `token ${input.apiKey}`,
      accept: "application/json",
    },
  });
  const json = (await response.json().catch(() => ({}))) as unknown;
  if (!response.ok) {
    return {
      ok: false,
      error: {
        code: "btcpay_store_read_failed",
        message:
          responseErrorMessage(json) ??
          `BTCPay store read failed with HTTP ${response.status}`,
        retryable: response.status === 429 || response.status >= 500,
      },
    };
  }
  const returnedStoreId = stringField(asRecord(json), "id") ?? null;
  if (returnedStoreId !== input.storeId) {
    return {
      ok: false,
      error: {
        code: "btcpay_store_identity_mismatch",
        message: "BTCPay store response did not match BTCPAY_STORE_ID",
        retryable: false,
      },
    };
  }
  return { ok: true, returnedStoreId };
}

function failedReport(
  base: Omit<PaymentProbeReport, "ok" | "durationMs" | "error">,
  startedAt: number,
  error: NonNullable<PaymentProbeReport["error"]>,
): PaymentProbeReport {
  return {
    ...base,
    ok: false,
    durationMs: Date.now() - startedAt,
    terminal: null,
    error,
  };
}

function responseErrorMessage(value: unknown) {
  const record = asRecord(value);
  return stringField(record, "message") ?? stringField(record, "error");
}

function requireValue(name: string, value: string | null | undefined) {
  if (!value?.trim()) throw new Error(`${name} is required for payment provider probe`);
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
