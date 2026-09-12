import { z } from "zod";
import { Errors } from "@/server/lib/errors";

/** Affiliate domain operations. The caller supplies the transaction client so this module remains
 * independent of Prisma generated types until the migration is applied. */
export const affiliateApplicationSchema = z.object({
  termsVersion: z.string().trim().min(1).max(40),
  channels: z.array(z.string().trim().min(1).max(120)).min(1).max(12),
}).strict();
export type AffiliateDb = {
 affiliateApplication: any; affiliateClick: any;
};
export async function applyAffiliate(db: AffiliateDb, userId: string, input: unknown) {
 const body = affiliateApplicationSchema.parse(input);
 const existing = await db.affiliateApplication.findUnique({ where: { userId } });
 if (existing?.status === "approved") return existing;
 return db.affiliateApplication.upsert({ where: { userId }, update: { ...body, status: "pending", reviewNote: null }, create: { id: crypto.randomUUID(), userId, ...body } });
}
export async function recordAffiliateClick(db: AffiliateDb, code: string, visitorKey: string, landingPath: string) {
 const app = await db.affiliateApplication.findFirst({ where: { id: code, status: "approved" } });
 if (!app) throw Errors.notFound("Affiliate link is unavailable");
 return db.affiliateClick.upsert({ where: { code_visitorKey: { code, visitorKey } }, update: {}, create: { id: crypto.randomUUID(), affiliateUserId: app.userId, code, visitorKey, landingPath } });
}
export async function affiliateDashboard(db: AffiliateDb, userId: string) {
 const app = await db.affiliateApplication.findUnique({ where: { userId } });
 if (!app) return { application: null, clicks: 0, conversions: 0, status: "not_applied" };
 const [clicks, conversions] = await Promise.all([
  db.affiliateClick.count({ where: { affiliateUserId: userId } }),
  db.affiliateClick.count({ where: { affiliateUserId: userId, convertedAt: { not: null } } }),
 ]);
 return { application: { id: app.id, status: app.status, termsVersion: app.termsVersion, channels: app.channels, reviewedAt: app.reviewedAt }, clicks, conversions, status: app.status };
}
