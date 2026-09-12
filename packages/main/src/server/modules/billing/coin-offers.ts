import { createHash } from "node:crypto";
import { z } from "zod";
import type { CoinOffer, CheckoutSession, Prisma } from "@prisma/client";
import { coinOfferSchema } from "@idream/shared/coins";
import type { adminCoinOfferCreateRequestSchema, adminCoinOfferStateRequestSchema } from "@idream/shared/admin";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { getAuthCtx } from "@/server/lib/auth";
import { ok } from "@/server/lib/http";
import { toInputJson } from "@/server/lib/request-json";
import { enforceApproval } from "@/server/modules/admin-v2/approvals/enforcement";
import { executeAtomicIdempotentMutation } from "@/server/modules/admin-v2/shared/atomic-mutation";
import { adminRequestId } from "@/server/modules/admin-v2/shared/audit-request";
import { actorWithPermission, type AdminActor } from "@/server/modules/admin-v2/shared/authority";
import { createClassifiedAnalyticsEvent } from "@/server/modules/admin-v2/metrics/classified-event-writer";
import { activeSubscriptionWhere } from "@/server/modules/ourdream/subscription-lifecycle";
import { dreamcoinBalance, postDreamcoinEntry } from "./ledger";

export const coinOfferSnapshotSchema = coinOfferSchema.pick({ id: true, offerKey: true, version: true, name: true,
  dreamcoins: true, priceCents: true, currency: true, eligibility: true, terms: true, fingerprint: true,
}).extend({ schemaVersion: z.literal("coin-offer-v1") });
type OfferFields = Pick<CoinOffer, "id" | "offerKey" | "version" | "name" | "dreamcoins" | "priceCents" | "currency" | "eligibility" | "terms">;

function offerFields(offer: OfferFields) {
  return { id: offer.id, offerKey: offer.offerKey, version: offer.version, name: offer.name,
    dreamcoins: offer.dreamcoins, priceCents: offer.priceCents, currency: offer.currency,
    eligibility: offer.eligibility, terms: offer.terms };
}
export function coinOfferFingerprint(offer: OfferFields) {
  return createHash("sha256").update(JSON.stringify(offerFields(offer))).digest("hex");
}
export function coinOfferSnapshot(offer: CoinOffer) {
  return coinOfferSnapshotSchema.parse({ ...offerFields(offer), schemaVersion: "coin-offer-v1", fingerprint: coinOfferFingerprint(offer) });
}
export function coinOfferDTO(offer: CoinOffer) {
  return coinOfferSchema.parse({ ...offerFields(offer), fingerprint: coinOfferFingerprint(offer),
    status: offer.status, publishedAt: offer.publishedAt?.toISOString() ?? null, createdAt: offer.createdAt.toISOString() });
}
export function readCoinPurchase(checkout: CheckoutSession) {
  const parsed = coinOfferSnapshotSchema.safeParse(checkout.offerSnapshot);
  if (!parsed.success || checkout.planId || parsed.data.id !== checkout.coinOfferId ||
    parsed.data.priceCents !== checkout.amountCents || parsed.data.currency !== checkout.currency ||
    parsed.data.fingerprint !== coinOfferFingerprint(parsed.data)) {
    throw Errors.unavailable("Coin purchase is missing its authoritative offer snapshot", { checkoutId: checkout.id });
  }
  const { schemaVersion: _schemaVersion, ...offer } = parsed.data;
  return { id: checkout.id, status: checkout.status, provider: checkout.provider, offer,
    invoiceId: checkout.providerSessionId, checkoutUrl: checkout.checkoutUrl, returnPath: checkout.returnPath,
    createdAt: checkout.createdAt.toISOString(), updatedAt: checkout.updatedAt.toISOString(), needsReconciliation: checkout.needsReconciliation };
}

export async function coinOfferEligible(userId: string, eligibility: string, db: Prisma.TransactionClient | typeof prisma = prisma) {
  return eligibility === "all" || (eligibility === "paid_access" &&
    Boolean(await db.subscription.findFirst({ where: activeSubscriptionWhere(userId), select: { id: true } })));
}
export async function listCoinOffers(request: Request) {
  const ctx = await getAuthCtx(request);
  const userId = ctx.userId ?? null;
  const [offers, balance, paid] = await Promise.all([
    prisma.coinOffer.findMany({ where: { status: "published" }, orderBy: [{ priceCents: "asc" }, { id: "asc" }] }),
    userId ? dreamcoinBalance(userId) : null,
    userId ? coinOfferEligible(userId, "paid_access") : false,
  ]);
  return ok({ viewerId: userId, balance, billing: { provider: env.PAYMENT_PROVIDER, demoMode: env.PAYMENT_PROVIDER === "mock" },
    offers: offers.map((offer) => ({ ...coinOfferDTO(offer), eligible: Boolean(userId && (offer.eligibility === "all" || paid)) })) },
  { headers: { "cache-control": "private, no-store" } });
}

/** One provider-confirmed purchase grants coins without creating plan access. */
export async function settleCoinPurchaseInTx(tx: Prisma.TransactionClient, checkout: CheckoutSession) {
  const purchase = readCoinPurchase(checkout);
  if (checkout.status === "completed") return checkout;
  if (!checkout.providerSessionId || checkout.needsReconciliation ||
    (checkout.providerInvoiceStatus !== "settled" && !(checkout.provider === "mock" && checkout.autoConfirm))) {
    throw Errors.conflict("The payment provider has not confirmed this coin purchase", { checkoutId: checkout.id });
  }
  await postDreamcoinEntry(tx, { kind: "topup", userId: checkout.userId, amount: purchase.offer.dreamcoins,
    sourceId: checkout.id, idempotencyKey: `coin-topup:${checkout.id}` });
  const completed = await tx.checkoutSession.update({ where: { id: checkout.id }, data: {
    status: "completed", providerInvoiceStatus: "settled", failureCode: null, needsReconciliation: false,
  } });
  await createClassifiedAnalyticsEvent(tx, { userId: checkout.userId, name: "coin_topup_completed",
    props: { checkoutId: checkout.id, offerId: purchase.offer.id, offerVersion: purchase.offer.version,
      dreamcoins: purchase.offer.dreamcoins, amountCents: purchase.offer.priceCents, currency: purchase.offer.currency },
    sourceEventId: `checkout:${checkout.id}:coin_topup_completed`, sourceService: "billing", trustClass: "server_trusted" });
  return completed;
}

export async function listAdminCoinOffers(request: Request) {
  await actorWithPermission(request, "billing.read");
  const offers = await prisma.coinOffer.findMany({ orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 200 });
  return { items: offers.map(coinOfferDTO) };
}
export async function createCoinOffer(request: Request, actor: AdminActor,
  body: z.infer<typeof adminCoinOfferCreateRequestSchema>, idempotencyKey: string) {
  return executeAtomicIdempotentMutation({ environment: env.APP_ENV, actor, idempotencyKey, requestId: adminRequestId(request),
    commandType: "config.coin_offer.create", target: { type: "coin_offer", id: body.offerKey }, payload: body,
    mutate: async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`coin-offer:${body.offerKey}`}))`;
      const latest = await tx.coinOffer.findFirst({ where: { offerKey: body.offerKey }, orderBy: { version: "desc" } });
      const { reason, ...fields } = body;
      const offer = await tx.coinOffer.create({ data: { ...fields, version: (latest?.version ?? 0) + 1, status: "draft" } });
      await tx.adminAuditLog.create({ data: { actorId: actor.id, actorRole: actor.role, action: "config.coin_offer.create",
        targetType: "coin_offer", targetId: offer.id, reason, after: toInputJson(coinOfferDTO(offer)) } });
      return { offer: coinOfferDTO(offer) };
    } });
}
export async function changeCoinOfferState(request: Request, actor: AdminActor, id: string,
  body: z.infer<typeof adminCoinOfferStateRequestSchema>, idempotencyKey: string) {
  if (body.confirmation !== `${id}:${body.action}`) throw Errors.badRequest("Confirmation must identify the offer and action");
  return executeAtomicIdempotentMutation({ environment: env.APP_ENV, actor, idempotencyKey, requestId: adminRequestId(request),
    commandType: "config.coin_offer.state", target: { type: "coin_offer", id }, expectedVersion: body.version, payload: body,
    mutate: async (tx) => {
      const identity = await tx.coinOffer.findUnique({ where: { id }, select: { offerKey: true } });
      if (!identity) throw Errors.notFound("Coin offer not found");
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`coin-offer:${identity.offerKey}`}))`;
      const current = await tx.coinOffer.findUniqueOrThrow({ where: { id } });
      if (current.version !== body.version || current.status !== (body.action === "publish" ? "draft" : "published")) {
        throw Errors.conflict("Coin offer changed. Reload the catalog before continuing.");
      }
      if (body.action === "publish") {
        await enforceApproval("config.coin_offer.publish", id, tx);
        await tx.coinOffer.updateMany({ where: { offerKey: current.offerKey, status: "published" }, data: { status: "retired" } });
      }
      const offer = await tx.coinOffer.update({ where: { id }, data: body.action === "publish"
        ? { status: "published", publishedAt: new Date() } : { status: "retired" } });
      await tx.adminAuditLog.create({ data: { actorId: actor.id, actorRole: actor.role, action: `config.coin_offer.${body.action}`,
        targetType: "coin_offer", targetId: id, reason: body.reason,
        before: toInputJson(coinOfferDTO(current)), after: toInputJson(coinOfferDTO(offer)) } });
      return { offer: coinOfferDTO(offer) };
    } });
}
