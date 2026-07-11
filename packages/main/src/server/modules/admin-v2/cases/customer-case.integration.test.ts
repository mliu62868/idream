import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import {
  backfillCustomerCases,
  recordCustomerCaseAction,
} from "./service";
import { getCustomer360 } from "./customer-query";
import { listCases } from "./query";

describe("Support and billing Case depth", () => {
  const suffix = randomUUID();
  const actorId = `support-actor-${suffix}`;
  const customerId = `support-customer-${suffix}`;
  const supportRequestId = `support-request-${suffix}`;
  const billingRequestId = `billing-request-${suffix}`;
  const planId = `support-plan-${suffix}`;
  const subscriptionId = `support-subscription-${suffix}`;
  const ledgerId = `support-ledger-${suffix}`;
  const headers = {
    "x-idream-user-id": actorId,
    "x-idream-role": "support",
  };

  beforeAll(async () => {
    await prisma.user.createMany({
      data: [
        { id: actorId, email: `${actorId}@example.test`, role: "support", status: "active" },
        { id: customerId, email: `${customerId}@example.test`, role: "user", status: "active", displayName: "Case Customer" },
      ],
    });
    await prisma.plan.create({
      data: {
        id: planId,
        slug: `case-${suffix}`,
        name: "Case Plan",
        billingPeriod: "monthly",
        priceCents: 1999,
        includedDreamcoins: 500,
        features: {},
      },
    });
    await prisma.subscription.create({
      data: {
        id: subscriptionId,
        userId: customerId,
        planId,
        provider: "mock",
        status: "active",
      },
    });
    await prisma.dreamcoinLedger.create({
      data: {
        id: ledgerId,
        userId: customerId,
        delta: 500,
        balanceAfter: 500,
        reason: "subscription_grant",
        idempotencyKey: `case-ledger-${suffix}`,
      },
    });
    await prisma.supportRequest.createMany({
      data: [
        {
          id: supportRequestId,
          ticketId: `SUP-${suffix}`,
          userId: customerId,
          category: "technical",
          subject: "Image is unavailable",
          description: "The delivered image cannot be opened.",
          status: "open",
          priority: 2,
        },
        {
          id: billingRequestId,
          ticketId: `BILL-${suffix}`,
          userId: customerId,
          category: "billing_dispute",
          subject: "Duplicate charge",
          description: "The same subscription charge appears twice.",
          status: "received",
          priority: 1,
        },
      ],
    });
  });

  afterAll(async () => {
    const cases = await prisma.adminCase.findMany({
      where: { targetType: "user", targetId: customerId },
      select: { id: true },
    });
    const caseIds = cases.map((item) => item.id);
    await prisma.adminAuditLog.deleteMany({ where: { targetId: { in: [...caseIds, customerId] } } });
    await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: { in: caseIds } } });
    await prisma.decisionRecord.deleteMany({ where: { sourceType: "admin_case", sourceId: { in: caseIds } } });
    await prisma.caseEvidence.deleteMany({ where: { caseId: { in: caseIds } } });
    await prisma.adminCase.deleteMany({ where: { id: { in: caseIds } } });
    await prisma.supportRequest.deleteMany({ where: { id: { in: [supportRequestId, billingRequestId] } } });
    await prisma.dreamcoinLedger.deleteMany({ where: { id: ledgerId } });
    await prisma.subscription.deleteMany({ where: { id: subscriptionId } });
    await prisma.plan.deleteMany({ where: { id: planId } });
    await prisma.adminUserPermission.deleteMany({ where: { userId: actorId } });
    await prisma.user.deleteMany({ where: { id: { in: [actorId, customerId] } } });
    await prisma.$disconnect();
  });

  it("dry-runs and then idempotently backfills typed Support/Billing Cases with immutable related evidence", async () => {
    const actor = { id: actorId, role: "support" };
    const dryRun = await backfillCustomerCases({ dryRun: true, batchSize: 20, actor });
    expect(dryRun).toMatchObject({ scanned: 2, eligible: 2, applied: 0, mismatches: [] });
    expect(await prisma.adminCase.count({ where: { targetId: customerId } })).toBe(0);

    const first = await backfillCustomerCases({ dryRun: false, batchSize: 1, actor });
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await backfillCustomerCases({
      dryRun: false,
      batchSize: 1,
      cursor: first.nextCursor ?? undefined,
      actor,
    });
    expect(second.nextCursor).toBeNull();

    const cases = await prisma.adminCase.findMany({
      where: { targetType: "user", targetId: customerId },
      orderBy: { type: "asc" },
    });
    expect(cases.map((item) => item.type).sort()).toEqual(["billing_dispute", "support_request"]);
    expect(cases.every((item) => item.activeKey && item.slaDueAt)).toBe(true);

    const billing = cases.find((item) => item.type === "billing_dispute");
    expect(billing).toBeTruthy();
    const evidence = await prisma.caseEvidence.findMany({ where: { caseId: billing!.id } });
    expect(evidence.map((item) => item.sourceType).sort()).toEqual([
      "dreamcoin_ledger",
      "subscription_snapshot",
      "support_request",
    ]);

    await backfillCustomerCases({ dryRun: false, batchSize: 20, actor });
    expect(await prisma.adminCase.count({ where: { targetId: customerId } })).toBe(2);
    expect(await prisma.caseEvidence.count({ where: { caseId: billing!.id } })).toBe(3);
  });

  it("records subtype-scoped action evidence on the existing Case authority", async () => {
    const supportCase = await prisma.adminCase.findFirstOrThrow({
      where: { targetId: customerId, type: "support_request" },
    });
    const evidence = await prisma.caseEvidence.findFirstOrThrow({ where: { caseId: supportCase.id } });
    const updated = await recordCustomerCaseAction({
      caseId: supportCase.id,
      actor: { id: actorId, role: "support" },
      expectedVersion: supportCase.version,
      action: "diagnostic_reviewed",
      summary: "Confirmed the delivery URL is no longer available.",
      evidenceRefs: [evidence.id],
      outcomeRef: `diagnostic:${supportRequestId}`,
      requestId: `case-action-${suffix}`,
    });
    expect(updated).toMatchObject({ status: "in_progress", verificationState: "pending" });
    expect(updated.version).toBe(supportCase.version + 1);
    expect(await prisma.decisionRecord.count({ where: { sourceType: "admin_case", sourceId: supportCase.id } })).toBe(1);

    await expect(
      recordCustomerCaseAction({
        caseId: supportCase.id,
        actor: { id: actorId, role: "support" },
        expectedVersion: updated.version,
        action: "ledger_reconciled",
        summary: "Wrong subtype action.",
        evidenceRefs: [evidence.id],
        outcomeRef: "ledger:none",
        requestId: `bad-case-action-${suffix}`,
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
  });

  it("executes search/filter/cursor on the server and echoes restorable URL state", async () => {
    const firstResponse = await listCases(new Request(
      "http://localhost/api/v2/admin/cases?view=all&type=billing_dispute&search=duplicate&sort=updated_desc&limit=1",
      { headers },
    ));
    const first = await firstResponse.json();
    expect(first.data.items).toHaveLength(1);
    expect(first.data.query).toMatchObject({
      view: "all",
      type: "billing_dispute",
      search: "duplicate",
      sort: "updated_desc",
      limit: 1,
    });
    expect(first.data.items[0].type).toBe("billing_dispute");
  });

  it("returns a permission-gated authoritative Customer 360 read model", async () => {
    const response = await getCustomer360(new Request(
      `http://localhost/api/v2/admin/customers/${customerId}`,
      { headers },
    ), customerId);
    const body = await response.json();
    expect(body.data).toMatchObject({
      customer: { id: customerId, displayName: "Case Customer", status: "active" },
      overview: { balanceDreamcoins: 500, activeCaseCount: 2 },
      subscription: { id: subscriptionId, status: "active", plan: { id: planId } },
    });
    expect(body.data.cases.map((item: { type: string }) => item.type).sort()).toEqual([
      "billing_dispute",
      "support_request",
    ]);

    await prisma.adminUserPermission.create({
      data: {
        userId: actorId,
        permissionKey: "customer.read",
        effect: "revoke",
        reason: "permission negative test",
        createdById: actorId,
      },
    });
    await expect(getCustomer360(new Request(
      `http://localhost/api/v2/admin/customers/${customerId}`,
      { headers },
    ), customerId)).rejects.toMatchObject({ code: "forbidden" });
  });
});
