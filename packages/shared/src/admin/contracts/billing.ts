import { z } from "zod";
import { adminIsoDateTimeSchema } from "./common";

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

export type AdminBillingSubscriptionListItem = z.infer<
  typeof adminBillingSubscriptionListItemSchema
>;
export type AdminBillingSubscriptionListResponse = z.infer<
  typeof adminBillingSubscriptionListResponseSchema
>;
export type AdminSubscriptionRefundCommandResponse = z.infer<
  typeof adminSubscriptionRefundCommandResponseSchema
>;
