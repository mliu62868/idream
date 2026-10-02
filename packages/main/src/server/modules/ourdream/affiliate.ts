import type { AffiliateClick, PrismaClient, Prisma, User } from "@prisma/client";
import { z } from "zod";
import { affiliateApplicationSchema, affiliateAttributionQuerySchema, type AffiliateAttributionEvent } from "@idream/shared/contracts";
import { Errors } from "@/server/lib/errors";
import { canonicalJsonHash } from "@/server/modules/admin-v2/shared/idempotency";
import { evaluateMediaAssetCustomerPublishability } from "@/server/lib/media-asset-authority";
import { publicCharacterAudienceWhere } from "./public-content-audience";

/** Affiliate domain operations. The caller supplies the client (prisma or a transaction) so the
 * module stays usable inside an outer transaction. */
export type AffiliateDb = Pick<PrismaClient, "affiliateApplication" | "affiliateClick" | "user" | "character">;

// SPEC: a signup counts as a conversion when the browser made an affiliate click
// within this many days. Commission and settlement are out of scope (AF-03).
export const AFFILIATE_ATTRIBUTION_WINDOW_DAYS = 30;
export const AFFILIATE_ATTRIBUTION_VERSION = "affiliate-signup-v1";
const attributionWindowMs = (click: Pick<AffiliateClick, "attributionWindowDays">) =>
  (click.attributionWindowDays ?? AFFILIATE_ATTRIBUTION_WINDOW_DAYS) * 86_400_000;
function landingPathOnly(value: string) {
  if (!value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(value)) throw Errors.badRequest("Use a local landing path");
  const path = new URL(value, "https://idream.invalid");
  if (path.origin !== "https://idream.invalid") throw Errors.badRequest("Use a local landing path");
  return path.pathname;
}
function observedLandingPath(value: string) {
  try { return landingPathOnly(value); }
  catch { return "Unverified historical landing path"; }
}

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
/**
 * SPEC: one click per code per visitor per attribution window.
 * INTENT: independent browsers can share an IP and User-Agent. Only a valid
 * server-issued cookie reuses that browser's click; otherwise the server mints
 * a new opaque identity. Client-named keys and unknown cookies never choose it.
 * The public route separately rate limits requests per address.
 */
/** Returns null when the promoter clicked their own link: that is not traffic. */
export async function recordAffiliateClick(db: AffiliateDb, input: {
  code: string;
  cookieVisitorKey: string | null;
  landingPath: string;
  viewerUserId: string | undefined;
}) {
 const { code } = input;
 const landingPath = landingPathOnly(input.landingPath);
 const now = new Date();
 const app = await db.affiliateApplication.findFirst({ where: { id: code, status: "approved" } });
 if (!app) throw Errors.notFound("Affiliate link is unavailable");
 if (input.viewerUserId === app.userId) return null;
 if (input.cookieVisitorKey) {
   const earlier = await db.affiliateClick.findUnique({ where: { code_visitorKey: { code, visitorKey: input.cookieVisitorKey } } });
   // Returning visits renew the browser cookie, not the original click's
   // attribution window. An expired row must not swallow a fresh visit.
   if (earlier && earlier.createdAt <= now && earlier.createdAt.getTime() + attributionWindowMs(earlier) >= now.getTime()) return earlier;
 }
 return db.affiliateClick.create({ data: {
   id: crypto.randomUUID(), affiliateUserId: app.userId, code, visitorKey: crypto.randomUUID(), landingPath, createdAt: now,
   attributionVersion: AFFILIATE_ATTRIBUTION_VERSION, attributionWindowDays: AFFILIATE_ATTRIBUTION_WINDOW_DAYS, termsVersion: app.termsVersion,
 } });
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
  const click = await db.affiliateClick.findUnique({ where: { code_visitorKey: { code, visitorKey } } });
  if (!click || click.convertedAt || click.affiliateUserId === newUserId || click.createdAt > now ||
      click.createdAt.getTime() + attributionWindowMs(click) < now.getTime()) return 0;
  const converted = await db.affiliateClick.updateMany({
    where: { id: click.id, convertedAt: null },
    data: { convertedAt: now, convertedUserId: newUserId },
  });
  return converted.count;
}

const attributionCursorSchema = z.object({ scope: z.string().length(64), id: z.string().min(1), createdAt: z.iso.datetime(), asOf: z.iso.datetime() }).strict();
type ConversionAccount = Pick<User, "id" | "status" | "deletedAt" | "dataClass" | "role">;

function attributionState(click: AffiliateClick, account: ConversionAccount | undefined, now: Date): Pick<AffiliateAttributionEvent, "state" | "reason"> {
  const expiresAt = click.createdAt.getTime() + attributionWindowMs(click);
  if (!click.convertedAt) return now.getTime() <= expiresAt
    ? { state: "awaiting_signup", reason: "awaiting_signup" } : { state: "expired", reason: "window_expired" };
  if (click.convertedAt < click.createdAt || click.convertedAt.getTime() > expiresAt) return { state: "revoked", reason: "outside_window" };
  if (!click.convertedUserId || !click.attributionVersion || !click.attributionWindowDays || !click.termsVersion) return { state: "pending", reason: "legacy_unverified" };
  if (!account) return { state: "revoked", reason: "account_removed" };
  if (account.status !== "active" || account.deletedAt) return { state: "revoked", reason: "account_inactive" };
  if (account.role !== "user" || account.dataClass !== "customer") return { state: "pending", reason: "account_unqualified" };
  return { state: "valid", reason: "active_customer_signup" };
}

/** Observed signup identity is immutable. Account state is checked now, and is
 * neither a commission qualification nor a rewrite of the original observation. */
export async function affiliateAttributionHistory(db: AffiliateDb, userId: string, input: unknown = {}, includeAccountIds = false) {
  const query = affiliateAttributionQuerySchema.parse(input), now = new Date();
  const scope = canonicalJsonHash({ userId, from: query.from ?? null, to: query.to ?? null });
  let cursor: z.infer<typeof attributionCursorSchema> | null = null;
  if (query.cursor) {
    try { cursor = attributionCursorSchema.parse(JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"))); }
    catch { throw Errors.badRequest("Invalid attribution cursor. Reload the first page."); }
    if (cursor.scope !== scope || Date.parse(cursor.asOf) > now.getTime()) throw Errors.badRequest("Attribution cursor belongs to another owner or date filter. Reload the first page.");
  }
  const asOf = cursor ? new Date(cursor.asOf) : now;
  const where: Prisma.AffiliateClickWhereInput = { affiliateUserId: userId, createdAt: {
    lte: asOf,
    ...(query.from ? { gte: new Date(`${query.from}T00:00:00.000Z`) } : {}),
    ...(query.to ? { lt: new Date(Date.parse(`${query.to}T00:00:00.000Z`) + 86_400_000) } : {}),
  } };
  const [rows, totalVisits, totalSignups] = await Promise.all([
    db.affiliateClick.findMany({ where: { AND: [where, ...(cursor ? [{ OR: [{ createdAt: { lt: new Date(cursor.createdAt) } }, { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } }] }] : [])] }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: query.limit + 1 }),
    db.affiliateClick.count({ where }), db.affiliateClick.count({ where: { AND: [where, { convertedAt: { not: null } }] } }),
  ]);
  const page = rows.slice(0, query.limit), accountIds = [...new Set(page.flatMap(click => click.convertedUserId ? [click.convertedUserId] : []))];
  const accounts = accountIds.length ? await db.user.findMany({ where: { id: { in: accountIds } }, select: { id: true, status: true, deletedAt: true, dataClass: true, role: true } }) : [];
  const byId = new Map(accounts.map(account => [account.id, account])), last = page.at(-1);
  return {
    items: page.map(click => ({ id: click.id, landingPath: observedLandingPath(click.landingPath), createdAt: click.createdAt.toISOString(), convertedAt: click.convertedAt?.toISOString() ?? null,
      expiresAt: new Date(click.createdAt.getTime() + attributionWindowMs(click)).toISOString(),
      attributionVersion: click.attributionVersion, attributionWindowDays: click.attributionWindowDays ?? AFFILIATE_ATTRIBUTION_WINDOW_DAYS, termsVersion: click.termsVersion,
      ...attributionState(click, byId.get(click.convertedUserId ?? ""), now), ...(includeAccountIds ? { convertedUserId: click.convertedUserId } : {}),
    })),
    pageInfo: { hasNextPage: rows.length > query.limit, endCursor: rows.length > query.limit && last ? Buffer.from(JSON.stringify({ scope, id: last.id, createdAt: last.createdAt.toISOString(), asOf: asOf.toISOString() })).toString("base64url") : null },
    totalVisits, totalSignups, asOf: asOf.toISOString(), currentRule: { version: AFFILIATE_ATTRIBUTION_VERSION, windowDays: AFFILIATE_ATTRIBUTION_WINDOW_DAYS },
  };
}

export async function affiliateDashboard(db: AffiliateDb, userId: string, query: unknown = {}) {
 const app = await db.affiliateApplication.findUnique({ where: { userId } });
 const attribution = await affiliateAttributionHistory(db, userId, query);
 const linkPath = app?.status === "approved" ? `/?aff=${encodeURIComponent(app.id)}` : null;
 const publicCharacters = linkPath ? await db.character.findMany({ where: publicCharacterAudienceWhere, include: { imageAsset: true }, orderBy: [{ name: "asc" }, { id: "asc" }], take: 12 }) : [];
 const materials = publicCharacters.flatMap(character => {
   const asset = character.imageAsset;
   if (!asset || !evaluateMediaAssetCustomerPublishability({ metadata: asset.metadata }).publishable) return [];
   return [{ characterId: character.id, name: character.name, assetId: asset.id, imagePath: `/api/v1/media/${encodeURIComponent(asset.id)}/content`, downloadPath: `/api/v1/media/${encodeURIComponent(asset.id)}/content?download=1`, linkPath: linkPath! }];
 });
 if (!app) return { application: null, clicks: 0, conversions: 0, status: "not_applied", linkPath: null, materials, attribution };
 return {
   application: { id: app.id, status: app.status, termsVersion: app.termsVersion, channels: app.channels, reviewNote: app.reviewNote, reviewedAt: app.reviewedAt },
   clicks: attribution.totalVisits,
   conversions: attribution.totalSignups,
   status: app.status,
   // The code is live only after approval; before that there is no link to share.
   linkPath, materials, attribution,
 };
}
