import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { backfillCustomerCases } from "@/server/modules/admin-v2/backfill/production-runner";
import {
  adminCaseActiveKey,
  recordReviewCaseDecisionAtomic,
  reopenOrRecurCase,
  recordCustomerCaseAction,
  verifyReviewCase,
  waitCase,
} from "./service";
import { getCustomer360, listCustomers } from "./customer-query";
import { getCaseDetail, listCases } from "./query";

describe("Support and billing Case depth", () => {
  const suffix = randomUUID();
  const actorId = `support-actor-${suffix}`;
  const customerId = `support-customer-${suffix}`;
  const fixtureCustomerId = `support-fixture-customer-${suffix}`;
  const supportRequestId = `support-request-${suffix}`;
  const billingRequestId = `billing-request-${suffix}`;
  const planId = `support-plan-${suffix}`;
  const subscriptionId = `support-subscription-${suffix}`;
  const ledgerId = `support-ledger-${suffix}`;
  const incidentId = `support-incident-${suffix}`;
  const headers = {
    "x-idream-user-id": actorId,
    "x-idream-role": "support",
  };

  beforeAll(async () => {
    await prisma.user.createMany({
      data: [
        { id: actorId, email: `${actorId}@idream.internal`, role: "support", status: "active", dataClass: "internal" },
        { id: customerId, email: `${customerId}@customer.invalid`, role: "user", status: "active", dataClass: "customer", displayName: "Case Customer" },
        { id: fixtureCustomerId, email: `${fixtureCustomerId}@example.test`, role: "user", status: "active", dataClass: "fixture", displayName: "Case Customer Fixture" },
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
    const backfillItems = await prisma.adminBackfillItem.findMany({
      where: { entityType: "support_request", entityId: { in: [supportRequestId, billingRequestId] } },
      select: { runId: true },
    });
    const backfillRunIds = [...new Set(backfillItems.map((item) => item.runId))];
    await prisma.adminBackfillItem.deleteMany({ where: { runId: { in: backfillRunIds } } });
    await prisma.adminBackfillRun.deleteMany({ where: { id: { in: backfillRunIds } } });
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
    await prisma.opsIncident.deleteMany({ where: { id: incidentId } });
    await prisma.supportRequest.deleteMany({ where: { id: { in: [supportRequestId, billingRequestId] } } });
    await prisma.dreamcoinLedger.deleteMany({ where: { id: ledgerId } });
    await prisma.subscription.deleteMany({ where: { id: subscriptionId } });
    await prisma.plan.deleteMany({ where: { id: planId } });
    await prisma.adminUserPermission.deleteMany({ where: { userId: actorId } });
    await prisma.user.deleteMany({ where: { id: { in: [actorId, customerId, fixtureCustomerId] } } });
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
    expect(updated.resolution).toMatchObject({
      summary: "Confirmed the delivery URL is no longer available.",
      decision: "diagnostic_reviewed",
      verification: { state: "pending" },
    });
    expect(updated.version).toBe(supportCase.version + 1);
    expect(await prisma.decisionRecord.count({ where: { sourceType: "admin_case", sourceId: supportCase.id } })).toBe(1);
    await expect(verifyReviewCase({
      caseId: supportCase.id,
      actor: { id: actorId, role: "support" },
      expectedVersion: updated.version,
      state: "passed",
      evidenceRefs: [evidence.id],
      requestId: `case-unproven-verification-${suffix}`,
    })).rejects.toMatchObject({ code: "conflict" });
    await expect(recordReviewCaseDecisionAtomic({
      caseId: supportCase.id,
      actor: { id: actorId, role: "support" },
      expectedVersion: updated.version,
      decision: "actioned",
      summary: "Attempt to bypass typed Support actions.",
      evidenceRefs: [evidence.id],
      requestId: `case-generic-decision-${suffix}`,
    })).rejects.toMatchObject({ code: "bad_request" });
    const waiting = await waitCase({
      caseId: supportCase.id,
      actor: { id: actorId, role: "support" },
      expectedVersion: updated.version,
      reason: "Waiting for customer delivery diagnostics",
      resumeAt: new Date(Date.now() + 60_000),
      requestId: `case-wait-${suffix}`,
    });
    expect(waiting).toMatchObject({ status: "waiting", version: updated.version + 1 });

    await prisma.opsIncident.create({ data: { id: incidentId, signature: `support-signature-${suffix}`, signatureVersion: "generation-error-v1", status: "triaged", severity: "medium", firstSeen: new Date(), lastSeen: new Date(), impact: {}, mitigation: {} } });
    const escalated = await recordCustomerCaseAction({
      caseId: supportCase.id,
      actor: { id: actorId, role: "support" },
      expectedVersion: waiting.version,
      action: "incident_escalated",
      summary: "Escalated the shared generation failure signature.",
      evidenceRefs: [evidence.id],
      outcomeRef: incidentId,
      requestId: `case-incident-${suffix}`,
    });
    const detailResponse = await getCaseDetail(new Request(`http://localhost/api/v2/admin/cases/${supportCase.id}`, { headers }), supportCase.id);
    expect((await detailResponse.json()).data.case.relatedIncidentIds).toEqual([incidentId]);
    const verified = await verifyReviewCase({
      caseId: supportCase.id,
      actor: { id: actorId, role: "support" },
      expectedVersion: escalated.version,
      state: "passed",
      evidenceRefs: [evidence.id],
      requestId: `case-authority-verification-${suffix}`,
    });
    expect(verified).toMatchObject({ status: "resolved", verificationState: "passed", activeKey: null });
    const verificationDecision = await prisma.decisionRecord.findFirstOrThrow({
      where: { sourceType: "admin_case", sourceId: supportCase.id, decision: "verification_passed" },
      orderBy: { createdAt: "desc" },
    });
    expect(verificationDecision.outcome).toMatchObject({
      verificationState: "passed",
      authorityEvidence: `incident:${incidentId}:triaged`,
    });
    await expect(prisma.mainOutboxEvent.count({
      where: { aggregateId: supportCase.id, eventType: "admin.case.verification.recorded.v2" },
    })).resolves.toBe(1);

    await expect(
      recordCustomerCaseAction({
        caseId: supportCase.id,
        actor: { id: actorId, role: "support" },
        expectedVersion: verified.version,
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

  it("lists Customer operational summaries with server-side search and cursor state", async () => {
    const response = await listCustomers(new Request(
      `http://localhost/api/v2/admin/customers?search=${encodeURIComponent("Case Customer")}&status=active&limit=1`,
      { headers },
    ));
    const body = await response.json();
    expect(body.data).toMatchObject({
      items: [expect.objectContaining({
        id: customerId,
        displayName: "Case Customer",
        balanceDreamcoins: 500,
        activeCaseCount: 1,
        subscriptionStatus: "active",
      })],
      pageInfo: { hasNextPage: false, endCursor: null },
      query: { search: "Case Customer", status: "active", limit: 1, cursor: null },
      freshness: "fresh",
    });
  });

  it("keeps fixture users out of Customer list and Customer 360", async () => {
    const response = await listCustomers(new Request(
      `http://localhost/api/v2/admin/customers?search=${encodeURIComponent(fixtureCustomerId)}&status=active&limit=20`,
      { headers },
    ));
    const body = await response.json();
    expect(body.data.items).toEqual([]);
    await expect(getCustomer360(new Request(
      `http://localhost/api/v2/admin/customers/${fixtureCustomerId}`,
      { headers },
    ), fixtureCustomerId)).rejects.toMatchObject({ code: "not_found" });
  });

  it("returns a permission-gated authoritative Customer 360 read model", async () => {
    await prisma.adminCase.create({
      data: {
        id: `restricted-review-case-${suffix}`,
        type: "content_report",
        targetType: "user",
        targetId: customerId,
        caseKey: `restricted-review-${suffix}`,
        activeKey: adminCaseActiveKey(
          "content_report",
          "user",
          customerId,
          `restricted-review-${suffix}`,
        ),
        status: "new",
        priority: "high",
        slaDueAt: new Date(Date.now() + 60_000),
        resolution: { severity: "high" },
      },
    });
    const response = await getCustomer360(new Request(
      `http://localhost/api/v2/admin/customers/${customerId}`,
      { headers },
    ), customerId);
    const body = await response.json();
    expect(body.data).toMatchObject({
      customer: { id: customerId, displayName: "Case Customer", status: "active" },
      overview: { balanceDreamcoins: 500, activeCaseCount: 1 },
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

  it("creates a linked recurrence when a terminal Case is outside its reopen window", async () => {
    const prior = await prisma.adminCase.create({ data: {
      id: `old-terminal-case-${suffix}`,
      type: "support_request",
      targetType: "user",
      targetId: customerId,
      caseKey: `old-terminal-${suffix}`,
      activeKey: null,
      status: "resolved",
      priority: "normal",
      updatedAt: new Date(Date.now() - 60_000),
    } });
    const result = await reopenOrRecurCase({
      caseId: prior.id,
      actor: { id: actorId, role: "support" },
      expectedVersion: prior.version,
      reason: "Same issue recurred outside the configured reopen window",
      requestId: `case-recurrence-${suffix}`,
      reopenWindowMs: 1,
    });
    expect(result.mode).toBe("recurrence");
    expect(result.adminCase).toMatchObject({ status: "new", caseKey: prior.caseKey });
    await expect(prisma.adminCase.findUnique({ where: { id: prior.id } })).resolves.toMatchObject({
      activeKey: null,
      version: 1,
    });
    await expect(prisma.caseEvidence.findFirst({
      where: { caseId: result.adminCase.id, sourceType: "case_recurrence", sourceId: prior.id },
    })).resolves.toBeTruthy();
  });

  it("requires a resolved review Case to reopen before accepting another decision", async () => {
    const caseId = `resolved-review-case-${suffix}`;
    const evidenceId = `resolved-review-evidence-${suffix}`;
    const reviewCase = await prisma.adminCase.create({
      data: {
        id: caseId,
        type: "content_report",
        targetType: "user",
        targetId: customerId,
        caseKey: `resolved-review-${suffix}`,
        activeKey: `content_report:user:${customerId}:resolved-review-${suffix}`,
        status: "in_progress",
      },
    });
    await prisma.caseEvidence.create({
      data: {
        id: evidenceId,
        caseId,
        sourceType: "content_report",
        sourceId: `report-${suffix}`,
        snapshot: { finding: "fixture" },
        occurredAt: new Date(),
      },
    });
    const resolved = await recordReviewCaseDecisionAtomic({
      caseId,
      actor: { id: actorId, role: "admin" },
      expectedVersion: reviewCase.version,
      decision: "actioned",
      summary: "Resolve after downstream verification.",
      evidenceRefs: [evidenceId],
      downstreamVerified: true,
      requestId: `resolve-review-${suffix}`,
    });
    expect(resolved).toMatchObject({ status: "resolved", activeKey: null });

    await expect(recordReviewCaseDecisionAtomic({
      caseId,
      actor: { id: actorId, role: "admin" },
      expectedVersion: resolved.version,
      decision: "actioned",
      summary: "Attempt a new decision without reopening.",
      evidenceRefs: [evidenceId],
      downstreamVerified: false,
      requestId: `repeat-review-${suffix}`,
    })).rejects.toMatchObject({ code: "conflict" });

    const reentered = await verifyReviewCase({
      caseId,
      actor: { id: actorId, role: "admin" },
      expectedVersion: resolved.version,
      state: "failed",
      evidenceRefs: [evidenceId],
      requestId: `failed-reverification-${suffix}`,
    });
    expect(reentered).toMatchObject({
      status: "in_progress",
      activeKey: `content_report:user:${customerId}:resolved-review-${suffix}`,
    });
  });
});
