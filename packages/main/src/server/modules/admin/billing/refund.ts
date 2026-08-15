import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { adminSubscriptionRefundCommandResponseSchema } from "@idream/shared/admin";
import { z } from "zod";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import { toInputJson } from "@/server/lib/request-json";
import {
  acceptControlPlaneCommand,
  claimControlPlaneCommand,
} from "@/server/modules/admin-v2/shared/control-plane-command";
import { transitionControlPlaneCommandAttempt } from "@/server/modules/admin-v2/shared/control-plane-command-attempt";
import { transitionControlPlaneCommand } from "@/server/modules/admin-v2/shared/control-plane-command-transition";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";
import {
  actorWithPermission,
  jsonBody,
  type AdminActor,
} from "@/server/modules/admin/shared/legacy-primitives";
import { persistTransactionalAdminMutation } from "@/server/modules/admin/shared/transactional-mutation";
import { postDreamcoinEntry } from "@/server/modules/billing/ledger";
import {
  parseSubscriptionRefundEvidence,
  projectSubscriptionRefundInTx,
  publicSubscriptionRefundDTO,
  subscriptionRefundEvidenceSchema,
  withSubscriptionRefundEvidence,
  type SubscriptionRefundEvidence,
} from "@/server/modules/billing/subscription-refund";
import { providers } from "@/server/providers";
import type { PaymentRefund } from "@/server/providers/types";

const requestSchema = z
  .object({
    reason: z.string().trim().min(3).max(2_000),
    confirmation: z.string().trim().min(1).max(240),
  })
  .strict();

export async function requestSubscriptionRefund(
  request: Request,
  subscriptionId: string,
) {
  const actor = await actorWithPermission(
    request,
    "billing.subscription.refund",
  );
  const body = requestSchema.parse(await jsonBody(request));
  if (body.confirmation !== `${subscriptionId}:refund`) {
    throw Errors.badRequest("Confirmation did not match the subscription refund");
  }
  const command = await acceptRefundCommand({
    request,
    actor,
    idempotencyKey: requireIdempotencyKey(request),
    subscriptionId,
    commandType: "billing.subscription.refund",
    coordinationKey: `subscription-refund:${subscriptionId}`,
    reason: body.reason,
  });
  if (command.result) {
    return ok(adminSubscriptionRefundCommandResponseSchema.parse({
      ...command.result,
      replayed: true,
    }));
  }

  let prepared: Awaited<ReturnType<typeof prepareRefund>>;
  try {
    prepared = await prepareRefund({
      request,
      actor,
      subscriptionId,
      commandId: command.id,
      reason: body.reason,
    });
  } catch (cause) {
    await failAcceptedCommand(
      command.id,
      command.attemptNo,
      commandFailure(cause, false),
    );
    throw cause;
  }
  let providerRefund: PaymentRefund | null;
  try {
    providerRefund = await findProviderRefund(prepared.evidence);
  } catch (cause) {
    await failRefundCommand(
      command.id,
      command.attemptNo,
      prepared.checkoutId,
      prepared.evidence,
      commandFailure(cause, true),
    );
    throw cause;
  }
  if (!providerRefund) {
    const created = await providers.payment.createRefund({
      invoiceId: prepared.evidence.providerInvoiceId,
      reference: prepared.evidence.reference,
      reason: body.reason,
      amountCents: prepared.evidence.amountCents,
      currency: prepared.evidence.currency,
    });
    if (!created.ok) {
      await failRefundCommand(
        command.id,
        command.attemptNo,
        prepared.checkoutId,
        prepared.evidence,
        created.error,
      );
      throw Errors.unavailable(
        "Payment provider could not create the refund",
        created.error,
      );
    }
    providerRefund = created.data;
  }
  const result = await convergeProviderRefund({
    request,
    actor,
    commandId: command.id,
    attemptNo: command.attemptNo,
    checkoutId: prepared.checkoutId,
    subscriptionId,
    current: prepared.evidence,
    providerRefund,
    reason: body.reason,
  });
  return ok(adminSubscriptionRefundCommandResponseSchema.parse({
    ...result,
    replayed: false,
  }));
}

export async function reconcileSubscriptionRefund(
  request: Request,
  subscriptionId: string,
) {
  const actor = await actorWithPermission(
    request,
    "billing.subscription.refund",
  );
  const body = requestSchema.parse(await jsonBody(request));
  if (body.confirmation !== `${subscriptionId}:refund_reconcile`) {
    throw Errors.badRequest(
      "Confirmation did not match the subscription refund reconciliation",
    );
  }
  const command = await acceptRefundCommand({
    request,
    actor,
    idempotencyKey: requireIdempotencyKey(request),
    subscriptionId,
    commandType: "billing.subscription.refund.reconcile",
    coordinationKey: `subscription-refund:${subscriptionId}`,
    reason: body.reason,
  });
  if (command.result) {
    return ok(adminSubscriptionRefundCommandResponseSchema.parse({
      ...command.result,
      replayed: true,
    }));
  }

  let checkout: Awaited<ReturnType<typeof checkoutForSubscription>>;
  let evidence: SubscriptionRefundEvidence;
  try {
    checkout = await checkoutForSubscription(subscriptionId);
    const parsedEvidence = parseSubscriptionRefundEvidence(
      checkout.reconciliationEvidence,
    );
    if (!parsedEvidence || parsedEvidence.subscriptionId !== subscriptionId) {
      throw Errors.conflict("Subscription has no refund authority to reconcile");
    }
    evidence = parsedEvidence;
  } catch (cause) {
    await failAcceptedCommand(
      command.id,
      command.attemptNo,
      commandFailure(cause, false),
    );
    throw cause;
  }
  let providerRefund: PaymentRefund | null;
  try {
    providerRefund = await findProviderRefund(evidence);
  } catch (cause) {
    await failRefundCommand(
      command.id,
      command.attemptNo,
      checkout.id,
      evidence,
      commandFailure(cause, true),
    );
    throw cause;
  }
  if (!providerRefund) {
    await failRefundCommand(
      command.id,
      command.attemptNo,
      checkout.id,
      evidence,
      {
        code: "provider_refund_not_visible",
        message: "Provider refund is not visible yet",
        retryable: true,
      },
    );
    throw Errors.unavailable("Provider refund is not visible yet", {
      reference: evidence.reference,
    });
  }
  const result = await convergeProviderRefund({
    request,
    actor,
    commandId: command.id,
    attemptNo: command.attemptNo,
    checkoutId: checkout.id,
    subscriptionId,
    current: evidence,
    providerRefund,
    reason: body.reason,
  });
  return ok(adminSubscriptionRefundCommandResponseSchema.parse({
    ...result,
    replayed: false,
  }));
}

async function acceptRefundCommand(input: {
  request: Request;
  actor: AdminActor;
  idempotencyKey: string;
  subscriptionId: string;
  commandType: string;
  coordinationKey: string;
  reason: string;
}) {
  const requestId =
    input.request.headers.get("x-request-id")?.trim() || randomUUID();
  const accepted = await acceptControlPlaneCommand(prisma, {
    environment: env.APP_ENV,
    actor: input.actor,
    idempotencyKey: input.idempotencyKey,
    coordinationKey: input.coordinationKey,
    commandType: input.commandType,
    target: { type: "subscription", id: input.subscriptionId },
    payload: { reason: input.reason },
    retryMode: "idempotent",
    reason: input.reason,
    requestId,
    maxAttempts: 3,
  });
  const existing = await prisma.controlPlaneCommand.findUniqueOrThrow({
    where: { id: accepted.commandId },
  });
  if (existing.status === "succeeded" && existing.result) {
    return {
      id: existing.id,
      attemptNo: existing.attemptCount,
      result: existing.result as Record<string, unknown>,
    };
  }
  const claimed = await claimControlPlaneCommand(prisma, {
    commandId: existing.id,
    workerId: `${input.commandType}:${process.pid}`,
    leaseMs: 60_000,
  });
  if (!claimed) {
    throw Errors.conflict("The original refund command has not completed", {
      commandId: existing.id,
      status: existing.status,
    });
  }
  return { id: claimed.id, attemptNo: claimed.attemptCount, result: null };
}

async function prepareRefund(input: {
  request: Request;
  actor: AdminActor;
  subscriptionId: string;
  commandId: string;
  reason: string;
}) {
  return prisma.$transaction(async (tx) => {
    const hint = await tx.subscription.findUnique({
      where: { id: input.subscriptionId },
      select: { provider: true, providerSubscriptionId: true },
    });
    if (!hint?.providerSubscriptionId) {
      throw Errors.conflict("Subscription has no provider invoice authority");
    }
    const checkoutIdentity = await tx.checkoutSession.findUnique({
      where: {
        provider_providerSessionId: {
          provider: hint.provider,
          providerSessionId: hint.providerSubscriptionId,
        },
      },
      select: { id: true },
    });
    if (!checkoutIdentity) {
      throw Errors.conflict("Subscription checkout authority is unavailable");
    }
    await tx.$queryRaw`SELECT id FROM "checkout_sessions" WHERE id = ${checkoutIdentity.id} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "subscriptions" WHERE id = ${input.subscriptionId} FOR UPDATE`;
    const checkout = await tx.checkoutSession.findUniqueOrThrow({
      where: { id: checkoutIdentity.id },
      include: { user: { select: { dataClass: true } } },
    });
    const subscription = await tx.subscription.findUniqueOrThrow({
      where: { id: input.subscriptionId },
    });
    const existing = parseSubscriptionRefundEvidence(
      checkout.reconciliationEvidence,
    );
    if (existing && existing.state !== "canceled") {
      if (existing.commandId === input.commandId) {
        return { checkoutId: checkout.id, evidence: existing };
      }
      throw Errors.conflict("Subscription already has a refund request", {
        refundState: existing.state,
        refundReference: existing.reference,
      });
    }
    if (
      checkout.user.dataClass !== "customer" ||
      checkout.userId !== subscription.userId
    ) {
      throw Errors.conflict(
        "Subscription refund is outside customer billing authority",
      );
    }
    if (
      subscription.status !== "active" ||
      checkout.status !== "completed" ||
      checkout.providerInvoiceStatus !== "settled" ||
      checkout.provider !== subscription.provider ||
      checkout.providerSessionId !== subscription.providerSubscriptionId ||
      !checkout.amountCents ||
      !checkout.currency
    ) {
      throw Errors.conflict("Subscription is not an active settled purchase", {
        subscriptionStatus: subscription.status,
        checkoutStatus: checkout.status,
        providerInvoiceStatus: checkout.providerInvoiceStatus,
      });
    }
    const grants = await tx.dreamcoinLedger.findMany({
      where: {
        userId: subscription.userId,
        sourceId: subscription.id,
        reason: "subscription_grant",
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    if (grants.length !== 1 || grants[0]!.delta <= 0) {
      throw Errors.conflict("Subscription grant authority is not singular", {
        subscriptionId: subscription.id,
        grantCount: grants.length,
      });
    }
    const grant = grants[0]!;
    const reversal = await postDreamcoinEntry(tx, {
      kind: "subscription_refund",
      userId: subscription.userId,
      amount: grant.delta,
      sourceId: subscription.id,
      idempotencyKey: `subscription:refund:${subscription.id}:${input.commandId}:grant-reversal`,
    });
    const requestedAt = new Date();
    const evidence = subscriptionRefundEvidenceSchema.parse({
      schemaVersion: "subscription-refund-v1",
      commandId: input.commandId,
      subscriptionId: subscription.id,
      checkoutId: checkout.id,
      provider: checkout.provider,
      providerInvoiceId: checkout.providerSessionId,
      reference: `idream-refund:${checkout.id}:${input.commandId}`,
      amountCents: checkout.amountCents,
      currency: checkout.currency.toLowerCase(),
      reversedDreamcoins: grant.delta,
      balanceAfter: reversal.balanceAfter,
      grantLedgerEntryId: grant.id,
      reversalLedgerEntryId: reversal.id,
      originalPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
      requestedAt: requestedAt.toISOString(),
      requestedBy: input.actor.id,
      reason: input.reason,
      state: "provider_dispatching",
      payouts: [],
    });
    await tx.subscription.update({
      where: { id: subscription.id },
      data: { status: "refund_pending", cancelAtPeriodEnd: false },
    });
    await tx.entitlement.deleteMany({
      where: { userId: subscription.userId, source: "subscription" },
    });
    await tx.checkoutSession.update({
      where: { id: checkout.id },
      data: {
        status: "refund_pending",
        failureCode: "provider_refund_dispatching",
        needsReconciliation: true,
        reconciliationEvidence: toInputJson(
          withSubscriptionRefundEvidence(
            checkout.reconciliationEvidence,
            evidence,
          ),
        ),
      },
    });
    await persistTransactionalAdminMutation(tx, input.request, input.actor, {
      audit: {
        action: "billing.subscription.refund_requested",
        targetType: "subscription",
        targetId: subscription.id,
        reason: input.reason,
        before: {
          subscriptionStatus: subscription.status,
          checkoutStatus: checkout.status,
          balanceBefore: reversal.balanceAfter + grant.delta,
        },
        after: {
          subscriptionStatus: "refund_pending",
          checkoutStatus: "refund_pending",
          reversedDreamcoins: grant.delta,
          balanceAfter: reversal.balanceAfter,
          refundReference: evidence.reference,
        },
      },
      event: {
        eventType: "billing.subscription.refund_requested.v1",
        aggregateType: "subscription",
        aggregateId: subscription.id,
        payload: {
          subscriptionId: subscription.id,
          checkoutId: checkout.id,
          userId: subscription.userId,
          refundReference: evidence.reference,
          reversedDreamcoins: grant.delta,
          balanceAfter: reversal.balanceAfter,
        },
      },
    });
    return { checkoutId: checkout.id, evidence };
  });
}

async function convergeProviderRefund(input: {
  request: Request;
  actor: AdminActor;
  commandId: string;
  attemptNo: number;
  checkoutId: string;
  subscriptionId: string;
  current: SubscriptionRefundEvidence;
  providerRefund: PaymentRefund;
  reason: string;
}) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "checkout_sessions" WHERE id = ${input.checkoutId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "subscriptions" WHERE id = ${input.subscriptionId} FOR UPDATE`;
    const projected = await projectSubscriptionRefundInTx(tx, {
      checkoutId: input.checkoutId,
      expectedReference: input.current.reference,
      providerRefund: input.providerRefund,
    });
    const { checkout, evidence, subscriptionStatus, terminal } = projected;
    const result = {
      checkoutId: checkout.id,
      subscriptionId: input.subscriptionId,
      subscriptionStatus,
      refund: publicSubscriptionRefundDTO(evidence),
      settlement: {
        reversedDreamcoins: evidence.reversedDreamcoins,
        balanceAfter: evidence.balanceAfter,
        restoredDreamcoins: projected.restored
          ? evidence.reversedDreamcoins
          : 0,
        restoredBalanceAfter: evidence.restoredBalanceAfter ?? null,
      },
    };
    await transitionControlPlaneCommand(tx, {
      commandId: input.commandId,
      to: "succeeded",
      expected: { from: "running", attemptCount: input.attemptNo },
      data: {
        result: toInputJson(result),
        needsReconciliation: !terminal,
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        finishedAt: new Date(),
      },
    });
    await transitionControlPlaneCommandAttempt(tx, {
      commandId: input.commandId,
      attemptNo: input.attemptNo,
      to: "succeeded",
      data: { finishedAt: new Date() },
    });
    await persistTransactionalAdminMutation(tx, input.request, input.actor, {
      audit: {
        action:
          evidence.state === "completed"
            ? "billing.subscription.refund_completed"
            : evidence.state === "canceled"
              ? "billing.subscription.refund_canceled_restored"
              : "billing.subscription.refund_provider_state",
        targetType: "subscription",
        targetId: input.subscriptionId,
        reason: input.reason,
        before: { refundState: input.current.state },
        after: {
          refundState: evidence.state,
          providerRefundId: evidence.providerRefundId,
          payoutIds: evidence.payouts.map((payout) => payout.payoutId),
        },
      },
      event: {
        eventType:
          evidence.state === "completed"
            ? "billing.subscription.refunded.v1"
            : evidence.state === "canceled"
              ? "billing.subscription.refund_canceled_restored.v1"
              : "billing.subscription.refund_state.v1",
        aggregateType: "subscription",
        aggregateId: input.subscriptionId,
        payload: {
          subscriptionId: input.subscriptionId,
          checkoutId: checkout.id,
          refundState: evidence.state,
          providerRefundId: evidence.providerRefundId ?? null,
          payoutIds: evidence.payouts.map((payout) => payout.payoutId),
        },
      },
    });
    return result;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

async function failRefundCommand(
  commandId: string,
  attemptNo: number,
  checkoutId: string,
  current: SubscriptionRefundEvidence,
  error: { code: string; message: string; retryable: boolean },
) {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "checkout_sessions" WHERE id = ${checkoutId} FOR UPDATE`;
    const checkout = await tx.checkoutSession.findUniqueOrThrow({
      where: { id: checkoutId },
    });
    const evidence = { ...current, state: "provider_unknown" as const };
    await tx.checkoutSession.update({
      where: { id: checkoutId },
      data: {
        status: "provider_unknown",
        failureCode: "provider_refund_unknown",
        needsReconciliation: true,
        reconciliationEvidence: toInputJson(
          withSubscriptionRefundEvidence(
            checkout.reconciliationEvidence,
            evidence,
          ),
        ),
      },
    });
    await transitionControlPlaneCommand(tx, {
      commandId,
      to: "failed",
      expected: { from: "running", attemptCount: attemptNo },
      data: {
        error: toInputJson(error),
        needsReconciliation: true,
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        finishedAt: new Date(),
      },
    });
    await transitionControlPlaneCommandAttempt(tx, {
      commandId,
      attemptNo,
      to: "failed",
      data: { error: toInputJson(error), finishedAt: new Date() },
    });
  });
}

async function failAcceptedCommand(
  commandId: string,
  attemptNo: number,
  error: { code: string; message: string; retryable: boolean },
) {
  await prisma.$transaction(async (tx) => {
    await transitionControlPlaneCommand(tx, {
      commandId,
      to: "failed",
      expected: { from: "running", attemptCount: attemptNo },
      data: {
        error: toInputJson(error),
        needsReconciliation: error.retryable,
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        finishedAt: new Date(),
      },
    });
    await transitionControlPlaneCommandAttempt(tx, {
      commandId,
      attemptNo,
      to: "failed",
      data: { error: toInputJson(error), finishedAt: new Date() },
    });
  });
}

function commandFailure(cause: unknown, retryable: boolean) {
  return {
    code:
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      typeof cause.code === "string"
        ? cause.code
        : "subscription_refund_failed",
    message: cause instanceof Error ? cause.message : "Subscription refund failed",
    retryable,
  };
}

async function findProviderRefund(evidence: SubscriptionRefundEvidence) {
  const found = await providers.payment.findRefund({
    reference: evidence.reference,
    refundId: evidence.providerRefundId,
  });
  if (!found.ok) {
    throw Errors.unavailable(
      "Payment provider refund lookup is unavailable",
      found.error,
    );
  }
  if (found.data && found.data.provider !== evidence.provider) {
    throw Errors.conflict("Provider refund authority changed provider");
  }
  return found.data;
}

async function checkoutForSubscription(subscriptionId: string) {
  const subscription = await prisma.subscription.findUnique({
    where: { id: subscriptionId },
    select: { provider: true, providerSubscriptionId: true },
  });
  if (!subscription?.providerSubscriptionId) {
    throw Errors.notFound("Refundable subscription not found");
  }
  const checkout = await prisma.checkoutSession.findUnique({
    where: {
      provider_providerSessionId: {
        provider: subscription.provider,
        providerSessionId: subscription.providerSubscriptionId,
      },
    },
  });
  if (!checkout) throw Errors.notFound("Subscription checkout not found");
  return checkout;
}
