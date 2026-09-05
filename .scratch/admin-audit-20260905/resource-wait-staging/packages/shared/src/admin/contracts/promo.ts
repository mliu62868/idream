import { z } from "zod";
import {
  adminIsoDateTimeSchema,
  adminJsonValueSchema,
  adminPageInfoSchema,
} from "./common";

/**
 * INVARIANT: 兑换码奖励的 Dreamcoin 上下界与 `packages/main/src/server/lib/redeem-codes.ts`
 * 的 MIN/MAX_REDEEM_CODE_DREAMCOINS 一致。契约包不能反向依赖 main，所以这里是字面量；
 * 兑换时的第二道校验仍在 main 侧，两边同时放宽才会真正放宽。
 */
const MIN_REDEEM_CODE_DREAMCOINS = 1;
const MAX_REDEEM_CODE_DREAMCOINS = 1_000_000;

export const adminRedeemCodeQuerySchema = z
  .object({
    search: z.string().trim().min(1).max(200).optional(),
    status: z.string().trim().min(1).max(80).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(100),
    cursor: z.string().trim().min(1).optional(),
    before: z.string().trim().min(1).optional(),
  })
  .strict();

export const adminRedeemCodeSchema = z
  .object({
    id: z.string().min(1),
    reward: adminJsonValueSchema,
    status: z.string().min(1),
    maxRedemptions: z.number().int().positive().nullable(),
    redemptions: z.number().int().nonnegative(),
    expiresAt: adminIsoDateTimeSchema.nullable(),
    createdAt: adminIsoDateTimeSchema,
  })
  .strict();

export const adminRedeemCodeListResponseSchema = z
  .object({
    items: z.array(adminRedeemCodeSchema),
    pageInfo: adminPageInfoSchema,
  })
  .strict();

export const adminRedeemCodeCreateRequestSchema = z.object({
  code: z.string().trim().min(4).max(80),
  reward: z
    .object({
      dreamcoins: z
        .number()
        .finite()
        .int()
        .min(MIN_REDEEM_CODE_DREAMCOINS)
        .max(MAX_REDEEM_CODE_DREAMCOINS),
      note: z.string().trim().max(200).optional(),
    })
    .passthrough(),
  maxRedemptions: z.number().int().min(1).max(1_000_000).nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

export const adminRedeemCodeDisableRequestSchema = z.object({
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

export const adminRedeemCodeMutationResponseSchema = z
  .object({
    id: z.string().min(1),
    status: z.string().min(1),
    replayed: z.boolean(),
  })
  .strict();

export const adminReferralQuerySchema = z
  .object({
    search: z.string().trim().min(1).max(200).optional(),
    inviterId: z.string().trim().min(1).max(160).optional(),
    status: z.string().trim().min(1).max(80).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(100),
    cursor: z.string().trim().min(1).optional(),
    before: z.string().trim().min(1).optional(),
  })
  .strict();

export const adminReferralSchema = z
  .object({
    id: z.string().min(1),
    inviterId: z.string().min(1),
    inviteeId: z.string().min(1).nullable(),
    code: z.string().min(1),
    status: z.string().min(1),
    subscriptionId: z.string().min(1).nullable(),
    rewardStatus: z.string().min(1),
    createdAt: adminIsoDateTimeSchema,
  })
  .strict();

export const adminReferralListResponseSchema = z
  .object({
    items: z.array(adminReferralSchema),
    pageInfo: adminPageInfoSchema,
  })
  .strict();

export type AdminRedeemCodeCreateRequest = z.infer<
  typeof adminRedeemCodeCreateRequestSchema
>;
export type AdminRedeemCodeDisableRequest = z.infer<
  typeof adminRedeemCodeDisableRequestSchema
>;
export type AdminRedeemCode = z.infer<typeof adminRedeemCodeSchema>;
export type AdminReferral = z.infer<typeof adminReferralSchema>;
