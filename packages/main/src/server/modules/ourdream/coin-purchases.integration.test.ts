import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CoinOffer, CheckoutSession } from "@prisma/client";
import { GET as listOffersRoute, POST as createOfferRoute } from "@/app/api/v2/admin/billing/coin-offers/route";
import { POST as stateRoute } from "@/app/api/v2/admin/billing/coin-offers/[id]/state/route";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { providers } from "@/server/providers";
import { coinOfferFingerprint } from "@/server/modules/billing/coin-offers";
import { adminV2Route } from "@/server/test/admin-v2-route-client";
import { api, createUser, dreamcoinBalance, expectError, expectOk, purgeTestData } from "@/server/test/helpers";

const P = "zt-coin-purchase-";
const adminId = `${P}admin`;
const supportId = `${P}support`;
const terms = "Controlled fixture only. No real funds or commercial promise are involved.";
async function cleanup() {
  await prisma.controlPlaneCommand.deleteMany({ where: { actorId: { startsWith: P } } });
  await prisma.checkoutSession.deleteMany({ where: { userId: { startsWith: P } } });
  await prisma.coinOffer.deleteMany({ where: { offerKey: { startsWith: P } } });
  await purgeTestData(P);
}
beforeAll(async () => { await cleanup(); await createUser({ id: adminId, role: "admin" }); await createUser({ id: supportId, role: "support" }); });
afterEach(() => vi.restoreAllMocks());
afterAll(cleanup);

async function fixture(label: string, changes: Partial<Pick<CoinOffer, "status" | "eligibility">> = {}) {
  const userId = `${P}${label}`;
  await createUser({ id: userId });
  const offer = await prisma.coinOffer.create({ data: { offerKey: `${P}${label}`, version: 1,
    name: "Controlled coins", dreamcoins: 125, priceCents: 99, currency: "usd", eligibility: "all",
    terms, status: "published", publishedAt: new Date(), ...changes } });
  return { userId, offer };
}
function checkout(userId: string, offer: CoinOffer, key = `${P}${crypto.randomUUID()}`) {
  return api("POST", "billing/coin-checkout", { userId, headers: { "idempotency-key": key },
    body: { offerId: offer.id, offerFingerprint: coinOfferFingerprint(offer), returnPath: "/generate?characterId=fixture" } });
}
function invoice(row: CheckoutSession, status: "created" | "settled" | "expired" = "settled") {
  if (row.amountCents === null || row.currency === null) throw new Error("Coin checkout lost its price authority");
  return { provider: "mock" as const, invoiceId: row.providerSessionId ?? `${P}invoice-${row.id}`,
    checkoutUrl: row.checkoutUrl ?? `https://mock-payments.idream.local/invoices/${row.id}`,
    status, additionalStatus: "none" as const, orderId: row.id, amountCents: row.amountCents, currency: row.currency };
}
function event(row: CheckoutSession, eventId: string) {
  return api("POST", "billing/webhooks/mock", { headers: { "x-provider-event-id": eventId },
    body: { invoiceId: row.providerSessionId, orderId: row.id, providerEventId: eventId } });
}
function state(offer: { id: string; version: number }, action: "publish" | "retire", key?: string) {
  return adminV2Route(stateRoute, { path: `billing/coin-offers/${offer.id}/state`, method: "POST",
    params: { id: offer.id }, userId: adminId, role: "admin", idempotencyKey: key,
    body: { version: offer.version, action, confirmation: `${offer.id}:${action}`, reason: "Controlled offer state test" } });
}

describe("coin catalog and durable payment authority", () => {
  it("authorizes, versions and publishes offers through canonical Admin v2 commands", async () => {
    const body = { offerKey: `${P}catalog`, name: "Controlled catalog", dreamcoins: 125,
      priceCents: 99, currency: "usd", eligibility: "all", terms, reason: "Controlled catalog test" };
    const send = (role: string, userId: string, key: string) => adminV2Route(createOfferRoute, {
      path: "billing/coin-offers", method: "POST", userId, role, idempotencyKey: key, body });
    expectError(await send("support", supportId, `${P}forbidden`), 403);
    const first = await send("admin", adminId, `${P}create-v1`); expectOk(first);
    const replay = await send("admin", adminId, `${P}create-v1`); expectOk(replay);
    expect(replay.data.offer.id).toBe(first.data.offer.id);
    const hidden = await api("GET", "billing/coin-offers"); expectOk(hidden);
    expect(hidden.data.offers.some((value: { id: string }) => value.id === first.data.offer.id)).toBe(false);
    expectOk(await state(first.data.offer, "publish", `${P}publish-v1`));
    expectOk(await state(first.data.offer, "publish", `${P}publish-v1`));
    const second = await send("admin", adminId, `${P}create-v2`); expectOk(second);
    expect(second.data.offer.version).toBe(2);
    expectError(await state({ ...second.data.offer, version: 1 }, "publish"), 409);
    expectOk(await state(second.data.offer, "publish"));
    expect((await prisma.coinOffer.findUniqueOrThrow({ where: { id: first.data.offer.id } })).status).toBe("retired");
    expect(await prisma.coinOffer.count({ where: { offerKey: body.offerKey, status: "published" } })).toBe(1);
    expect(await prisma.adminAuditLog.count({ where: { targetId: first.data.offer.id, action: "config.coin_offer.publish" } })).toBe(1);
    expectOk(await adminV2Route(listOffersRoute, { path: "billing/coin-offers", userId: adminId, role: "admin" }));
  });

  it("never grants coins or access for invoice creation, and replays the exact saved invoice", async () => {
    const { userId, offer } = await fixture("pending");
    const create = vi.spyOn(providers.payment, "createInvoice");
    const key = `${P}pending-key`;
    const first = await checkout(userId, offer, key); expectOk(first);
    const second = await checkout(userId, offer, key); expectOk(second);
    expect(first.data.purchase.status).toBe("created");
    expect(second.data.purchase.id).toBe(first.data.purchase.id);
    expect(create).toHaveBeenCalledOnce();
    expect(await dreamcoinBalance(userId)).toBe(0);
    expect(await prisma.subscription.count({ where: { userId } })).toBe(0);
    expect(await prisma.entitlement.count({ where: { userId } })).toBe(0);
    const changed = await checkout(userId, { ...offer, priceCents: 100 }, key);
    expectError(changed, 409);
    expect(await prisma.checkoutSession.count({ where: { userId } })).toBe(1);
  });

  it("settles concurrent verified deliveries exactly once without granting a subscription", async () => {
    const { userId, offer } = await fixture("settlement");
    const started = await checkout(userId, offer); expectOk(started);
    const row = await prisma.checkoutSession.findUniqueOrThrow({ where: { id: started.data.purchase.id } });
    vi.spyOn(providers.payment, "findInvoiceByOrderId").mockResolvedValue({ ok: true, data: invoice(row) });
    const results = await Promise.all([event(row, `${P}settled-a`), event(row, `${P}settled-b`)]);
    results.forEach((result) => expectOk(result));
    expectOk(await event(row, `${P}settled-a`));
    expect(await dreamcoinBalance(userId)).toBe(125);
    expect(await prisma.dreamcoinLedger.count({ where: { userId, reason: "topup" } })).toBe(1);
    expect(await prisma.analyticsEvent.count({ where: { userId, name: "coin_topup_completed" } })).toBe(1);
    expect(await prisma.subscription.count({ where: { userId } })).toBe(0);
    expect(await prisma.entitlement.count({ where: { userId } })).toBe(0);
    const refreshed = await api("POST", `billing/coin-purchases/${row.id}/reconcile`, { userId }); expectOk(refreshed);
    expect(refreshed.data).toMatchObject({ balance: 125, purchase: { status: "completed" } });
  });

  it("honors an accepted snapshot after retirement while rejecting new purchases of it", async () => {
    const { userId, offer } = await fixture("retired");
    const key = `${P}retired-existing`;
    const started = await checkout(userId, offer, key); expectOk(started);
    expectOk(await state(offer, "retire"));
    expectError(await checkout(userId, offer), 409);
    const replay = await checkout(userId, offer, key); expectOk(replay);
    expect(replay.data.purchase.offer).toMatchObject({ dreamcoins: 125, priceCents: 99, terms, version: 1 });
    const row = await prisma.checkoutSession.findUniqueOrThrow({ where: { id: started.data.purchase.id } });
    vi.spyOn(providers.payment, "findInvoiceByOrderId").mockResolvedValue({ ok: true, data: invoice(row) });
    expectOk(await event(row, `${P}retired-settled`));
    expect(await dreamcoinBalance(userId)).toBe(125);
  });

  it("recovers an ambiguous provider submission by order lookup without a second invoice POST", async () => {
    const { userId, offer } = await fixture("unknown");
    const create = vi.spyOn(providers.payment, "createInvoice").mockResolvedValue({ ok: false,
      error: { code: "invoice_create_timeout", message: "Controlled lost response", retryable: true } });
    const lookup = vi.spyOn(providers.payment, "findInvoiceByOrderId").mockResolvedValue({ ok: true, data: null });
    const key = `${P}unknown-key`;
    expectError(await checkout(userId, offer, key), 503);
    const row = await prisma.checkoutSession.findFirstOrThrow({ where: { userId } });
    expect(row).toMatchObject({ status: "provider_unknown", needsReconciliation: true });
    lookup.mockResolvedValue({ ok: true, data: invoice(row) });
    const recovered = await checkout(userId, offer, key); expectOk(recovered);
    expect(recovered.data.purchase.status).toBe("completed");
    expect(create).toHaveBeenCalledOnce();
    expect(await dreamcoinBalance(userId)).toBe(125);
  });

  it("does not fulfill unpaid or mismatched provider invoices", async () => {
    const { userId, offer } = await fixture("unpaid");
    const started = await checkout(userId, offer); expectOk(started);
    const row = await prisma.checkoutSession.findUniqueOrThrow({ where: { id: started.data.purchase.id } });
    const lookup = vi.spyOn(providers.payment, "findInvoiceByOrderId").mockResolvedValue({ ok: true, data: invoice(row, "created") });
    expectError(await event(row, `${P}unpaid-event`), 409);
    lookup.mockResolvedValue({ ok: true, data: { ...invoice(row), amountCents: 1 } });
    expectError(await event(row, `${P}wrong-amount-event`), 409);
    expect(await dreamcoinBalance(userId)).toBe(0);
    expect((await prisma.checkoutSession.findUniqueOrThrow({ where: { id: row.id } })).status).not.toBe("completed");
  });

  it("credits a late-paid invoice exactly once when the provider later confirms settlement", async () => {
    const { userId, offer } = await fixture("late-paid");
    const started = await checkout(userId, offer); expectOk(started);
    const row = await prisma.checkoutSession.findUniqueOrThrow({ where: { id: started.data.purchase.id } });
    const lookup = vi.spyOn(providers.payment, "findInvoiceByOrderId").mockResolvedValue({ ok: true, data: { ...invoice(row, "expired"), additionalStatus: "paid_late" } });
    await api("POST", `billing/coin-purchases/${row.id}/reconcile`, { userId });
    expect(await prisma.checkoutSession.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: "provider_unknown", needsReconciliation: true });
    expect(await dreamcoinBalance(userId)).toBe(0);
    // The provider later settles the same invoice; its verified webhook must credit it.
    lookup.mockResolvedValue({ ok: true, data: invoice(row) });
    expectOk(await event(row, `${P}late-paid-settled`));
    expectOk(await event(row, `${P}late-paid-settled-redelivery`));
    expect(await dreamcoinBalance(userId)).toBe(125);
    expect(await prisma.checkoutSession.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: "completed", needsReconciliation: false });
  });

  it("keeps an unknown checkout bound to its original provider across configuration changes", async () => {
    const { userId, offer } = await fixture("provider-switch");
    const create = vi.spyOn(providers.payment, "createInvoice").mockResolvedValue({ ok: false,
      error: { code: "invoice_create_timeout", message: "Controlled lost response", retryable: true } });
    const lookup = vi.spyOn(providers.payment, "findInvoiceByOrderId").mockResolvedValue({ ok: true, data: null });
    const key = `${P}provider-switch-key`;
    expectError(await checkout(userId, offer, key), 503);
    const row = await prisma.checkoutSession.findFirstOrThrow({ where: { userId } });
    const initialLookups = lookup.mock.calls.length;
    const configuredProvider = env.PAYMENT_PROVIDER;
    try {
      env.PAYMENT_PROVIDER = "btcpay";
      // A 5xx envelope carries no details, so it never tells a client to drop
      // its key; only an explicit new_key does. The original invoice stays bound.
      const retry = await checkout(userId, offer, key);
      expectError(retry, 503);
      expect(retry.error?.details).toBeUndefined();
      const reconcile = await api("POST", `billing/coin-purchases/${row.id}/reconcile`, { userId });
      expectError(reconcile, 503);
      expect(reconcile.error?.details).toBeUndefined();
      expect(lookup).toHaveBeenCalledTimes(initialLookups);
      expect(create).toHaveBeenCalledOnce();
      expect(await prisma.checkoutSession.count({ where: { userId } })).toBe(1);
      expect(await prisma.checkoutSession.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
        provider: "mock", status: "provider_unknown", needsReconciliation: true, requestHash: row.requestHash,
      });
    } finally { env.PAYMENT_PROVIDER = configuredProvider; }
    lookup.mockResolvedValue({ ok: true, data: invoice(row) });
    const recovered = await checkout(userId, offer, key); expectOk(recovered);
    expect(recovered.data.purchase).toMatchObject({ id: row.id, status: "completed", provider: "mock" });
    expect(create).toHaveBeenCalledOnce();
    expect(await dreamcoinBalance(userId)).toBe(125);
  });

  it("constrains history, reconciliation and checkout to the current viewer", async () => {
    const { userId, offer } = await fixture("owner");
    const otherId = `${P}other`; await createUser({ id: otherId });
    const started = await checkout(userId, offer); expectOk(started);
    const own = await api("GET", "billing/coin-purchases", { userId }); expectOk(own);
    expect(own.data.items.map((value: { id: string }) => value.id)).toEqual([started.data.purchase.id]);
    const other = await api("GET", "billing/coin-purchases", { userId: otherId }); expectOk(other);
    expect(other.data.items).toEqual([]);
    expectError(await api("POST", `billing/coin-purchases/${started.data.purchase.id}/reconcile`, { userId: otherId }), 404);
    expectError(await api("GET", "billing/coin-purchases", { userId: otherId, query: { cursor: started.data.purchase.id } }), 400);
    expectError(await api("POST", "billing/coin-checkout", { userId: otherId,
      headers: { "x-idream-viewer-scope": `user:${userId}`, "idempotency-key": `${P}changed-viewer` },
      body: { offerId: offer.id, offerFingerprint: coinOfferFingerprint(offer), returnPath: "/generate" } }), 409);
  });

  it("enforces active paid access and rejects fabricated auto-confirm fields", async () => {
    const { userId, offer } = await fixture("paid-gate", { eligibility: "paid_access" });
    const catalog = await api("GET", "billing/coin-offers", { userId }); expectOk(catalog);
    expect(catalog.data.offers.find((value: { id: string }) => value.id === offer.id).eligible).toBe(false);
    const rejected = await checkout(userId, offer);
    expectError(rejected, 403);
    expect(rejected.error?.details.idempotencyAction).toBe("new_key");
    expectError(await api("POST", "billing/coin-checkout", { userId, headers: { "idempotency-key": `${P}fake-confirm` },
      body: { offerId: offer.id, offerFingerprint: coinOfferFingerprint(offer), autoConfirm: true } }), 400);
    expect(await prisma.checkoutSession.count({ where: { userId } })).toBe(0);
  });
});
