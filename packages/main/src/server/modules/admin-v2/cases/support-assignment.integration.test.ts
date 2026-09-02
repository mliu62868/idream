import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { adminV2 } from "@/server/test/admin-v2-http";
import { api, createUser, expectError, expectOk, purgeTestData } from "@/server/test/helpers";

const P = "zt-case-support-assignment-";
const CUSTOMER = `${P}customer`;
const ADMIN = `${P}admin`;
const OWNER = `${P}owner`;

beforeAll(async () => {
  await purgeTestData(P);
  await createUser({ id: CUSTOMER, dataClass: "customer" });
  await createUser({ id: ADMIN, role: "admin", dataClass: "internal" });
  await createUser({ id: OWNER, role: "support", dataClass: "internal" });
});
afterAll(() => purgeTestData(P));

async function fileRequest(category = "bug") {
  const filed = await api("POST", "support/requests", {
    userId: CUSTOMER, ageGate: true,
    body: { category, subject: "Cannot save my image", description: "The generated image cannot be saved after refresh." },
  });
  expectOk(filed, 201);
  const request = await prisma.supportRequest.findUniqueOrThrow({ where: { ticketId: filed.data.request.ticketId } });
  const evidence = await prisma.caseEvidence.findFirstOrThrow({ where: { sourceType: "support_request", sourceId: request.id } });
  const adminCase = await prisma.adminCase.findUniqueOrThrow({ where: { id: evidence.caseId } });
  return { request, adminCase };
}

async function expectAssignment(caseId: string, requestId: string, ownerId: string | null, casePriority: string, supportPriority: number) {
  await expect(prisma.adminCase.findUniqueOrThrow({ where: { id: caseId } })).resolves.toMatchObject({ ownerId, priority: casePriority });
  await expect(prisma.supportRequest.findUniqueOrThrow({ where: { id: requestId } })).resolves.toMatchObject({ assignedToId: ownerId, priority: supportPriority });
}

describe("Case and Support assignment authority", () => {
  it("keeps the assigned operator and priority visible through waiting, customer reply and resolution", async () => {
    const { request, adminCase } = await fileRequest();
    expectOk(await adminV2("POST", `cases/${adminCase.id}/assignment`, {
      userId: ADMIN, role: "admin",
      body: { entityVersion: adminCase.version, ownerId: OWNER, priority: "high", reason: "Investigate failed image download" },
    }));
    await expectAssignment(adminCase.id, request.id, OWNER, "high", 2);
    const detail = await adminV2("GET", "support/requests", { userId: ADMIN, role: "admin", query: { ticketId: request.ticketId } });
    expectOk(detail);
    expect(detail.data.items).toEqual([expect.objectContaining({ assignedToId: OWNER, assignedToEmail: `${OWNER}@idream.internal`, priority: 2 })]);

    expectOk(await adminV2("PATCH", `support/requests/${request.ticketId}`, {
      userId: ADMIN, role: "admin",
      body: { status: "waiting_on_user", customerMessage: "Which image failed to save?", reason: "Need reproduction details", confirmation: request.ticketId },
    }));
    await expectAssignment(adminCase.id, request.id, OWNER, "high", 2);
    expectOk(await api("POST", `support/requests/${request.ticketId}/messages`, {
      userId: CUSTOMER, body: { messageId: crypto.randomUUID(), body: "The newest image in my gallery." },
    }), 201);
    await expectAssignment(adminCase.id, request.id, OWNER, "high", 2);
    await expect(prisma.adminCase.findUniqueOrThrow({ where: { id: adminCase.id } })).resolves.toMatchObject({ status: "in_progress" });
    expectOk(await adminV2("PATCH", `support/requests/${request.ticketId}`, {
      userId: ADMIN, role: "admin",
      body: { status: "resolved", customerMessage: "Your download is ready.", reason: "Verified image delivery", confirmation: request.ticketId },
    }));
    await expectAssignment(adminCase.id, request.id, OWNER, "high", 2);
  });

  it("maps all Case priorities for linked billing tickets and preserves explicit unassignment on replay", async () => {
    const { request, adminCase } = await fileRequest("billing");
    expect(adminCase.type).toBe("billing_dispute");
    for (const [index, priority] of ["urgent", "high", "normal", "low"].entries()) {
      const current = await prisma.adminCase.findUniqueOrThrow({ where: { id: adminCase.id } });
      expectOk(await adminV2("POST", `cases/${adminCase.id}/assignment`, {
        userId: ADMIN, role: "admin",
        body: { entityVersion: current.version, ownerId: OWNER, priority, reason: "Set queue priority" },
      }));
      await expectAssignment(adminCase.id, request.id, OWNER, priority, index + 1);
    }
    const current = await prisma.adminCase.findUniqueOrThrow({ where: { id: adminCase.id } });
    const command = {
      userId: ADMIN, role: "admin", idempotencyKey: crypto.randomUUID(),
      body: { entityVersion: current.version, ownerId: null, reason: "Return to unassigned queue" },
    };
    const first = await adminV2("POST", `cases/${adminCase.id}/assignment`, command);
    expectOk(first);
    const afterFirst = await prisma.supportRequest.findUniqueOrThrow({ where: { id: request.id } });
    const replay = await adminV2("POST", `cases/${adminCase.id}/assignment`, command);
    expectOk(replay);
    expect(replay.data).toEqual(first.data);
    await expectAssignment(adminCase.id, request.id, null, "low", 4);
    await expect(prisma.supportRequest.findUniqueOrThrow({ where: { id: request.id } })).resolves.toMatchObject({ updatedAt: afterFirst.updatedAt });
    expectError(await adminV2("POST", `cases/${adminCase.id}/assignment`, { ...command, body: { ...command.body, priority: "high" } }), 409, "conflict");
    expectOk(await adminV2("PATCH", `support/requests/${request.ticketId}`, {
      userId: ADMIN, role: "admin", body: { status: "open", reason: "Continue triage", confirmation: request.ticketId },
    }));
    await expectAssignment(adminCase.id, request.id, null, "low", 4);
  });

  it("commits only one concurrent assignment and never leaks the losing owner's ticket update", async () => {
    const { request, adminCase } = await fileRequest();
    const results = await Promise.all([
      { ownerId: ADMIN, priority: "urgent" },
      { ownerId: OWNER, priority: "low" },
    ].map((assignment) => adminV2("POST", `cases/${adminCase.id}/assignment`, {
      userId: ADMIN, role: "admin",
      body: { entityVersion: adminCase.version, ...assignment, reason: "Claim next request" },
    })));
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const winner = await prisma.adminCase.findUniqueOrThrow({ where: { id: adminCase.id } });
    expect(winner.version).toBe(adminCase.version + 1);
    await expectAssignment(adminCase.id, request.id, winner.ownerId, winner.priority, winner.priority === "urgent" ? 1 : 4);
    await expect(prisma.adminAuditLog.count({ where: { targetId: adminCase.id, action: "case.assigned" } })).resolves.toBe(1);
    await expect(prisma.mainOutboxEvent.count({ where: { aggregateId: adminCase.id, eventType: "admin.case.assigned.v2" } })).resolves.toBe(1);
  });

  it("rolls the ticket update back with the Case, audit and outbox when the command receipt fails", async () => {
    const { request, adminCase } = await fileRequest();
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION fail_support_assignment_receipt() RETURNS trigger AS $$
      BEGIN
        IF NEW."commandType" = 'case.assignment' AND NEW."targetId" = '${adminCase.id}' THEN
          RAISE EXCEPTION 'injected support assignment receipt failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_support_assignment_receipt_trigger BEFORE INSERT ON "control_plane_commands"
      FOR EACH ROW EXECUTE FUNCTION fail_support_assignment_receipt();
    `);
    try {
      const response = await adminV2("POST", `cases/${adminCase.id}/assignment`, {
        userId: ADMIN, role: "admin",
        body: { entityVersion: adminCase.version, ownerId: OWNER, priority: "urgent", reason: "Take ownership atomically" },
      });
      expect(response.status).toBe(500);
    } finally {
      await prisma.$executeRawUnsafe(`
        DROP TRIGGER IF EXISTS fail_support_assignment_receipt_trigger ON "control_plane_commands";
        DROP FUNCTION IF EXISTS fail_support_assignment_receipt();
      `);
    }
    await expectAssignment(adminCase.id, request.id, null, adminCase.priority, request.priority);
    await expect(prisma.adminCase.findUniqueOrThrow({ where: { id: adminCase.id } })).resolves.toMatchObject({ version: adminCase.version, status: adminCase.status });
    await expect(prisma.supportRequest.findUniqueOrThrow({ where: { id: request.id } })).resolves.toMatchObject({ updatedAt: request.updatedAt });
    await expect(prisma.adminAuditLog.count({ where: { targetId: adminCase.id, action: "case.assigned" } })).resolves.toBe(0);
    await expect(prisma.mainOutboxEvent.count({ where: { aggregateId: adminCase.id, eventType: "admin.case.assigned.v2" } })).resolves.toBe(0);
    await expect(prisma.controlPlaneCommand.count({ where: { targetId: adminCase.id } })).resolves.toBe(0);
  });
});
