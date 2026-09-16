import type { CheckoutSession, Prisma } from "@prisma/client";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import type { PaymentInvoicePaymentEvidence } from "@/server/providers/types";
import { canonicalSha256 } from "../admin-v2/shared/canonical-json";
import { toInputJson } from "../admin-v2/shared/prisma-json";
import { classifyCustomerMetricActor } from "../admin-v2/metrics/event-classification";

type Checkout = Pick<CheckoutSession, "id" | "userId" | "provider" | "providerSessionId">;

/** Preserve native-currency precision; lexical formatting is not an economic conflict. */
export function canonicalCaptureAmount(value: string): string | null {
  if (value.length > 256 || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const [whole, fractional = ""] = value.split(".");
  const integer = whole.replace(/^0+(?=\d)/, "");
  const fraction = fractional.replace(/0+$/, "");
  const amount = fraction ? `${integer}.${fraction}` : integer;
  return amount === "0" ? null : amount;
}

// INVARIANT: No invoice face value, Plan price, coin ledger or FX conversion can
// create a cash receipt. Only the provider's independently accounted payments do.
export async function recordInvoiceCashCapturesInTx(
  tx: Prisma.TransactionClient,
  checkout: Checkout,
  evidence: PaymentInvoicePaymentEvidence | null,
) {
  const unavailable = async (reason: string) => {
    await tx.dataQualityCheck.create({ data: {
      checkKey: "billing.cash_capture_evidence", status: "unavailable", metricKeys: ["margin.character_contribution_7d"],
      observed: { checkoutId: checkout.id, invoiceId: evidence?.invoiceId ?? checkout.providerSessionId, reason },
      threshold: { expression: "independent accounted settled payment evidence required" },
      evidence: { provider: checkout.provider, checkoutId: checkout.id, invoiceId: evidence?.invoiceId ?? checkout.providerSessionId, reason },
    } });
    return { status: "unavailable" as const, reason, createdCount: 0, duplicateCount: 0 };
  };
  if (!evidence) return unavailable("verified_payment_evidence_missing");
  if (evidence.status !== "verified") return unavailable(evidence.reason);
  if (evidence.provider !== "btcpay" || checkout.provider !== evidence.provider
    || checkout.id !== evidence.orderId
    || (checkout.providerSessionId !== null && checkout.providerSessionId !== evidence.invoiceId)) {
    throw Errors.conflict("Cash payment evidence does not belong to this checkout", { blocker: "cash_capture_checkout_mismatch", checkoutId: checkout.id });
  }
  if (evidence.payments.length === 0 || !evidence.merchantAccountId) return unavailable("accounted_settled_payment_missing");
  const prepared = [];
  for (const payment of evidence.payments) {
    const amount = canonicalCaptureAmount(payment.amount);
    const receivedAt = new Date(payment.receivedAt);
    if (!amount || !Number.isFinite(receivedAt.getTime()) || !payment.paymentId || !payment.paymentMethodId || !payment.currency) {
      return unavailable("invalid_accounted_payment_evidence");
    }
    const identity = {
      provider: evidence.provider, merchantAccountId: evidence.merchantAccountId,
      paymentMethodId: payment.paymentMethodId, providerPaymentId: payment.paymentId,
    };
    const economicEvidence = {
      ...identity, providerInvoiceId: evidence.invoiceId, checkoutId: checkout.id,
      amount, currency: payment.currency, receivedAt: receivedAt.toISOString(), source: evidence.source,
    };
    prepared.push({ identity, economicEvidence, receivedAt, sourcePayment: payment, evidenceHash: canonicalSha256(economicEvidence) });
  }
  // Provider response ordering may change between webhook and reconciliation.
  // Acquire unique payment identities in one order to avoid cross-payment deadlocks.
  prepared.sort((left, right) => Object.values(left.identity).join("\0").localeCompare(Object.values(right.identity).join("\0")));
  const classification = await classifyCustomerMetricActor(tx, checkout.userId);
  let createdCount = 0;
  let duplicateCount = 0;
  for (const item of prepared) {
    // ON CONFLICT DO NOTHING is safe for immutable evidence and serializes a
    // concurrent webhook/reconciliation race on the provider payment identity.
    const inserted = await tx.cashCaptureFact.createMany({ skipDuplicates: true, data: [{
      ...item.economicEvidence, receivedAt: item.receivedAt,
      evidenceHash: item.evidenceHash, evidence: toInputJson({ ...item.economicEvidence, providerPayment: item.sourcePayment }),
      environment: env.APP_ENV, dataClass: classification.dataClass, actorIsInternal: classification.actor.isInternal,
    }] });
    const persisted = await tx.cashCaptureFact.findUniqueOrThrow({ where: {
      provider_merchantAccountId_paymentMethodId_providerPaymentId: item.identity,
    } });
    if (persisted.evidenceHash !== item.evidenceHash) {
      throw Errors.conflict("Provider payment identity was reused with different cash evidence", {
        blocker: "cash_capture_identity_conflict", captureFactId: persisted.id,
        checkoutId: checkout.id, providerInvoiceId: evidence.invoiceId,
      });
    }
    createdCount += inserted.count;
    duplicateCount += inserted.count === 0 ? 1 : 0;
  }
  await tx.dataQualityCheck.create({ data: {
    checkKey: "billing.cash_capture_evidence", status: "passed", metricKeys: ["margin.character_contribution_7d"],
    observed: { checkoutId: checkout.id, invoiceId: evidence.invoiceId, capturedPayments: prepared.length },
    threshold: { expression: "independent accounted settled payment evidence required" },
    evidence: {
      provider: evidence.provider, merchantAccountId: evidence.merchantAccountId,
      source: evidence.source, checkoutId: checkout.id, invoiceId: evidence.invoiceId,
      paymentEvidenceHashes: prepared.map((item) => item.evidenceHash),
      // Evidence for these receipts grants neither invoice completeness nor Character attribution.
      characterAttributionCertified: false,
    },
  } });
  return { status: "recorded" as const, createdCount, duplicateCount };
}
