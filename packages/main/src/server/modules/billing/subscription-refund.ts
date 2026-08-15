import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { Errors } from "@/server/lib/errors";
import { toInputJson } from "@/server/lib/request-json";
import { postDreamcoinEntry } from "@/server/modules/billing/ledger";
import {
  activeSubscriptionWhere,
  lockUserLedger,
  syncSubscriptionEntitlements,
} from "@/server/modules/ourdream/subscription-lifecycle";
import type { PaymentRefund } from "@/server/providers/types";

const refundPayoutSchema = z.object({
  payoutId: z.string().min(1),
  amount: z.string().min(1),
  currency: z.string().min(1),
  state: z.enum([
    "awaiting_approval",
    "awaiting_payment",
    "in_progress",
    "completed",
    "canceled",
  ]),
  paymentProofId: z.string().min(1).optional(),
});

export const subscriptionRefundEvidenceSchema = z.object({
  schemaVersion: z.literal("subscription-refund-v1"),
  commandId: z.string().min(1),
  subscriptionId: z.string().min(1),
  checkoutId: z.string().min(1),
  provider: z.string().min(1),
  providerInvoiceId: z.string().min(1),
  reference: z.string().min(1),
  amountCents: z.number().int().positive(),
  currency: z.string().min(1),
  reversedDreamcoins: z.number().int().positive(),
  balanceAfter: z.number().int(),
  grantLedgerEntryId: z.string().min(1),
  reversalLedgerEntryId: z.string().min(1),
  originalPeriodEnd: z.string().datetime().nullable(),
  requestedAt: z.string().datetime(),
  requestedBy: z.string().min(1),
  reason: z.string().min(1),
  state: z.enum([
    "provider_dispatching",
    "provider_unknown",
    "claimable",
    "awaiting_approval",
    "awaiting_payment",
    "in_progress",
    "completed",
    "canceled",
  ]),
  providerRefundId: z.string().min(1).optional(),
  claimUrl: z.string().url().optional(),
  providerAmount: z.string().min(1).optional(),
  providerCurrency: z.string().min(1).optional(),
  payouts: z.array(refundPayoutSchema).default([]),
  lastVerifiedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  restoredAt: z.string().datetime().optional(),
  restorationLedgerEntryId: z.string().min(1).optional(),
  restoredBalanceAfter: z.number().int().optional(),
});

export type SubscriptionRefundEvidence = z.infer<
  typeof subscriptionRefundEvidenceSchema
>;

export function parseSubscriptionRefundEvidence(value: unknown) {
  const record = asRecord(value);
  const parsed = subscriptionRefundEvidenceSchema.safeParse(
    record.refund ?? value,
  );
  return parsed.success ? parsed.data : null;
}

export function withSubscriptionRefundEvidence(
  existing: unknown,
  refund: SubscriptionRefundEvidence,
) {
  return { ...asRecord(existing), refund };
}

export function applyProviderRefundEvidence(
  current: SubscriptionRefundEvidence,
  refund: PaymentRefund,
  now = new Date(),
): SubscriptionRefundEvidence {
  if (refund.reference !== current.reference) {
    throw new Error("Provider refund reference changed");
  }
  if (
    refund.currency !== current.currency.toLowerCase() ||
    decimalAmountCents(refund.amount) !== current.amountCents
  ) {
    throw new Error("Provider refund amount or currency changed");
  }
  return {
    ...current,
    state: refund.state,
    providerRefundId: refund.refundId,
    claimUrl: refund.claimUrl,
    providerAmount: refund.amount,
    providerCurrency: refund.currency,
    payouts: refund.payouts,
    lastVerifiedAt: now.toISOString(),
    ...(refund.state === "completed"
      ? { completedAt: now.toISOString() }
      : {}),
  };
}

export function publicSubscriptionRefundDTO(
  refund: SubscriptionRefundEvidence,
) {
  return {
    subscriptionId: refund.subscriptionId,
    checkoutId: refund.checkoutId,
    reference: refund.reference,
    state: refund.state,
    amountCents: refund.amountCents,
    currency: refund.currency,
    reversedDreamcoins: refund.reversedDreamcoins,
    balanceAfter: refund.balanceAfter,
    claimUrl:
      refund.state === "completed" || refund.state === "canceled"
        ? null
        : (refund.claimUrl ?? null),
    providerRefundId: refund.providerRefundId ?? null,
    payouts: refund.payouts.map((payout) => ({
      payoutId: payout.payoutId,
      state: payout.state,
      paymentProofId: payout.paymentProofId ?? null,
    })),
    requestedAt: refund.requestedAt,
    completedAt: refund.completedAt ?? null,
    restoredAt: refund.restoredAt ?? null,
    restoredBalanceAfter: refund.restoredBalanceAfter ?? null,
  };
}

// INVARIANT: The caller locks checkout before subscription. This transition is
// the sole projection from provider refund truth into subscription, entitlement,
// checkout, and Dreamcoin state, so admin polling and webhooks cannot diverge.
export async function projectSubscriptionRefundInTx(
  tx: Prisma.TransactionClient,
  input: {
    checkoutId: string;
    expectedReference: string;
    providerRefund: PaymentRefund;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const checkout = await tx.checkoutSession.findUniqueOrThrow({
    where: { id: input.checkoutId },
  });
  const current = parseSubscriptionRefundEvidence(
    checkout.reconciliationEvidence,
  );
  if (!current || current.reference !== input.expectedReference) {
    throw Errors.conflict("Refund authority changed before provider convergence");
  }
  let evidence = applyProviderRefundEvidence(
    current,
    input.providerRefund,
    now,
  );
  const subscription = await tx.subscription.findUniqueOrThrow({
    where: { id: current.subscriptionId },
    include: { plan: true },
  });

  if (evidence.state === "canceled") {
    await lockUserLedger(tx, subscription.userId);
    const competingActive = await tx.subscription.findFirst({
      where: {
        ...activeSubscriptionWhere(subscription.userId, now),
        id: { not: subscription.id },
      },
      select: { id: true },
    });
    if (competingActive) {
      throw Errors.conflict(
        "Canceled refund cannot restore access while another subscription is active",
        {
          subscriptionId: subscription.id,
          competingSubscriptionId: competingActive.id,
        },
      );
    }
    const restoration = await postDreamcoinEntry(tx, {
      kind: "subscription_refund_restore",
      userId: subscription.userId,
      amount: evidence.reversedDreamcoins,
      sourceId: subscription.id,
      idempotencyKey: `subscription:refund:${subscription.id}:${evidence.commandId}:grant-restore`,
    });
    const originalPeriodEnd = evidence.originalPeriodEnd
      ? new Date(evidence.originalPeriodEnd)
      : null;
    const accessActive = Boolean(
      originalPeriodEnd && originalPeriodEnd.getTime() > now.getTime(),
    );
    if (accessActive) {
      await syncSubscriptionEntitlements(
        tx,
        subscription.userId,
        subscription.plan,
        originalPeriodEnd,
      );
    }
    evidence = subscriptionRefundEvidenceSchema.parse({
      ...evidence,
      restoredAt: now.toISOString(),
      restorationLedgerEntryId: restoration.id,
      restoredBalanceAfter: restoration.balanceAfter,
    });
    await tx.subscription.update({
      where: { id: subscription.id },
      data: {
        status: accessActive ? "active" : "expired",
        cancelAtPeriodEnd: false,
      },
    });
    await tx.checkoutSession.update({
      where: { id: checkout.id },
      data: {
        status: "completed",
        failureCode: null,
        needsReconciliation: false,
        reconciliationEvidence: toInputJson(
          withSubscriptionRefundEvidence(
            checkout.reconciliationEvidence,
            evidence,
          ),
        ),
      },
    });
    return {
      checkout,
      evidence,
      subscriptionStatus: accessActive ? "active" : "expired",
      terminal: true,
      restored: true,
    } as const;
  }

  const completed = evidence.state === "completed";
  const subscriptionStatus = completed ? "refunded" : "refund_pending";
  await tx.subscription.update({
    where: { id: subscription.id },
    data: { status: subscriptionStatus, cancelAtPeriodEnd: false },
  });
  await tx.checkoutSession.update({
    where: { id: checkout.id },
    data: {
      status: completed ? "refunded" : "refund_pending",
      failureCode: completed ? null : `provider_refund_${evidence.state}`,
      needsReconciliation: !completed,
      reconciliationEvidence: toInputJson(
        withSubscriptionRefundEvidence(
          checkout.reconciliationEvidence,
          evidence,
        ),
      ),
    },
  });
  return {
    checkout,
    evidence,
    subscriptionStatus,
    terminal: completed,
    restored: false,
  } as const;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function decimalAmountCents(value: string) {
  if (!/^\d+(?:\.\d+)?$/.test(value)) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const cents = Math.round(numeric * 100);
  return Math.abs(cents / 100 - numeric) < 1e-9 ? cents : null;
}
