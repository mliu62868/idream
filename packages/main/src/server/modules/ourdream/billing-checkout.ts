// SPEC: 结算域 —— 加密货币 checkout、发票落库、provider 对账、订阅生命周期
// 与支付 webhook。从 ourdream/service.ts 原样搬出，行为不变。
//
// INTENT: 这一块碰的是钱，事务边界必须一眼看得见。它对 service.ts 的其余部分
// 只有一个入口方向：dispatchV1 调这里导出的 6 个路由处理器，没有反向调用。
// 把它单独成文件，是让哪些写入在同一个事务里、哪些锁按什么顺序拿这件事
// 有一个固定的阅读位置，而不是散在 12k 行里。
//
// INVARIANT: 对账三态（provider 未答复 / 明确 not-found / 迟到结算）全部
// fail closed —— 拿不准就不放权益，宁可让用户重试，也不凭猜测激活订阅。
//
// NOTE: 反向 import ./service 的那一批是仍与其余路由共用的助手（jsonBody /
// toInputJson / trackEvent / DTO 投影 / 计划与订阅查询…）。与
// generation-quote.ts 同理：mega-module 形态是既定决策，这里只搬走自成体系
// 的结算域，不去拆共用助手。
import { Prisma } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { getAuthCtx, requireUser } from "@/server/lib/auth";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import { createClassifiedAnalyticsEvent } from "@/server/modules/admin-v2/metrics/classified-event-writer";
import { providers } from "@/server/providers";
import type { PaymentInvoice, ProviderResult } from "@/server/providers/types";
import {
  activateSubscriptionInTx,
  activeSamePlanProviderDispatchInTx,
  activeSubscriptionWhere,
  assertNoActiveSamePlanAccessInTx,
  assertRenewalMutationSupported,
  billingAccessDTO,
  bodyText,
  checkoutOfferSnapshotSchema,
  checkoutSchema,
  cryptoRandomId,
  findPlan,
  isRecord,
  jsonBody,
  lockCheckoutSession,
  lockProviderEvent,
  lockUserLedger,
  parseJsonText,
  publicFeatureProjection,
  publicOfferAvailability,
  publicSubscriptionDTO,
  toInputJson,
  trackEvent,
  trackEventOnce,
} from "./service";

export async function listPlans() {
  const [plans, availability] = await Promise.all([
    prisma.plan.findMany({
      where: { active: true },
      orderBy: [{ slug: "asc" }, { billingPeriod: "asc" }],
    }),
    publicOfferAvailability(),
  ]);
  return ok({
    items: plans.map((plan) => ({
      ...plan,
      features: publicFeatureProjection(plan.features, availability),
    })),
    billing: checkoutMode(),
  });
}

function checkoutMode() {
  const provider = env.PAYMENT_PROVIDER;
  return {
    provider,
    demoMode: provider === "mock",
    autoConfirmAvailable: provider === "mock",
    ...providers.payment.capabilities,
  };
}

export async function checkout(request: Request) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  const idempotencyKey = requireCheckoutIdempotencyKey(request);
  const body = checkoutSchema.parse(await jsonBody(request));
  const mode = checkoutMode();
  const autoConfirm = body.autoConfirm && mode.autoConfirmAvailable;
  const requestHash = checkoutRequestHash({
    selector: body.planId
      ? { planId: body.planId }
      : {
          slug: body.slug ?? "premium",
          billingPeriod: body.billingPeriod,
        },
    returnPath: body.returnPath,
    autoConfirm,
    provider: mode.provider,
  });
  const preexisting = await prisma.checkoutSession.findUnique({
    where: {
      userId_idempotencyKey: {
        userId: user.id,
        idempotencyKey,
      },
    },
  });
  const selectedPlan = preexisting ? null : await findPlan(body);

  const durableIntent = await prisma.$transaction(async (tx) => {
    await lockUserLedger(tx, user.id);
    const existing = await tx.checkoutSession.findUnique({
      where: {
        userId_idempotencyKey: {
          userId: user.id,
          idempotencyKey,
        },
      },
    });
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw Errors.conflict(
          "Idempotency-Key was already used for a different checkout request",
          { idempotencyAction: "new_key" },
        );
      }
      return existing;
    }
    if (!selectedPlan) {
      throw Errors.conflict(
        "Checkout intent disappeared before it could be replayed",
        { idempotencyAction: "same_key" },
      );
    }
    const now = new Date();
    await assertNoActiveSamePlanAccessInTx(
      tx,
      user.id,
      selectedPlan.id,
      now,
    );
    return tx.checkoutSession.create({
      data: {
        userId: user.id,
        planId: selectedPlan.id,
        provider: mode.provider,
        idempotencyKey,
        requestHash,
        amountCents: selectedPlan.priceCents,
        currency: selectedPlan.currency.toLowerCase(),
        offerSnapshot: toInputJson({
          version: 1,
          planId: selectedPlan.id,
          slug: selectedPlan.slug,
          name: selectedPlan.name,
          billingPeriod: selectedPlan.billingPeriod,
          priceCents: selectedPlan.priceCents,
          currency: selectedPlan.currency.toLowerCase(),
          includedDreamcoins: selectedPlan.includedDreamcoins,
          features: selectedPlan.features,
        }),
        autoConfirm,
        returnPath: body.returnPath,
        status: "provider_pending",
      },
    });
  });
  if (
    !durableIntent.planId ||
    durableIntent.amountCents === null ||
    !durableIntent.currency ||
    !checkoutOfferSnapshotSchema.safeParse(durableIntent.offerSnapshot).success
  ) {
    throw Errors.unavailable("Checkout intent is missing its authoritative plan snapshot", {
      checkoutId: durableIntent.id,
    });
  }

  await trackEventOnce(
    "checkout_started",
    {
      planId: durableIntent.planId,
      autoConfirm: durableIntent.autoConfirm,
      provider: durableIntent.provider,
    },
    ctx,
    `checkout:${durableIntent.id}:started`,
  );

  let checkoutSession = await ensureCheckoutInvoice(durableIntent.id, {
    userId: durableIntent.userId,
    planId: durableIntent.planId,
    amountCents: durableIntent.amountCents,
    currency: durableIntent.currency,
  });
  let subscription = await subscriptionForCheckout(checkoutSession);
  if (checkoutSession.status === "provider_settled") {
    const completed = await completeCheckoutIntent(checkoutSession.id, "checkout");
    checkoutSession = completed.checkout;
    if (completed.settlementDeferred) {
      throw Errors.unavailable(
        "Settlement is waiting for an in-flight same-plan provider dispatch to finish.",
        {
          checkoutId: checkoutSession.id,
          competingCheckoutId: completed.deferredByCheckoutId,
          deferred: true,
        },
      );
    }
    if (completed.reconciliationRequired) {
      throw Errors.unavailable(
        "The settled purchase requires billing reconciliation before access can change.",
        { checkoutId: checkoutSession.id },
      );
    }
    subscription = await subscriptionForCheckout(checkoutSession);
  }
  if (
    checkoutSession.status === "provider_unknown" ||
    checkoutSession.needsReconciliation
  ) {
    throw Errors.unavailable(
      "Checkout payment state requires provider reconciliation before it can continue.",
      { checkoutId: checkoutSession.id },
    );
  }
  if (
    checkoutSession.status === "expired" ||
    checkoutSession.status === "canceled"
  ) {
    throw Errors.conflict(
      "This payment invoice is no longer payable. Start a new checkout with a new Idempotency-Key.",
      {
        checkoutId: checkoutSession.id,
        idempotencyAction: "new_key",
        providerInvoiceStatus: checkoutSession.providerInvoiceStatus,
      },
    );
  }
  if (checkoutSession.autoConfirm && checkoutSession.status !== "completed") {
    const completed = await completeCheckoutIntent(checkoutSession.id, "checkout");
    checkoutSession = completed.checkout;
    if (completed.settlementDeferred) {
      throw Errors.unavailable(
        "Settlement is waiting for an in-flight same-plan provider dispatch to finish.",
        {
          checkoutId: checkoutSession.id,
          competingCheckoutId: completed.deferredByCheckoutId,
          deferred: true,
        },
      );
    }
    if (completed.reconciliationRequired) {
      throw Errors.unavailable(
        "The settled purchase requires billing reconciliation before access can change.",
        { checkoutId: checkoutSession.id },
      );
    }
    subscription = await subscriptionForCheckout(checkoutSession);
  }

  if (!checkoutSession.providerSessionId || !checkoutSession.checkoutUrl) {
    throw Errors.unavailable("Checkout provider state is incomplete", {
      checkoutId: checkoutSession.id,
    });
  }
  const publicSubscription = subscription
    ? await publicSubscriptionDTO(subscription)
    : null;

  return ok({
    checkout: {
      id: checkoutSession.id,
      planId: checkoutSession.planId,
      provider: checkoutSession.provider,
      status: checkoutSession.status,
      returnPath: checkoutSession.returnPath,
      createdAt: checkoutSession.createdAt,
      updatedAt: checkoutSession.updatedAt,
    },
    invoice: {
      provider: checkoutSession.provider,
      invoiceId: checkoutSession.providerSessionId,
      checkoutUrl: checkoutSession.checkoutUrl,
      status: checkoutSession.providerInvoiceStatus ?? "created",
      additionalStatus:
        checkoutSession.providerInvoiceAdditionalStatus ?? "none",
    },
    subscription: publicSubscription,
    billingAccess: subscription ? billingAccessDTO(subscription) : null,
    billing: mode,
  });
}

function requireCheckoutIdempotencyKey(request: Request) {
  const value = request.headers.get("idempotency-key")?.trim();
  if (!value) {
    throw Errors.badRequest("Idempotency-Key header is required for checkout");
  }
  if (value.length < 8 || value.length > 160) {
    throw Errors.badRequest("Idempotency-Key must be between 8 and 160 characters");
  }
  return value;
}

function checkoutRequestHash(input: {
  selector:
    | { planId: string }
    | { slug: "premium" | "deluxe"; billingPeriod: "monthly" | "yearly" };
  returnPath: string;
  autoConfirm: boolean;
  provider: string;
}) {
  return createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex");
}

function billingProviderEventTargetHash(input: {
  type: "invoice.confirmed" | "invoice.ignored";
  invoiceId?: string;
  orderId?: string;
}) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        type: input.type,
        invoiceId: input.invoiceId ?? null,
        orderId: input.orderId ?? null,
      }),
    )
    .digest("hex");
}

const CHECKOUT_PROVIDER_RECONCILIATION_GRACE_MS = 30 * 60 * 1_000;
const CHECKOUT_PROVIDER_RECONCILIATION_MIN_MISSES = 3;
const CHECKOUT_PROVIDER_NOT_FOUND_TERMINAL =
  "provider_invoice_not_found_after_grace";
const CHECKOUT_PROVIDER_DISPATCH_LEASE_MS = 2 * 60 * 1_000;
const PAYMENT_PROVIDER_REQUEST_DEADLINE_MS =
  env.NODE_ENV === "test" ? 1_000 : 10_000;

async function paymentProviderRequestWithDeadline<T>(
  timeoutCode: string,
  operation: (signal: AbortSignal) => Promise<ProviderResult<T>>,
): Promise<ProviderResult<T>> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<ProviderResult<T>>((resolve) => {
    timeout = setTimeout(() => {
      controller.abort();
      resolve({
        ok: false,
        error: {
          code: timeoutCode,
          message: "Payment provider request exceeded its deadline",
          retryable: true,
        },
      });
    }, PAYMENT_PROVIDER_REQUEST_DEADLINE_MS);
  });
  const requested = Promise.resolve()
    .then(() => operation(controller.signal))
    .catch(
      (error): ProviderResult<T> => ({
        ok: false,
        error: {
          code: timeoutCode,
          message:
            error instanceof Error
              ? error.message
              : "Payment provider request failed",
          retryable: true,
        },
      }),
    );
  try {
    return await Promise.race([requested, timedOut]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function ensureCheckoutInvoice(
  checkoutId: string,
  plan: {
    userId: string;
    planId: string;
    amountCents: number;
    currency: string;
  },
) {
  let current = await prisma.checkoutSession.findUniqueOrThrow({
    where: { id: checkoutId },
  });
  if (
    current.status === "completed" &&
    current.providerSessionId &&
    current.checkoutUrl
  ) {
    return current;
  }
  if (isProviderMissingCheckoutTerminal(current)) {
    throw Errors.conflict(
      "The previous payment attempt was not found after reconciliation. Start a new checkout with a new Idempotency-Key.",
      { checkoutId, idempotencyAction: "new_key" },
    );
  }
  if (isLateSettledAbandonedCheckout(current)) {
    throw Errors.unavailable(
      "A late provider settlement is under manual reconciliation. Contact support before starting another checkout.",
      { checkoutId },
    );
  }
  if (
    current.dispatchToken &&
    current.dispatchLeaseUntil &&
    current.dispatchLeaseUntil > new Date()
  ) {
    current = await waitForCheckoutDispatch(checkoutId);
    if (current.providerSessionId && current.checkoutUrl) return current;
    if (
      current.dispatchToken &&
      current.dispatchLeaseUntil &&
      current.dispatchLeaseUntil > new Date()
    ) {
      throw Errors.conflict(
        "Checkout creation is already in progress. Retry with the same Idempotency-Key.",
        { checkoutId, idempotencyAction: "same_key" },
      );
    }
  }
  if (
    current.providerAttemptedAt ||
    current.providerSessionId ||
    current.needsReconciliation ||
    current.status === "provider_unknown"
  ) {
    const recovered = await paymentProviderRequestWithDeadline(
      "invoice_lookup_timeout",
      (signal) =>
        providers.payment.findInvoiceByOrderId({
          orderId: checkoutId,
          signal,
        }),
    );
    if (!recovered.ok) {
      throw Errors.unavailable(
        "Payment provider lookup is temporarily unavailable",
        recovered.error,
      );
    }
    if (recovered.data) {
      return persistRecoveredCheckoutInvoice(checkoutId, recovered.data);
    }
    const missing = await recordCheckoutInvoiceMissing(
      checkoutId,
      "provider_attempt_requires_reconciliation",
    );
    if (missing.closed) {
      throw Errors.conflict(
        "The payment provider confirmed no invoice after the reconciliation window. Start a new checkout with a new Idempotency-Key.",
        { checkoutId, idempotencyAction: "new_key" },
      );
    }
    if (missing.preservedAuthority) return missing.checkout;
    throw Errors.unavailable(
      "Checkout payment state is awaiting reconciliation. Retry with the same key later.",
      { checkoutId },
    );
  }

  return dispatchCheckoutInvoiceWithAccessExclusion(checkoutId, plan);
}

async function dispatchCheckoutInvoiceWithAccessExclusion(
  checkoutId: string,
  plan: {
    userId: string;
    planId: string;
    amountCents: number;
    currency: string;
  },
) {
  const dispatchToken = randomUUID();
  const phaseOne = await prisma.$transaction(async (tx) => {
    await lockCheckoutSession(tx, checkoutId);
    const current = await tx.checkoutSession.findUniqueOrThrow({
      where: { id: checkoutId },
    });
    const now = new Date();
    const claimable =
      current.providerAttemptedAt === null &&
      current.providerSessionId === null &&
      !current.needsReconciliation &&
      (current.status === "provider_pending" ||
        current.status === "provider_dispatching") &&
      (current.dispatchLeaseUntil === null ||
        current.dispatchLeaseUntil < now);
    if (!claimable) return { kind: "busy" } as const;

    await lockUserLedger(tx, plan.userId);
    await assertNoActiveSamePlanAccessInTx(
      tx,
      plan.userId,
      plan.planId,
      now,
    );
    const competingDispatch = await activeSamePlanProviderDispatchInTx(
      tx,
      plan.userId,
      plan.planId,
      checkoutId,
      now,
    );
    if (competingDispatch) {
      throw Errors.conflict(
        "Another checkout for this plan is already contacting the payment provider.",
        {
          checkoutId,
          competingCheckoutId: competingDispatch.id,
          idempotencyAction: "same_key",
        },
      );
    }

    // This marker commits before any provider network call. From this point on,
    // every retry is lookup/reconciliation-only and can never issue a second
    // POST, including a crash immediately after this transaction.
    const checkout = await tx.checkoutSession.update({
      where: { id: checkoutId },
      data: {
        status: "provider_dispatching",
        dispatchToken,
        dispatchLeaseUntil: new Date(
          now.getTime() + CHECKOUT_PROVIDER_DISPATCH_LEASE_MS,
        ),
        providerAttemptedAt: now,
        failureCode: null,
      },
    });
    return { kind: "claimed", checkout } as const;
  });

  if (phaseOne.kind === "busy") {
    const current = await waitForCheckoutDispatch(checkoutId);
    if (current.providerSessionId && current.checkoutUrl) return current;
    throw Errors.conflict(
      "Checkout creation is already in progress. Retry with the same Idempotency-Key.",
      { checkoutId, idempotencyAction: "same_key" },
    );
  }

  const recoveredBeforeCreate = await paymentProviderRequestWithDeadline(
    "invoice_lookup_timeout",
    (signal) =>
      providers.payment.findInvoiceByOrderId({
        orderId: checkoutId,
        signal,
      }),
  );
  if (!recoveredBeforeCreate.ok) {
    await recordProviderDispatchUnknown(
      checkoutId,
      dispatchToken,
      recoveredBeforeCreate.error.code,
    );
    throw Errors.unavailable(
      "Payment provider lookup is temporarily unavailable",
      recoveredBeforeCreate.error,
    );
  }
  if (recoveredBeforeCreate.data) {
    return persistCheckoutInvoiceAuthority(
      checkoutId,
      recoveredBeforeCreate.data,
      dispatchToken,
    );
  }

  const created = await paymentProviderRequestWithDeadline(
    "invoice_create_timeout",
    (signal) =>
      providers.payment.createInvoice({
        orderId: checkoutId,
        userId: plan.userId,
        amountCents: plan.amountCents,
        currency: plan.currency,
        metadata: { planId: plan.planId },
        signal,
      }),
  );
  if (created.ok) {
    return persistCheckoutInvoiceAuthority(
      checkoutId,
      created.data,
      dispatchToken,
    );
  }

  const recoveredAfterFailure = await paymentProviderRequestWithDeadline(
    "invoice_lookup_timeout",
    (signal) =>
      providers.payment.findInvoiceByOrderId({
        orderId: checkoutId,
        signal,
      }),
  );
  if (recoveredAfterFailure.ok && recoveredAfterFailure.data) {
    return persistCheckoutInvoiceAuthority(
      checkoutId,
      recoveredAfterFailure.data,
      dispatchToken,
    );
  }

  const failureCode = recoveredAfterFailure.ok
    ? created.error.code
    : `${created.error.code}:${recoveredAfterFailure.error.code}`;
  await recordProviderDispatchUnknown(
    checkoutId,
    dispatchToken,
    failureCode,
  );
  throw Errors.unavailable(
    "Payment provider did not return a recoverable checkout. The intent was preserved for reconciliation.",
    { checkoutId, providerError: created.error },
  );
}

async function waitForCheckoutDispatch(checkoutId: string) {
  const deadline = Date.now() + 1_500;
  let current = await prisma.checkoutSession.findUniqueOrThrow({
    where: { id: checkoutId },
  });
  while (
    current.dispatchToken &&
    current.dispatchLeaseUntil &&
    current.dispatchLeaseUntil > new Date() &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    current = await prisma.checkoutSession.findUniqueOrThrow({
      where: { id: checkoutId },
    });
  }
  return current;
}

async function persistRecoveredCheckoutInvoice(
  checkoutId: string,
  invoice: PaymentInvoice,
) {
  return persistCheckoutInvoiceAuthority(checkoutId, invoice);
}

async function persistCheckoutInvoiceAuthority(
  checkoutId: string,
  invoice: PaymentInvoice,
  expectedDispatchToken?: string,
) {
  return prisma.$transaction((tx) =>
    persistCheckoutInvoiceAuthorityInTx(
      tx,
      checkoutId,
      invoice,
      expectedDispatchToken,
    ),
  );
}

async function persistCheckoutInvoiceAuthorityInTx(
  tx: Prisma.TransactionClient,
  checkoutId: string,
  invoice: PaymentInvoice,
  expectedDispatchToken?: string,
) {
  await lockCheckoutSession(tx, checkoutId);
  const current = await tx.checkoutSession.findUniqueOrThrow({
    where: { id: checkoutId },
  });
    if (current.provider !== invoice.provider) {
      throw Errors.conflict("Recovered invoice provider does not match checkout intent", {
        checkoutId,
        idempotencyAction: "same_key",
      });
    }
    if (
      current.providerSessionId &&
      current.providerSessionId !== invoice.invoiceId
    ) {
      throw Errors.conflict("Recovered invoice does not match checkout intent", {
        checkoutId,
        idempotencyAction: "same_key",
      });
    }
    assertRecoveredInvoiceMatchesCheckout(current, invoice);
    if (isCheckoutReconciliationResolved(current)) return current;
    if (isLateSettledAbandonedCheckout(current)) {
      if (invoice.status !== "settled") return current;
      return tx.checkoutSession.update({
        where: { id: checkoutId },
        data: lateSettledCheckoutData(current.reconciliationEvidence, invoice),
      });
    }
    if (isCheckoutAbandonedTerminal(current)) {
      if (invoice.status !== "settled") return current;
      return tx.checkoutSession.update({
        where: { id: checkoutId },
        data: lateSettledCheckoutData(current.reconciliationEvidence, invoice),
      });
    }
    if (current.status === "completed") {
      return tx.checkoutSession.update({
        where: { id: checkoutId },
        data: {
          providerSessionId: invoice.invoiceId,
          checkoutUrl: invoice.checkoutUrl,
          providerInvoiceStatus: "settled",
          providerInvoiceAdditionalStatus:
            current.providerInvoiceAdditionalStatus ??
            invoice.additionalStatus,
          dispatchToken: null,
          dispatchLeaseUntil: null,
          providerLookupMissCount: 0,
          providerLastLookupAt: new Date(),
        },
      });
    }
    if (
      expectedDispatchToken &&
      current.dispatchToken !== expectedDispatchToken
    ) {
      if (current.providerSessionId === invoice.invoiceId) return current;
      throw Errors.conflict(
        "Checkout authority changed before invoice persistence",
        { checkoutId, idempotencyAction: "same_key" },
      );
    }
    if (
      current.providerInvoiceStatus === "settled" &&
      invoice.status !== "settled"
    ) {
      return current;
    }
    const disposition = checkoutDispositionForInvoice(
      invoice,
      current.status,
    );
    const providerInvoiceStatus =
      current.status === "completed" ? "settled" : invoice.status;
    const providerInvoiceAdditionalStatus =
      current.status === "completed"
        ? current.providerInvoiceAdditionalStatus ?? invoice.additionalStatus
        : invoice.additionalStatus;
  return tx.checkoutSession.update({
    where: { id: checkoutId },
    data: {
      providerSessionId: invoice.invoiceId,
      checkoutUrl: invoice.checkoutUrl,
      providerInvoiceStatus,
      providerInvoiceAdditionalStatus,
      status: disposition.status,
      dispatchToken: null,
      dispatchLeaseUntil: null,
      failureCode: disposition.failureCode,
      needsReconciliation: disposition.needsReconciliation,
      providerLookupMissCount: 0,
      providerLastLookupAt: new Date(),
    },
  });
}

function lateSettledCheckoutData(
  existingEvidence: unknown,
  invoice: {
    provider: PaymentInvoice["provider"];
    invoiceId: string;
    checkoutUrl: string | null;
    additionalStatus: PaymentInvoice["additionalStatus"];
  },
) {
  return {
    providerSessionId: invoice.invoiceId,
    checkoutUrl: invoice.checkoutUrl,
    providerInvoiceStatus: "settled",
    providerInvoiceAdditionalStatus: invoice.additionalStatus,
    status: "provider_unknown",
    dispatchToken: null,
    dispatchLeaseUntil: null,
    failureCode: "provider_invoice_settled_after_abandonment",
    needsReconciliation: true,
    providerLookupMissCount: 0,
    providerLastLookupAt: new Date(),
    reconciliationEvidence: toInputJson({
      ...(isRecord(existingEvidence) ? existingEvidence : {}),
      schemaVersion: "checkout-reconciliation-evidence-v1",
      reason: "provider_invoice_settled_after_abandonment",
      provider: invoice.provider,
      providerInvoiceId: invoice.invoiceId,
      observedAt: new Date().toISOString(),
    }),
  };
}

function assertRecoveredInvoiceMatchesCheckout(
  checkout: {
    id: string;
    amountCents: number | null;
    currency: string | null;
  },
  invoice: PaymentInvoice,
) {
  if (
    invoice.orderId !== checkout.id ||
    invoice.amountCents !== checkout.amountCents ||
    invoice.currency.toLowerCase() !== checkout.currency?.toLowerCase()
  ) {
    throw Errors.conflict(
      "Recovered invoice amount, currency, or order does not match checkout intent",
      {
        checkoutId: checkout.id,
        idempotencyAction: "same_key",
        providerInvoiceId: invoice.invoiceId,
      },
    );
  }
}

function checkoutDispositionForInvoice(
  invoice: PaymentInvoice,
  currentStatus: string,
) {
  if (currentStatus === "completed") {
    return {
      status: "completed",
      failureCode: null,
      needsReconciliation: false,
    };
  }
  if (invoice.status === "settled") {
    return {
      status: "provider_settled",
      failureCode: null,
      needsReconciliation: false,
    };
  }
  if (
    (invoice.status === "expired" || invoice.status === "invalid") &&
    ["paid_late", "paid_over", "paid_partial"].includes(
      invoice.additionalStatus,
    )
  ) {
    return {
      status: "provider_unknown",
      failureCode: `provider_invoice_${invoice.status}_${invoice.additionalStatus}`,
      needsReconciliation: true,
    };
  }
  if (invoice.status === "expired") {
    return {
      status: "expired",
      failureCode: "provider_invoice_expired",
      needsReconciliation: false,
    };
  }
  if (invoice.status === "invalid") {
    return {
      status: "canceled",
      failureCode: "provider_invoice_invalid",
      needsReconciliation: false,
    };
  }
  return {
    status: "created",
    failureCode: null,
    needsReconciliation: false,
  };
}

async function recordCheckoutInvoiceMissing(
  checkoutId: string,
  failureCode: string,
  dispatchToken?: string,
) {
  return prisma.$transaction(async (tx) => {
    await lockCheckoutSession(tx, checkoutId);
    const current = await tx.checkoutSession.findUniqueOrThrow({
      where: { id: checkoutId },
    });
    const existingTerminal = isCheckoutAbandonedTerminal(current);
    if (
      current.status === "completed" ||
      current.providerSessionId !== null ||
      existingTerminal ||
      isLateSettledAbandonedCheckout(current) ||
      (dispatchToken && current.dispatchToken !== dispatchToken)
    ) {
      return {
        checkout: current,
        closed: existingTerminal,
        preservedAuthority: true,
      };
    }
    const now = new Date();
    const missCount = current.providerLookupMissCount + 1;
    const graceElapsed =
      current.providerAttemptedAt !== null &&
      now.getTime() - current.providerAttemptedAt.getTime() >=
        CHECKOUT_PROVIDER_RECONCILIATION_GRACE_MS;
    const closed =
      graceElapsed &&
      missCount >= CHECKOUT_PROVIDER_RECONCILIATION_MIN_MISSES &&
      current.providerSessionId === null;
    const checkout = await tx.checkoutSession.update({
      where: { id: checkoutId },
      data: {
        status: closed ? "canceled" : "provider_unknown",
        dispatchToken: null,
        dispatchLeaseUntil: null,
        providerLastLookupAt: now,
        providerLookupMissCount: missCount,
        failureCode: closed
          ? CHECKOUT_PROVIDER_NOT_FOUND_TERMINAL
          : failureCode,
        needsReconciliation: !closed,
      },
    });
    return { checkout, closed, preservedAuthority: false };
  });
}

async function recordProviderDispatchUnknown(
  checkoutId: string,
  dispatchToken: string,
  failureCode: string,
) {
  return recordCheckoutInvoiceMissing(
    checkoutId,
    failureCode,
    dispatchToken,
  );
}

function isProviderMissingCheckoutTerminal(checkout: {
  status: string;
  failureCode: string | null;
}) {
  return (
    checkout.status === "canceled" &&
    checkout.failureCode === CHECKOUT_PROVIDER_NOT_FOUND_TERMINAL
  );
}

function isLateSettledAbandonedCheckout(checkout: {
  failureCode: string | null;
}) {
  return checkout.failureCode === "provider_invoice_settled_after_abandonment";
}

function isCheckoutAbandonedTerminal(checkout: { status: string }) {
  return checkout.status === "canceled" || checkout.status === "expired";
}

function isCheckoutReconciliationResolved(checkout: {
  failureCode: string | null;
}) {
  return checkout.failureCode === "provider_invoice_refund_acknowledged";
}

function paymentInvoiceAdditionalStatus(
  value: string | null,
): PaymentInvoice["additionalStatus"] {
  if (
    value === "marked" ||
    value === "paid_late" ||
    value === "paid_over" ||
    value === "paid_partial"
  ) {
    return value;
  }
  return "none";
}

async function subscriptionForCheckout(checkoutSession: {
  userId: string;
  planId: string | null;
  provider: string;
  providerSessionId: string | null;
}) {
  if (!checkoutSession.planId || !checkoutSession.providerSessionId) {
    return null;
  }
  const purchased = await prisma.subscription.findFirst({
    where: {
      userId: checkoutSession.userId,
      planId: checkoutSession.planId,
      provider: checkoutSession.provider,
      providerSubscriptionId: checkoutSession.providerSessionId,
    },
    include: { plan: true },
    orderBy: { createdAt: "desc" },
  });
  if (purchased?.status === "active") return purchased;

  // A late older invoice can be recorded as an applied purchase while its
  // prepaid period extends a newer access authority. Public checkout state must
  // return that current authority, not present the non-active receipt as access.
  return prisma.subscription.findFirst({
    where: activeSubscriptionWhere(checkoutSession.userId),
    include: { plan: true },
    orderBy: [{ currentPeriodEnd: "desc" }, { createdAt: "desc" }],
  });
}

async function completeCheckoutIntent(
  checkoutId: string,
  source: "checkout" | "webhook",
) {
  return prisma.$transaction(async (tx) => {
    await lockCheckoutSession(tx, checkoutId);
    const current = await tx.checkoutSession.findUniqueOrThrow({
      where: { id: checkoutId },
    });
    if (!current.planId || !current.providerSessionId) {
      throw Errors.conflict("Checkout is missing its local plan or provider invoice", {
        checkoutId,
        idempotencyAction: "same_key",
      });
    }
    const offerSnapshot = checkoutOfferSnapshotSchema.safeParse(
      current.offerSnapshot,
    );
    if (
      !offerSnapshot.success ||
      offerSnapshot.data.planId !== current.planId
    ) {
      throw Errors.conflict("Checkout is missing its authoritative offer snapshot", {
        checkoutId,
        idempotencyAction: "same_key",
      });
    }
    if (current.status === "completed") {
      const subscription = await tx.subscription.findFirst({
        where: {
          userId: current.userId,
          planId: current.planId,
          provider: current.provider,
          providerSubscriptionId: current.providerSessionId,
        },
        orderBy: { createdAt: "desc" },
      });
      return {
        checkout: current,
        subscription,
        created: false,
        reconciliationRequired: false,
        settlementDeferred: false,
      } as const;
    }

    const activation = await activateSubscriptionInTx(
      tx,
      current.userId,
      current.planId,
      current.providerSessionId,
      current.provider,
      offerSnapshot.data,
      {
        checkoutId: current.id,
        createdAt: current.createdAt,
      },
    );
    if (activation.settlementDeferred) {
      return {
        checkout: current,
        subscription: null,
        created: false,
        reconciliationRequired: false,
        settlementDeferred: true,
        deferredByCheckoutId: activation.deferredByCheckoutId,
      } as const;
    }
    if (activation.reconciliationRequired) {
      const reconciled = await tx.checkoutSession.update({
        where: { id: current.id },
        data: checkoutSettlementReconciliationData(
          activation.reconciliationReason,
        ),
      });
      return {
        checkout: reconciled,
        subscription: null,
        created: false,
        reconciliationRequired: true,
        settlementDeferred: false,
      } as const;
    }
    const completed = await tx.checkoutSession.update({
      where: { id: current.id },
      data: {
        status: "completed",
        providerInvoiceStatus: "settled",
        providerInvoiceAdditionalStatus:
          current.providerInvoiceAdditionalStatus ?? "none",
        failureCode: null,
        needsReconciliation: false,
      },
    });
    if (activation.created) {
      await createClassifiedAnalyticsEvent(tx, {
        userId: current.userId,
        name: "subscription_started",
        props: {
          planId: current.planId,
          provider: current.provider,
          source,
        },
        sourceEventId: `checkout:${current.id}:subscription_started`,
        sourceService: "billing",
        trustClass: "server_trusted",
      });
    }
    return {
      checkout: completed,
      subscription: activation.subscription,
      created: activation.created,
      reconciliationRequired: false,
      settlementDeferred: false,
    } as const;
  });
}

function checkoutSettlementReconciliationData(reason: string) {
  return {
    status: "provider_unknown",
    providerInvoiceStatus: "settled",
    failureCode: reason,
    needsReconciliation: true,
    reconciliationEvidence: toInputJson({
      schemaVersion: "checkout-settlement-reconciliation-v1",
      reason,
      observedAt: new Date().toISOString(),
    }),
  };
}

export async function billingPortal(request: Request) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  const subscription = await prisma.subscription.findFirst({
    where: activeSubscriptionWhere(user.id),
    include: { plan: true },
    orderBy: { createdAt: "desc" },
  });

  if (!subscription) {
    return ok({
      mode: "subscribe",
      url: "/upgrade",
      subscription: null,
      billingAccess: null,
      message: "No active paid access. Compare plans to buy access.",
    });
  }

  const billingAccess = billingAccessDTO(subscription);
  return ok({
    mode: "access",
    url: "/profile#billing",
    subscription: await publicSubscriptionDTO(subscription),
    billingAccess,
    message:
      billingAccess.billingModel === "prepaid_period"
        ? "Your prepaid benefits remain active until the displayed end date and do not renew automatically."
        : "Your active billing access is shown in Profile.",
  });
}

export async function cancelSubscription(request: Request) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  const subscription = await prisma.subscription.findFirst({
    where: activeSubscriptionWhere(user.id),
    include: { plan: true },
    orderBy: { createdAt: "desc" },
  });
  if (!subscription) throw Errors.badRequest("No active subscription to cancel.");
  assertRenewalMutationSupported(subscription);
  if (subscription.cancelAtPeriodEnd) {
    return ok({
      subscription: await publicSubscriptionDTO(subscription),
      billingAccess: billingAccessDTO(subscription),
      message: "Renewal is already canceled.",
    });
  }

  const updated = await prisma.subscription.update({
    where: { id: subscription.id },
    data: { cancelAtPeriodEnd: true },
    include: { plan: true },
  });
  await trackEvent(
    "subscription_cancel_requested",
    { planId: updated.planId, provider: updated.provider, source: "profile" },
    ctx,
  );
  return ok({
    subscription: await publicSubscriptionDTO(updated),
    billingAccess: billingAccessDTO(updated),
    message: "Renewal canceled. Benefits stay active until the current period ends.",
  });
}

export async function resumeSubscription(request: Request) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  const subscription = await prisma.subscription.findFirst({
    where: activeSubscriptionWhere(user.id),
    include: { plan: true },
    orderBy: { createdAt: "desc" },
  });
  if (!subscription) throw Errors.badRequest("No active subscription.");
  assertRenewalMutationSupported(subscription);
  if (!subscription.cancelAtPeriodEnd) {
    throw Errors.badRequest("No canceled renewal to resume.");
  }

  const updated = await prisma.subscription.update({
    where: { id: subscription.id },
    data: { cancelAtPeriodEnd: false },
    include: { plan: true },
  });
  await trackEvent(
    "subscription_resume_requested",
    { planId: updated.planId, provider: updated.provider, source: "profile" },
    ctx,
  );
  return ok({
    subscription: await publicSubscriptionDTO(updated),
    billingAccess: billingAccessDTO(updated),
    message: "Renewal resumed.",
  });
}

export async function billingWebhook(request: Request, provider: string) {
  if (provider !== env.PAYMENT_PROVIDER) {
    throw Errors.badRequest("Webhook provider does not match the configured payment provider");
  }
  const rawBody = await bodyText(request);
  const payload = parseJsonText(rawBody);
  const eventId =
    request.headers.get("x-provider-event-id") ??
    (isRecord(payload) && typeof payload.providerEventId === "string"
      ? payload.providerEventId
      : isRecord(payload) && typeof payload.deliveryId === "string"
        ? payload.deliveryId
        : isRecord(payload) && typeof payload.id === "string"
          ? payload.id
      : cryptoRandomId("evt"));
  const parsed = await providers.payment.parseWebhook({
    providerEventId: eventId,
    payload,
    signature:
      request.headers.get("btcpay-sig") ??
      request.headers.get("x-signature") ??
      undefined,
    rawBody,
  });
  if (!parsed.ok) throw Errors.badRequest(parsed.error.message, parsed.error);
  const providerEventId = parsed.data.providerEventId;
  const payloadHash = createHash("sha256").update(rawBody).digest("hex");
  const targetHash = billingProviderEventTargetHash(parsed.data);

  let event = await prisma.providerEvent.upsert({
    where: { provider_providerEventId: { provider, providerEventId } },
    update: {},
    create: {
      provider,
      providerEventId,
      type: parsed.data.type,
      payload: toInputJson(payload),
      targetHash,
    },
  });
  if (event.type !== parsed.data.type) {
    throw Errors.conflict("Provider event type changed across deliveries", {
      providerEventId,
    });
  }
  if (!event.targetHash) {
    await prisma.providerEvent.updateMany({
      where: { id: event.id, targetHash: null },
      data: { targetHash },
    });
    event = await prisma.providerEvent.findUniqueOrThrow({
      where: { id: event.id },
    });
  }
  if (event.targetHash !== targetHash) {
    throw Errors.conflict("Provider event target changed across deliveries", {
      providerEventId,
    });
  }
  const delivery = await prisma.providerEventDelivery.upsert({
    where: {
      eventId_deliveryId: {
        eventId: event.id,
        deliveryId: parsed.data.deliveryId,
      },
    },
    update: {},
    create: {
      eventId: event.id,
      deliveryId: parsed.data.deliveryId,
      payload: toInputJson(payload),
      payloadHash,
    },
  });
  if (delivery.payloadHash !== payloadHash) {
    throw Errors.conflict("Provider delivery payload changed for the same delivery id", {
      providerEventId,
      deliveryId: parsed.data.deliveryId,
    });
  }

  let verifiedOrderInvoice: PaymentInvoice | null = null;
  if (
    parsed.data.type === "invoice.confirmed" &&
    parsed.data.invoiceId &&
    parsed.data.orderId
  ) {
    const alreadyBound = await prisma.checkoutSession.findUnique({
      where: {
        provider_providerSessionId: {
          provider,
          providerSessionId: parsed.data.invoiceId,
        },
      },
      select: { id: true },
    });
    if (!alreadyBound) {
      const lookup = await paymentProviderRequestWithDeadline(
        "invoice_lookup_timeout",
        (signal) =>
          providers.payment.findInvoiceByOrderId({
            orderId: parsed.data.orderId!,
            signal,
          }),
      );
      if (!lookup.ok) {
        throw Errors.unavailable(
          "Payment provider lookup is temporarily unavailable",
          lookup.error,
        );
      }
      if (!lookup.data) {
        throw Errors.unavailable(
          "Settled payment could not yet be verified by its provider order id",
          { orderId: parsed.data.orderId },
        );
      }
      if (
        lookup.data.provider !== provider ||
        lookup.data.invoiceId !== parsed.data.invoiceId ||
        lookup.data.status !== "settled"
      ) {
        throw Errors.conflict(
          "Webhook settlement does not match the provider invoice authority",
          {
            invoiceId: parsed.data.invoiceId,
            orderId: parsed.data.orderId,
          },
        );
      }
      verifiedOrderInvoice = lookup.data;
    }
  }

  type BillingWebhookSettlement = {
    processed: boolean;
    idempotent?: boolean;
    deferred?: boolean;
    reconciliationRequired?: boolean;
  };

  const result: BillingWebhookSettlement = await prisma.$transaction(async (tx) => {
    // Lock the provider event while settling. processedAt is written LAST, so a
    // failed activation/checkout update rolls back and remains retryable.
    await lockProviderEvent(tx, event.id);
    const current = await tx.providerEvent.findUniqueOrThrow({ where: { id: event.id } });
    if (current.processedAt) return { processed: false, idempotent: true };

    if (parsed.data.type === "invoice.ignored") {
      await tx.providerEvent.update({
        where: { id: event.id },
        data: { processedAt: new Date() },
      });
      return { processed: true };
    }

    if (!parsed.data.invoiceId) {
      throw Errors.badRequest("Confirmed payment webhook is missing an invoice id");
    }

    let checkoutIdentity = await tx.checkoutSession.findUnique({
      where: {
        provider_providerSessionId: {
          provider,
          providerSessionId: parsed.data.invoiceId,
        },
      },
      select: { id: true },
    });
    if (
      checkoutIdentity &&
      parsed.data.orderId &&
      checkoutIdentity.id !== parsed.data.orderId
    ) {
      throw Errors.conflict("Webhook order does not match its invoice checkout", {
        checkoutId: checkoutIdentity.id,
      });
    }
    if (!checkoutIdentity && parsed.data.orderId) {
      const byOrderId = await tx.checkoutSession.findUnique({
        where: { id: parsed.data.orderId },
        select: { id: true, provider: true },
      });
      if (byOrderId?.provider === provider) {
        checkoutIdentity = { id: byOrderId.id };
      }
    }
    if (!checkoutIdentity) {
      return { processed: false, deferred: true };
    }

    // Every path locks the checkout before inspecting or binding its provider
    // invoice. Distinct provider events can settle concurrently, so any state
    // read before this lock is only an identity hint, never mutation authority.
    await lockCheckoutSession(tx, checkoutIdentity.id);
    let checkoutSession = await tx.checkoutSession.findUniqueOrThrow({
      where: { id: checkoutIdentity.id },
    });
    if (checkoutSession.provider !== provider) {
      throw Errors.conflict("Webhook provider does not match the checkout", {
        checkoutId: checkoutSession.id,
      });
    }
    if (
      parsed.data.orderId &&
      checkoutSession.id !== parsed.data.orderId
    ) {
      throw Errors.conflict("Webhook order does not match its invoice checkout", {
        checkoutId: checkoutSession.id,
      });
    }
    if (
      checkoutSession.providerSessionId &&
      checkoutSession.providerSessionId !== parsed.data.invoiceId
    ) {
      throw Errors.conflict("Webhook invoice does not match the checkout order", {
        checkoutId: checkoutSession.id,
      });
    }
    if (isLateSettledAbandonedCheckout(checkoutSession)) {
      await tx.providerEvent.update({
        where: { id: event.id },
        data: { processedAt: new Date() },
      });
      return { processed: true, reconciliationRequired: true };
    }
    if (isCheckoutReconciliationResolved(checkoutSession)) {
      await tx.providerEvent.update({
        where: { id: event.id },
        data: { processedAt: new Date() },
      });
      return { processed: true, idempotent: true };
    }
    if (
      isCheckoutAbandonedTerminal(checkoutSession) &&
      checkoutSession.providerSessionId
    ) {
      await tx.checkoutSession.update({
        where: { id: checkoutSession.id },
        data: lateSettledCheckoutData(checkoutSession.reconciliationEvidence, {
          provider,
          invoiceId: checkoutSession.providerSessionId,
          checkoutUrl: checkoutSession.checkoutUrl,
          additionalStatus: paymentInvoiceAdditionalStatus(
            checkoutSession.providerInvoiceAdditionalStatus,
          ),
        }),
      });
      await tx.providerEvent.update({
        where: { id: event.id },
        data: { processedAt: new Date() },
      });
      return { processed: true, reconciliationRequired: true };
    }
    if (!checkoutSession.providerSessionId) {
      if (!verifiedOrderInvoice) {
        return { processed: false, deferred: true };
      }
      assertRecoveredInvoiceMatchesCheckout(
        checkoutSession,
        verifiedOrderInvoice,
      );
      if (isProviderMissingCheckoutTerminal(checkoutSession)) {
        await tx.checkoutSession.update({
          where: { id: checkoutSession.id },
          data: lateSettledCheckoutData(
            checkoutSession.reconciliationEvidence,
            verifiedOrderInvoice,
          ),
        });
        await tx.providerEvent.update({
          where: { id: event.id },
          data: { processedAt: new Date() },
        });
        return { processed: true, reconciliationRequired: true };
      }
      checkoutSession = await tx.checkoutSession.update({
        where: { id: checkoutSession.id },
        data: {
          providerSessionId: verifiedOrderInvoice.invoiceId,
          checkoutUrl: verifiedOrderInvoice.checkoutUrl,
          providerInvoiceStatus: "settled",
          providerInvoiceAdditionalStatus:
            verifiedOrderInvoice.additionalStatus,
          status:
            checkoutSession.status === "completed"
              ? "completed"
              : "provider_settled",
          failureCode:
            checkoutSession.status === "completed"
              ? checkoutSession.failureCode
              : null,
          needsReconciliation:
            checkoutSession.status === "completed"
              ? checkoutSession.needsReconciliation
              : false,
          providerLookupMissCount: 0,
          providerLastLookupAt: new Date(),
        },
      });
    }
    if (checkoutSession.providerSessionId !== parsed.data.invoiceId) {
      throw Errors.conflict("Checkout invoice changed before webhook settlement", {
        checkoutId: checkoutSession.id,
      });
    }
    if (checkoutSession.status === "completed") {
      await tx.checkoutSession.update({
        where: { id: checkoutSession.id },
        data: {
          providerInvoiceStatus: "settled",
          providerInvoiceAdditionalStatus:
            checkoutSession.providerInvoiceAdditionalStatus ?? "none",
        },
      });
      await tx.providerEvent.update({
        where: { id: event.id },
        data: { processedAt: new Date() },
      });
      return { processed: true, idempotent: true };
    }
    if (!checkoutSession.planId) {
      return { processed: false, deferred: true };
    }

    const offerSnapshot = checkoutOfferSnapshotSchema.safeParse(
      checkoutSession.offerSnapshot,
    );
    if (
      !offerSnapshot.success ||
      offerSnapshot.data.planId !== checkoutSession.planId
    ) {
      return { processed: false, deferred: true };
    }
    const activation = await activateSubscriptionInTx(
      tx,
      checkoutSession.userId,
      checkoutSession.planId,
      parsed.data.invoiceId,
      provider,
      offerSnapshot.data,
      {
        checkoutId: checkoutSession.id,
        createdAt: checkoutSession.createdAt,
      },
    );
    if (activation.settlementDeferred) {
      return { processed: false, deferred: true };
    }
    if (activation.reconciliationRequired) {
      await tx.checkoutSession.update({
        where: { id: checkoutSession.id },
        data: checkoutSettlementReconciliationData(
          activation.reconciliationReason,
        ),
      });
      await tx.providerEvent.update({
        where: { id: event.id },
        data: { processedAt: new Date() },
      });
      return { processed: true, reconciliationRequired: true };
    }
    await tx.checkoutSession.update({
      where: { id: checkoutSession.id },
      data: {
        status: "completed",
        providerInvoiceStatus: "settled",
        providerInvoiceAdditionalStatus:
          checkoutSession.providerInvoiceAdditionalStatus ?? "none",
        failureCode: null,
        needsReconciliation: false,
      },
    });
    if (activation.created) {
      await createClassifiedAnalyticsEvent(tx, {
        userId: checkoutSession.userId,
        name: "subscription_started",
        props: {
          planId: checkoutSession.planId,
          provider,
          source: "webhook",
        },
        sourceEventId: `checkout:${checkoutSession.id}:subscription_started`,
        sourceService: "billing",
        trustClass: "server_trusted",
      });
    }

    await tx.providerEvent.update({
      where: { id: event.id },
      data: { processedAt: new Date() },
    });
    return { processed: true };
  });

  if (result.deferred) {
    throw Errors.unavailable(
      "Payment event is valid but its checkout intent is not available yet; retry delivery.",
      { providerEventId, deferred: true },
    );
  }
  return ok(result);
}
