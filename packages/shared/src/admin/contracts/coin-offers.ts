import { z } from "zod";
import { coinOfferDraftSchema, coinOfferSchema } from "../../coins";

export const adminCoinOfferCreateRequestSchema = coinOfferDraftSchema.extend({
  reason: z.string().trim().min(3).max(1000),
}).strict();
export const adminCoinOfferStateRequestSchema = z.object({
  version: z.number().int().positive(),
  action: z.enum(["publish", "retire"]),
  confirmation: z.string().min(1),
  reason: z.string().trim().min(3).max(1000),
}).strict();
export const adminCoinOfferListSchema = z.object({ items: z.array(coinOfferSchema) });
export const adminCoinOfferMutationSchema = z.object({ offer: coinOfferSchema });
