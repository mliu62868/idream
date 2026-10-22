import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { POST as refundRoute } from "@/app/api/v2/admin/billing/subscriptions/[id]/refund/route";
import { POST as reconcileRoute } from "@/app/api/v2/admin/billing/subscriptions/[id]/refund/reconcile/route";
import { prisma } from "@/server/lib/db";
import { postDreamcoinEntry } from "@/server/modules/billing/ledger";
import { parseSubscriptionRefundEvidence } from "@/server/modules/billing/subscription-refund";
import * as refundAuthority from "@/server/modules/billing/subscription-refund";
import { reconcileExpiredCommandLeases } from "@/server/modules/admin-v2/shared/control-plane-command";
import { activateSubscriptionInTx, lockUserLedger } from "@/server/modules/ourdream/subscription-lifecycle";
import { providers } from "@/server/providers";
import type { PaymentRefund } from "@/server/providers/types";
import { adminV2Route } from "@/server/test/admin-v2-route-client";
import { createPlan, createUser, expectOk, purgeTestData } from "@/server/test/helpers";

const P = "zt-refund-races-";
const actorId = `${P}admin`;
const planId = `${P}plan`;
const offer = {
  version: 1 as const, planId, slug: `${P}premium`, name: "Premium", billingPeriod: "monthly" as const,
  priceCents: 1_999, currency: "usd", includedDreamcoins: 1_500,
  features: { imageGeneration: true },
};

async function cleanup() {
  await prisma.controlPlaneCommand.deleteMany({ where: { actorId } });
  await purgeTestData(P);
}

beforeAll(async () => {
  await cleanup();
  await createUser({ id: actorId, role: "admin", dataClass: "internal" });
  await createPlan({ id: planId, slug: offer.slug, includedDreamcoins: offer.includedDreamcoins, features: offer.features });
});
afterEach(() => vi.restoreAllMocks());
afterAll(cleanup);

async function fixture(suffix: string) {
  const userId = `${P}${suffix}`;
  const checkoutId = `${userId}-checkout`;
  const subscriptionId = `${userId}-subscription`;
  const invoiceId = `${userId}-invoice`;
  await createUser({ id: userId, dataClass: "customer" });
  await prisma.checkoutSession.create({ data: {
    id: checkoutId, userId, planId, provider: "mock", providerSessionId: invoiceId,
    providerInvoiceStatus: "settled", amountCents: offer.priceCents, currency: "usd",
    offerSnapshot: offer, status: "completed",
  } });
  await prisma.subscription.create({ data: {
    id: subscriptionId, userId, planId, provider: "mock", providerSubscriptionId: invoiceId,
    status: "active", currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
  } });
  await prisma.$transaction((tx) => postDreamcoinEntry(tx, {
    kind: "subscription_grant", userId, amount: offer.includedDreamcoins,
    sourceId: subscriptionId, idempotencyKey: `${userId}-grant`,
  }));
  return { userId, checkoutId, subscriptionId, invoiceId };
}

function refund(subscriptionId: string, action: "refund" | "refund_reconcile", key: string) {
  return adminV2Route(action === "refund" ? refundRoute : reconcileRoute, {
    method: "POST", path: `billing/subscriptions/${subscriptionId}/refund${action === "refund" ? "" : "/reconcile"}`,
    params: { id: subscriptionId }, userId: actorId, role: "admin", idempotencyKey: key,
    body: { reason: "Controlled refund race regression.", confirmation: `${subscriptionId}:${action}` },
  });
}

async function finishRefund(suffix: string, state: "completed" | "canceled") {
  const row = await fixture(suffix);
  expectOk(await refund(row.subscriptionId, "refund", `${row.userId}-request`));
  const checkout = await prisma.checkoutSession.findUniqueOrThrow({ where: { id: row.checkoutId } });
  const evidence = parseSubscriptionRefundEvidence(checkout.reconciliationEvidence)!;
  const providerRefund: PaymentRefund = {
    provider: "mock", refundId: evidence.providerRefundId!, reference: evidence.reference,
    claimUrl: `https://mock-payments.idream.local/refunds/${evidence.providerRefundId}`,
    amount: "19.99", currency: "usd", state, payouts: [],
  };
  const lookup = vi.spyOn(providers.payment, "findRefund").mockResolvedValue({ ok: true, data: providerRefund });
  expectOk(await refund(row.subscriptionId, "refund_reconcile", `${row.userId}-finish`));
  return { ...row, providerRefund, lookup };
}

describe("subscription refund ordering", () => {
  it.each(["completed", "canceled"] as const)("preserves %s refund evidence when an older provider response arrives", async (state) => {
    const row = await finishRefund(`stale-${state}`, state);
    const before = await prisma.checkoutSession.findUniqueOrThrow({ where: { id: row.checkoutId } });
    row.lookup.mockResolvedValue({ ok: true, data: { ...row.providerRefund, state: "in_progress" } });
    const result = await refund(row.subscriptionId, "refund_reconcile", `${row.userId}-stale`);
    expectOk(result);
    expect(result.data).toMatchObject({ refund: { state } });
    const after = await prisma.checkoutSession.findUniqueOrThrow({ where: { id: row.checkoutId } });
    expect(after).toMatchObject({ status: before.status, needsReconciliation: false, reconciliationEvidence: before.reconciliationEvidence });
    expect(await prisma.subscription.findUniqueOrThrow({ where: { id: row.subscriptionId } })).toMatchObject({ status: state === "completed" ? "refunded" : "active" });
    expect(await prisma.dreamcoinLedger.count({ where: { userId: row.userId, reason: "subscription_refund_restore" } })).toBe(state === "canceled" ? 1 : 0);
  });

  it("keeps a completed refund authoritative after a later lookup fails", async () => {
    const row = await finishRefund("lookup-failure", "completed");
    const before = await prisma.checkoutSession.findUniqueOrThrow({ where: { id: row.checkoutId } });
    row.lookup.mockResolvedValue({ ok: false, error: { code: "timeout", message: "Controlled late lookup failure", retryable: true } });
    expect((await refund(row.subscriptionId, "refund_reconcile", `${row.userId}-failed`)).status).toBe(503);
    const after = await prisma.checkoutSession.findUniqueOrThrow({ where: { id: row.checkoutId } });
    expect(after).toMatchObject({ status: "refunded", needsReconciliation: false, reconciliationEvidence: before.reconciliationEvidence });
  });

  it.each(["completed", "canceled"] as const)("rejects a contradictory terminal after %s without changing its financial evidence", async (state) => {
    const row = await finishRefund(`contradiction-${state}`, state);
    const before = await prisma.checkoutSession.findUniqueOrThrow({ where: { id: row.checkoutId } });
    row.lookup.mockResolvedValue({ ok: true, data: { ...row.providerRefund, state: state === "completed" ? "canceled" : "completed" } });
    expect((await refund(row.subscriptionId, "refund_reconcile", `${row.userId}-conflict`)).status).toBe(409);
    expect(await prisma.controlPlaneCommand.findFirstOrThrow({ where: { actorId, idempotencyKey: `${row.userId}-conflict` } })).toMatchObject({
      status: "failed", error: { code: "conflict" },
    });
    const after = await prisma.checkoutSession.findUniqueOrThrow({ where: { id: row.checkoutId } });
    expect(after).toMatchObject({ status: before.status, reconciliationEvidence: before.reconciliationEvidence });
    expect(await prisma.dreamcoinLedger.count({ where: { userId: row.userId, reason: "subscription_refund_restore" } })).toBe(state === "canceled" ? 1 : 0);
  });

  it("keeps the first completion timestamp on a repeated completed observation", async () => {
    const row = await finishRefund("completed-replay", "completed");
    const before = await prisma.checkoutSession.findUniqueOrThrow({ where: { id: row.checkoutId } });
    expectOk(await refund(row.subscriptionId, "refund_reconcile", `${row.userId}-replay`));
    const after = await prisma.checkoutSession.findUniqueOrThrow({ where: { id: row.checkoutId } });
    expect(after.reconciliationEvidence).toEqual(before.reconciliationEvidence);
  });

  it("recovers a transient projection rollback through the original command lease without issuing another refund", async () => {
    const row = await fixture("projection-recovery");
    const key = `${row.userId}-request`;
    const createRefund = vi.spyOn(providers.payment, "createRefund");
    const project = refundAuthority.projectSubscriptionRefundInTx;
    vi.spyOn(refundAuthority, "projectSubscriptionRefundInTx").mockImplementationOnce(async (tx, input) => {
      await project(tx, input);
      // The provider already returned success. Roll back the real local
      // projection transaction as PostgreSQL can do on a serialization failure.
      throw new Prisma.PrismaClientKnownRequestError("Injected projection serialization failure", {
        code: "P2034", clientVersion: Prisma.prismaVersion.client,
      });
    });
    expect((await refund(row.subscriptionId, "refund", key)).status).toBe(500);
    const command = await prisma.controlPlaneCommand.findFirstOrThrow({ where: { actorId, idempotencyKey: key } });
    expect(command).toMatchObject({ status: "running", attemptCount: 1 });
    expect(command.leaseExpiresAt).not.toBeNull();
    expect(await prisma.checkoutSession.findUniqueOrThrow({ where: { id: row.checkoutId } })).toMatchObject({
      status: "refund_pending", needsReconciliation: true,
      reconciliationEvidence: { refund: { state: "provider_dispatching" } },
    });
    expect(await reconcileExpiredCommandLeases(prisma, new Date(command.leaseExpiresAt!.getTime() + 1), { commandIds: [command.id] })).toEqual({
      examined: 1, requeued: 1, failed: 0,
    });
    const recovered = await refund(row.subscriptionId, "refund", key);
    expectOk(recovered);
    expect(recovered.data).toMatchObject({ refund: { state: "claimable" }, subscriptionStatus: "refund_pending" });
    expect(await prisma.controlPlaneCommand.findUniqueOrThrow({ where: { id: command.id } })).toMatchObject({
      status: "succeeded", attemptCount: 2, needsReconciliation: true,
    });
    expect(createRefund).toHaveBeenCalledOnce();
    expect(await prisma.dreamcoinLedger.count({ where: { userId: row.userId, reason: "subscription_refund" } })).toBe(1);
  });

  it("serializes refund admission after a competing activation without a database deadlock", async () => {
    const row = await fixture("activation-race");
    const nextCheckout = await prisma.checkoutSession.create({ data: {
      id: `${row.checkoutId}-new`, userId: row.userId, planId, provider: "mock",
      providerSessionId: `${row.invoiceId}-new`, providerInvoiceStatus: "settled",
      amountCents: offer.priceCents, currency: "usd", offerSnapshot: offer, status: "provider_settled",
    } });
    const started = Promise.withResolvers<number>();
    const proceed = Promise.withResolvers<void>();
    const activation = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "checkout_sessions" WHERE id = ${nextCheckout.id} FOR UPDATE`;
      await lockUserLedger(tx, row.userId);
      const [connection] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      started.resolve(connection!.pid);
      await proceed.promise;
      return activateSubscriptionInTx(tx, row.userId, planId, `${row.invoiceId}-new`, "mock", offer, {
        checkoutId: nextCheckout.id, createdAt: nextCheckout.createdAt,
      });
    }, { timeout: 15_000 });
    const activationPid = await started.promise;
    const requested = refund(row.subscriptionId, "refund", `${row.userId}-request`);
    try {
      // Observe the real database wait before letting activation touch the
      // existing subscription. The refund must not hold that row while it
      // waits for the same user's ledger lock.
      await vi.waitFor(async () => {
        const blocked = await prisma.$queryRaw<{ pid: number }[]>`
          SELECT pid FROM pg_stat_activity WHERE ${activationPid} = ANY(pg_blocking_pids(pid))`;
        expect(blocked.length).toBeGreaterThan(0);
      }, { timeout: 3_000, interval: 20 });
    } finally {
      proceed.resolve();
      await Promise.allSettled([activation, requested]);
    }
    const [activated, response] = await Promise.all([activation, requested]);
    expect(activated).toMatchObject({ created: true, reconciliationRequired: false });
    expect(response.status).toBe(409);
    expect(await prisma.dreamcoinLedger.count({ where: { userId: row.userId, reason: "subscription_refund" } })).toBe(0);
  });
});
