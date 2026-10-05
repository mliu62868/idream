import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { POST as activityRoute } from "@/app/api/v2/admin/collaboration/[targetType]/[targetId]/activity/route";
import { GET as supportRoute } from "@/app/api/v2/admin/support/requests/route";
import { GET as caseRoute } from "@/app/api/v2/admin/cases/[id]/route";
import { adminCaseActiveKey, ensureSupportCaseForRequest } from "@/server/modules/admin-v2/cases/service";

describe("Case handoff uses assignment authority", () => {
  const suffix = randomUUID();
  const actorId = `case-handoff-admin-${suffix}`;
  const supportId = `case-handoff-support-${suffix}`;
  const revokedId = `case-handoff-revoked-${suffix}`;
  const customerId = `case-handoff-customer-${suffix}`;
  const caseIds: string[] = [];
  const requestIds: string[] = [];
  const headers = { "content-type": "application/json", "x-idream-user-id": actorId, "x-idream-role": "admin" };
  beforeAll(async () => {
    await prisma.user.createMany({ data: [
      { id: actorId, email: `${actorId}@example.test`, role: "admin", dataClass: "internal" },
      { id: supportId, email: `${supportId}@example.test`, role: "support", dataClass: "internal" },
      { id: revokedId, email: `${revokedId}@example.test`, role: "support", dataClass: "internal" },
      { id: customerId, email: `${customerId}@example.test`, role: "user", dataClass: "customer" },
    ] });
    await prisma.adminUserPermission.create({ data: { userId: revokedId, permissionKey: "case.read", effect: "revoke", createdById: actorId, reason: "No Case access for this recipient" } });
  });
  afterAll(async () => {
    await prisma.adminCollaborationActivity.deleteMany({ where: { targetId: { in: caseIds } } });
    await prisma.adminAuditLog.deleteMany({ where: { targetId: { in: caseIds } } });
    await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: { in: caseIds } } });
    await prisma.caseEvidence.deleteMany({ where: { caseId: { in: caseIds } } });
    await prisma.adminCase.deleteMany({ where: { id: { in: caseIds } } });
    await prisma.supportRequest.deleteMany({ where: { id: { in: requestIds } } });
    await prisma.adminUserPermission.deleteMany({ where: { userId: revokedId } });
    await prisma.user.deleteMany({ where: { id: { in: [actorId, supportId, revokedId, customerId] } } });
  });
  async function intake(status = "received") {
    return prisma.$transaction(async tx => {
      const ticket = await tx.supportRequest.create({ data: { ticketId: `handoff-${randomUUID()}`, userId: customerId, category: "bug", subject: "Controlled handoff", description: "Internal assignment test", diagnosticConsent: false, status, assignedToId: actorId, ...(status === "resolved" || status === "closed" ? { resolvedAt: new Date(), resolutionNotes: "Controlled completed intake" } : {}) } });
      const adminCase = await ensureSupportCaseForRequest(tx, ticket);
      if (!adminCase) throw new Error("Canonical intake did not create a Case");
      requestIds.push(ticket.id); caseIds.push(adminCase.id);
      return { ticket, adminCase };
    });
  }
  function handoff(caseId: string, version: number, ownerId: string, key = randomUUID()) {
    return activityRoute(new Request(`http://localhost/api/v2/admin/collaboration/case/${caseId}/activity`, { method: "POST", headers: { ...headers, "idempotency-key": key }, body: JSON.stringify({ kind: "handoff", expectedVersion: version, body: "Transfer internal investigation with current context", metadata: { handoffToActorId: ownerId } }) }), { params: Promise.resolve({ targetType: "case", targetId: caseId }) });
  }
  async function assertUntouched(caseId: string, before: Awaited<ReturnType<typeof prisma.adminCase.findUniqueOrThrow>>, assignedToId = actorId) {
    expect(await prisma.adminCase.findUniqueOrThrow({ where: { id: caseId } })).toEqual(before);
    const evidence = await prisma.caseEvidence.findFirst({ where: { caseId, sourceType: "support_request" } });
    if (evidence) expect(await prisma.supportRequest.findUniqueOrThrow({ where: { id: evidence.sourceId } })).toMatchObject({ assignedToId });
    expect(await prisma.adminCollaborationActivity.count({ where: { targetId: caseId } })).toBe(0);
    expect(await prisma.adminAuditLog.count({ where: { targetId: caseId, action: { in: ["case.assigned", "collaboration.handoff"] } } })).toBe(0);
    expect(await prisma.mainOutboxEvent.count({ where: { aggregateId: caseId } })).toBe(0);
  }

  it("moves the linked Help Desk owner with the Case and records one atomic handoff on replay", async () => {
    const { ticket, adminCase } = await intake();
    const key = randomUUID();
    const responses = await Promise.all([handoff(adminCase.id, 1, supportId, key), handoff(adminCase.id, 1, supportId, key)]);
    expect(responses.map(row => row.status).sort()).toEqual([200, 201]);
    for (const response of responses) expect((await response.json()).data).toMatchObject({ authority: { ownerId: supportId, version: 2 } });
    const support = await supportRoute(new Request(`http://localhost/api/v2/admin/support/requests?ticketId=${ticket.ticketId}`, { headers }));
    expect(support.status).toBe(200);
    expect((await support.json()).data.items).toEqual([expect.objectContaining({ assignedToId: supportId })]);
    const detail = await caseRoute(new Request(`http://localhost/api/v2/admin/cases/${adminCase.id}`, { headers }), { params: Promise.resolve({ id: adminCase.id }) });
    expect(detail.status).toBe(200);
    expect((await detail.json()).data.case).toMatchObject({ ownerId: supportId, status: "triaged", version: 2 });
    expect(await prisma.adminCollaborationActivity.count({ where: { targetId: adminCase.id, kind: "handoff" } })).toBe(1);
    expect(await prisma.adminAuditLog.count({ where: { targetId: adminCase.id, action: "case.assigned" } })).toBe(1);
    expect(await prisma.adminAuditLog.count({ where: { targetId: adminCase.id, action: "collaboration.handoff" } })).toBe(1);
    expect((await handoff(adminCase.id, 1, actorId)).status).toBe(409);
  });

  it.each(["customer", "revoked"] as const)("rejects an active %s recipient without leaking assignment or collaboration", async kind => {
    const { adminCase } = await intake();
    const response = await handoff(adminCase.id, 1, kind === "customer" ? customerId : revokedId);
    expect(response.status).toBe(400);
    await assertUntouched(adminCase.id, adminCase);
  });

  it("rejects handing a restricted moderation Case to a support-only recipient", async () => {
    const caseKey = randomUUID();
    const adminCase = await prisma.adminCase.create({ data: { type: "content_report", targetType: "user", targetId: customerId, caseKey, activeKey: adminCaseActiveKey("content_report", "user", customerId, caseKey), ownerId: actorId } });
    caseIds.push(adminCase.id);
    expect((await handoff(adminCase.id, 1, supportId)).status).toBe(400);
    await assertUntouched(adminCase.id, adminCase);
  });

  it.each(["resolved", "closed"] as const)("rejects %s owner changes but keeps internal comments available", async status => {
    const { adminCase } = await intake(status);
    expect((await handoff(adminCase.id, 1, supportId)).status).toBe(409);
    await assertUntouched(adminCase.id, adminCase);
    const comment = await activityRoute(new Request(`http://localhost/api/v2/admin/collaboration/case/${adminCase.id}/activity`, { method: "POST", headers: { ...headers, "idempotency-key": randomUUID() }, body: JSON.stringify({ kind: "comment", body: "Internal historical follow-up note" }) }), { params: Promise.resolve({ targetType: "case", targetId: adminCase.id }) });
    expect(comment.status).toBe(201);
    expect(await prisma.adminCase.findUniqueOrThrow({ where: { id: adminCase.id } })).toEqual(adminCase);
  });
});
