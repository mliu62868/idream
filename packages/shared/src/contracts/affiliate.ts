import { z } from "zod";

export const affiliateApplicationSchema = z.object({
  termsVersion: z.string().trim().min(1).max(40),
  channels: z.array(z.string().trim().min(1).max(120)).min(1).max(12),
}).strict();

export const affiliateAttributionQuerySchema = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
}).strict().refine(value => !value.from || !value.to || value.from <= value.to, { message: "Start date must not follow end date" });

export const affiliateAttributionEventSchema = z.object({
  id: z.string(),
  landingPath: z.string(),
  createdAt: z.iso.datetime(),
  convertedAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime(),
  attributionVersion: z.string().nullable(),
  attributionWindowDays: z.number().int().positive(),
  termsVersion: z.string().nullable(),
  state: z.enum(["valid", "pending", "revoked", "awaiting_signup", "expired"]),
  reason: z.enum(["active_customer_signup", "legacy_unverified", "account_unqualified", "account_inactive", "account_removed", "outside_window", "awaiting_signup", "window_expired"]),
}).strict();
export const affiliateAttributionHistorySchema = z.object({
  items: z.array(affiliateAttributionEventSchema),
  pageInfo: z.object({ endCursor: z.string().nullable(), hasNextPage: z.boolean() }).strict(),
  totalVisits: z.number().int().nonnegative(),
  totalSignups: z.number().int().nonnegative(),
  asOf: z.iso.datetime(),
  currentRule: z.object({ version: z.string(), windowDays: z.number().int().positive() }).strict(),
}).strict();
export const affiliatePromotionMaterialSchema = z.object({
  characterId: z.string(), name: z.string(), assetId: z.string(),
  imagePath: z.string(), downloadPath: z.string(), linkPath: z.string(),
}).strict();
export type AffiliateAttributionEvent = z.infer<typeof affiliateAttributionEventSchema>;
export type AffiliateAttributionHistory = z.infer<typeof affiliateAttributionHistorySchema>;
export const affiliateAttributionStateLabels: Record<AffiliateAttributionEvent["state"], string> = {
  valid: "Valid signup attribution", pending: "Pending verification", revoked: "Revoked signup attribution",
  awaiting_signup: "Awaiting signup", expired: "Visit expired",
};
export const affiliateAttributionReasonDescriptions: Record<AffiliateAttributionEvent["reason"], string> = {
  active_customer_signup: "Registered within the frozen window; the customer account is currently active.",
  legacy_unverified: "This historical signup has no complete account and rule evidence. It has not been marked valid.",
  account_unqualified: "The linked account is not currently a customer account. Signup qualification is unconfirmed.",
  account_inactive: "The linked account is currently suspended or deleted. The original signup remains recorded.",
  account_removed: "The linked account was erased. The original signup remains recorded.",
  outside_window: "The recorded signup falls outside this visit's attribution window.",
  awaiting_signup: "No signup has been observed from this visit; its attribution window is still open.",
  window_expired: "No signup was observed before this visit's attribution window ended.",
};
