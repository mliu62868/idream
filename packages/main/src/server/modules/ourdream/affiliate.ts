import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { Errors } from "@/server/lib/errors";

/** Affiliate domain operations. The caller supplies the client (prisma or a transaction) so the
 * module stays usable inside an outer transaction. */
export const affiliateApplicationSchema = z.object({
  termsVersion: z.string().trim().min(1).max(40),
  channels: z.array(z.string().trim().min(1).max(120)).min(1).max(12),
}).strict();
export type AffiliateDb = Pick<PrismaClient, "affiliateApplication" | "affiliateClick">;

// SPEC: a signup counts as a conversion when the browser made an affiliate click
// within this many days. Commission and settlement are out of scope (AF-03).
export const AFFILIATE_ATTRIBUTION_WINDOW_DAYS = 30;

/**
 * SPEC: the affiliate terms authority is the published CMS page at /affiliate.
 * Its publication timestamp is the terms version an applicant accepts.
 * INTENT: the applicant never names the version; with nothing published,
 * applications are closed rather than accepted against unstated terms.
 */
export const AFFILIATE_TERMS_PATH = "/affiliate";
export type AffiliateTerms =
  | { state: "published"; version: string; title: string; path: string }
  | { state: "unpublished" }
  | { state: "unavailable" };

export async function applyAffiliate(db: AffiliateDb, userId: string, input: unknown, terms: AffiliateTerms) {
 const body = affiliateApplicationSchema.parse(input);
 const existing = await db.affiliateApplication.findUnique({ where: { userId } });
 if (existing?.status === "approved") return existing;
 if (terms.state === "unavailable") throw Errors.unavailable("Affiliate terms could not be loaded. Try again.");
 if (terms.state !== "published") throw Errors.conflict("Affiliate terms are not published yet, so applications are closed.");
 if (body.termsVersion !== terms.version) {
   throw Errors.conflict("The affiliate terms changed. Review the current terms and apply again.", { termsVersion: terms.version });
 }
 // An approval may race a resubmission: the write itself must preserve approved status.
 if (!existing) await db.affiliateApplication.upsert({ where: { userId }, update: {}, create: { id: crypto.randomUUID(), userId, ...body } });
 await db.affiliateApplication.updateMany({
   where: { userId, status: { not: "approved" } },
   data: { ...body, status: "pending", reviewNote: null, reviewedAt: null },
 });
 return db.affiliateApplication.findUniqueOrThrow({ where: { userId } });
}
export async function recordAffiliateClick(db: AffiliateDb, code: string, visitorKey: string, landingPath: string) {
 const app = await db.affiliateApplication.findFirst({ where: { id: code, status: "approved" } });
 if (!app) throw Errors.notFound("Affiliate link is unavailable");
 return db.affiliateClick.upsert({ where: { code_visitorKey: { code, visitorKey } }, update: {}, create: { id: crypto.randomUUID(), affiliateUserId: app.userId, code, visitorKey, landingPath } });
}

/**
 * Marks the browser's affiliate click as converted by this new signup.
 * INVARIANT: one click converts at most once, only inside the window, and never
 * by the affiliate's own account.
 */
export async function attributeAffiliateSignup(
  db: Pick<PrismaClient, "affiliateClick">,
  cookieValue: string | undefined,
  newUserId: string,
  now = new Date(),
) {
  const separator = cookieValue?.indexOf(":") ?? -1;
  if (!cookieValue || separator <= 0) return 0;
  const code = cookieValue.slice(0, separator);
  const visitorKey = cookieValue.slice(separator + 1);
  const since = new Date(now.getTime() - AFFILIATE_ATTRIBUTION_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const converted = await db.affiliateClick.updateMany({
    where: { code, visitorKey, convertedAt: null, createdAt: { gte: since }, affiliateUserId: { not: newUserId } },
    data: { convertedAt: now },
  });
  return converted.count;
}

export async function affiliateDashboard(db: AffiliateDb, userId: string) {
 const app = await db.affiliateApplication.findUnique({ where: { userId } });
 if (!app) return { application: null, clicks: 0, conversions: 0, status: "not_applied", linkPath: null };
 const [clicks, conversions] = await Promise.all([
  db.affiliateClick.count({ where: { affiliateUserId: userId } }),
  db.affiliateClick.count({ where: { affiliateUserId: userId, convertedAt: { not: null } } }),
 ]);
 return {
   application: { id: app.id, status: app.status, termsVersion: app.termsVersion, channels: app.channels, reviewNote: app.reviewNote, reviewedAt: app.reviewedAt },
   clicks,
   conversions,
   status: app.status,
   // The code is live only after approval; before that there is no link to share.
   linkPath: app.status === "approved" ? `/?aff=${encodeURIComponent(app.id)}` : null,
 };
}
