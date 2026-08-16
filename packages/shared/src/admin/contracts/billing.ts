import { z } from "zod";
import { adminIsoDateTimeSchema, adminPageInfoSchema } from "./common";

/**
 * SPEC: 每个 billing 读端点都声明它只看得见 customer 数据类。
 * INTENT: v1 把 `CUSTOMER_METRIC_DATA_SCOPE` 当普通字段回，没有任何契约钉住它；
 *         运营台据此显示「口径」，所以它必须是响应契约的一部分而不是顺手带的元数据。
 */
const adminBillingDataScopeSchema = z
  .object({
    kind: z.literal("customer"),
    includedDataClasses: z.array(z.string()),
    excludedDataClasses: z.array(z.string()),
  })
  .strict();

export const adminBillingLedgerQuerySchema = z
  .object({
    search: z.string().trim().min(1).max(200).optional(),
    userId: z.string().trim().min(1).max(160).optional(),
    reason: z.string().trim().min(1).max(120).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().trim().min(1).optional(),
  })
  .strict();

export const adminBillingLedgerEntrySchema = z
  .object({
    id: z.string().min(1),
    userId: z.string().min(1),
    userEmail: z.string().email(),
    delta: z.number().int(),
    balanceAfter: z.number().int(),
    reason: z.string().min(1),
    sourceId: z.string().min(1).nullable(),
    createdAt: adminIsoDateTimeSchema,
  })
  .strict();

export const adminBillingLedgerListResponseSchema = z
  .object({
    dataScope: adminBillingDataScopeSchema,
    items: z.array(adminBillingLedgerEntrySchema),
    pageInfo: adminPageInfoSchema,
  })
  .strict();

export const adminBillingSubscriptionQuerySchema = z
  .object({
    search: z.string().trim().min(1).max(200).optional(),
    userId: z.string().trim().min(1).max(160).optional(),
    status: z
      .enum([
        "checkout_created",
        "checkout_completed",
        "active",
        "past_due",
        "canceled",
        "expired",
        "refund_pending",
        "refunded",
      ])
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().trim().min(1).optional(),
  })
  .strict();

export const adminBillingReconciliationQuerySchema = z
  .object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  })
  .strict();

export const adminBillingCheckoutExceptionSchema = z
  .object({
    id: z.string().min(1),
    userId: z.string().min(1),
    userEmail: z.string().email(),
    plan: z.string().min(1).nullable(),
    billingPeriod: z.string().min(1).nullable(),
    provider: z.string().min(1),
    providerSessionId: z.string().min(1).nullable(),
    providerInvoiceStatus: z.string().min(1).nullable(),
    providerInvoiceAdditionalStatus: z.string().min(1).nullable(),
    status: z.string().min(1),
    failureCode: z.string().min(1).nullable(),
    needsReconciliation: z.boolean(),
    providerLookupMissCount: z.number().int().nonnegative(),
    providerAttemptedAt: adminIsoDateTimeSchema.nullable(),
    providerLastLookupAt: adminIsoDateTimeSchema.nullable(),
    createdAt: adminIsoDateTimeSchema,
    updatedAt: adminIsoDateTimeSchema,
  })
  .strict();

export const adminBillingReconciliationResponseSchema = z
  .object({
    dataScope: adminBillingDataScopeSchema,
    window: z
      .object({ from: adminIsoDateTimeSchema, to: adminIsoDateTimeSchema })
      .strict(),
    activeSubscriptions: z.number().int().nonnegative(),
    checkoutExceptions: z.array(adminBillingCheckoutExceptionSchema),
    byReason: z.array(
      z
        .object({
          reason: z.string().min(1),
          totalDelta: z.number().int(),
          count: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    totals: z
      .object({ net: z.number().int(), entries: z.number().int().nonnegative() })
      .strict(),
  })
  .strict();

export const adminBillingLedgerAdjustmentRequestSchema = z.object({
  userId: z.string().trim().min(1),
  delta: z.number().int().refine((value) => value !== 0),
  reason: z.string().trim().min(3).max(2_000),
  sourceId: z.string().trim().max(160).optional(),
  confirmation: z.string().trim().min(1).max(160),
});

export const adminBillingLedgerAdjustmentResponseSchema = z
  .object({
    ledgerEntry: z
      .object({
        id: z.string().min(1),
        userId: z.string().min(1),
        delta: z.number().int(),
        balanceAfter: z.number().int(),
        reason: z.string().min(1),
        sourceId: z.string().min(1).nullable(),
        createdAt: adminIsoDateTimeSchema,
      })
      .strict(),
    replayed: z.boolean(),
  })
  .strict();

export const adminBillingCheckoutReconcileRequestSchema = z
  .object({
    resolution: z.literal("refund_acknowledged"),
    providerReference: z.string().trim().min(3).max(240),
    reason: z.string().trim().min(3).max(2_000),
    confirmation: z.string().trim().min(1).max(240),
  })
  .strict();

export const adminBillingCheckoutReconcileResponseSchema = z
  .object({
    checkout: z
      .object({
        id: z.string().min(1),
        status: z.string().min(1),
        failureCode: z.string().min(1).nullable(),
        needsReconciliation: z.boolean(),
        providerInvoiceStatus: z.string().min(1).nullable(),
        providerSessionId: z.string().min(1).nullable(),
      })
      .strict(),
    resolution: z
      .object({
        type: z.literal("refund_acknowledged"),
        providerReference: z.string().min(1),
        acknowledgedAt: adminIsoDateTimeSchema,
        acknowledgedBy: z.string().min(1),
      })
      .strict(),
    replayed: z.boolean(),
  })
  .strict();

/** 退款与退款对账共用一个请求体；差别只在 confirmation 的目标串，由 authority 校验。 */
export const adminSubscriptionRefundRequestSchema = z
  .object({
    reason: z.string().trim().min(3).max(2_000),
    confirmation: z.string().trim().min(1).max(240),
  })
  .strict();

export const adminSubscriptionRefundStateSchema = z.enum([
  "provider_dispatching",
  "provider_unknown",
  "claimable",
  "awaiting_approval",
  "awaiting_payment",
  "in_progress",
  "completed",
  "canceled",
]);

export const adminSubscriptionRefundSchema = z
  .object({
    subscriptionId: z.string().min(1),
    checkoutId: z.string().min(1),
    reference: z.string().min(1),
    state: adminSubscriptionRefundStateSchema,
    amountCents: z.number().int().positive(),
    currency: z.string().min(1),
    reversedDreamcoins: z.number().int().positive(),
    balanceAfter: z.number().int(),
    claimUrl: z.string().url().nullable(),
    providerRefundId: z.string().min(1).nullable(),
    payouts: z.array(
      z
        .object({
          payoutId: z.string().min(1),
          state: z.enum([
            "awaiting_approval",
            "awaiting_payment",
            "in_progress",
            "completed",
            "canceled",
          ]),
          paymentProofId: z.string().min(1).nullable(),
        })
        .strict(),
    ),
    requestedAt: adminIsoDateTimeSchema,
    completedAt: adminIsoDateTimeSchema.nullable(),
    restoredAt: adminIsoDateTimeSchema.nullable(),
    restoredBalanceAfter: z.number().int().nullable(),
  })
  .strict();

export const adminBillingSubscriptionListItemSchema = z
  .object({
    id: z.string().min(1),
    userId: z.string().min(1),
    userEmail: z.string().email(),
    plan: z.string().min(1),
    billingPeriod: z.string().min(1),
    includedDreamcoins: z.number().int().nonnegative(),
    provider: z.string().min(1),
    status: z.string().min(1),
    currentPeriodEnd: adminIsoDateTimeSchema.nullable(),
    cancelAtPeriodEnd: z.boolean(),
    providerSubscriptionId: z.string().min(1).nullable(),
    checkoutId: z.string().min(1).nullable(),
    amountCents: z.number().int().positive().nullable(),
    currency: z.string().min(1).nullable(),
    refund: adminSubscriptionRefundSchema.nullable(),
    canRefund: z.boolean(),
    createdAt: adminIsoDateTimeSchema,
  })
  .strict();

export const adminBillingSubscriptionListResponseSchema = z
  .object({
    dataScope: z
      .object({
        kind: z.literal("customer"),
        includedDataClasses: z.array(z.string()),
        excludedDataClasses: z.array(z.string()),
      })
      .strict(),
    items: z.array(adminBillingSubscriptionListItemSchema),
    pageInfo: z
      .object({
        endCursor: z.string().nullable(),
        hasNextPage: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const adminSubscriptionRefundCommandResponseSchema = z
  .object({
    checkoutId: z.string().min(1),
    subscriptionId: z.string().min(1),
    subscriptionStatus: z.string().min(1),
    refund: adminSubscriptionRefundSchema,
    settlement: z
      .object({
        reversedDreamcoins: z.number().int().positive(),
        balanceAfter: z.number().int(),
        restoredDreamcoins: z.number().int().nonnegative(),
        restoredBalanceAfter: z.number().int().nullable(),
      })
      .strict(),
    replayed: z.boolean(),
  })
  .strict();

export type AdminBillingLedgerAdjustmentRequest = z.infer<
  typeof adminBillingLedgerAdjustmentRequestSchema
>;
export type AdminBillingCheckoutReconcileRequest = z.infer<
  typeof adminBillingCheckoutReconcileRequestSchema
>;
export type AdminSubscriptionRefundRequest = z.infer<
  typeof adminSubscriptionRefundRequestSchema
>;
export type AdminBillingSubscriptionListItem = z.infer<
  typeof adminBillingSubscriptionListItemSchema
>;
export type AdminBillingSubscriptionListResponse = z.infer<
  typeof adminBillingSubscriptionListResponseSchema
>;
export type AdminSubscriptionRefundCommandResponse = z.infer<
  typeof adminSubscriptionRefundCommandResponseSchema
>;
