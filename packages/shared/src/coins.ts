import { z } from "zod";

export const coinOfferDraftSchema = z.object({
  offerKey: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{1,63}$/),
  name: z.string().trim().min(1).max(100),
  dreamcoins: z.number().int().min(1).max(10_000_000),
  priceCents: z.number().int().min(1).max(10_000_000),
  currency: z.string().toLowerCase().regex(/^[a-z]{3}$/),
  eligibility: z.enum(["all", "paid_access"]),
  terms: z.string().trim().min(20).max(4000),
}).strict();

export const coinOfferSchema = coinOfferDraftSchema.extend({
  id: z.string().min(1), version: z.number().int().positive(),
  status: z.enum(["draft", "published", "retired"]),
  publishedAt: z.string().nullable(), createdAt: z.string(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});

export const coinCheckoutRequestSchema = z.object({
  offerId: z.string().min(1).max(160),
  offerFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  returnPath: z.string().max(1000).refine((value) =>
    value.startsWith("/") && !value.startsWith("//") && !/[\\\u0000-\u001f]/.test(value),
  "Return path must be an internal path").default("/generate"),
}).strict();

export const coinPurchaseSchema = z.object({
  id: z.string(), status: z.string(), provider: z.string(),
  offer: coinOfferSchema.pick({ id: true, offerKey: true, version: true, name: true, dreamcoins: true,
    priceCents: true, currency: true, eligibility: true, terms: true, fingerprint: true }),
  invoiceId: z.string().nullable(), checkoutUrl: z.string().url().refine((value) =>
    ["https:", "http:"].includes(new URL(value).protocol), "Invalid checkout URL").nullable(),
  returnPath: z.string().nullable(), createdAt: z.string(), updatedAt: z.string(),
  needsReconciliation: z.boolean(),
});
export const coinCheckoutResponseSchema = z.object({ purchase: coinPurchaseSchema, balance: z.number().int() });
export const coinStoreSchema = z.object({
  viewerId: z.string().nullable(), balance: z.number().int().nullable(),
  billing: z.object({ provider: z.string(), demoMode: z.boolean() }),
  offers: z.array(coinOfferSchema.extend({ eligible: z.boolean() })),
});
export const coinHistorySchema = z.object({ items: z.array(coinPurchaseSchema), nextCursor: z.string().nullable() });
export type CoinOffer = z.infer<typeof coinOfferSchema>;
export type CoinCheckoutRequest = z.infer<typeof coinCheckoutRequestSchema>;
export type CoinPurchase = z.infer<typeof coinPurchaseSchema>;
export type CoinStore = z.infer<typeof coinStoreSchema>;
