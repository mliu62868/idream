import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { adminV2 } from "@/server/test/admin-v2-http";
import { api, createUser, expectError, expectOk, purgeTestData } from "@/server/test/helpers";

const P = "zt-case-owner-authority-";
const CUSTOMER = `${P}customer`;
const ADMIN = `${P}admin`;
const INACTIVE = `${P}inactive`;
const REVOKED = `${P}revoked`;
const GRANTED = `${P}granted`;

beforeAll(async () => {
  await purgeTestData(P);
  await createUser({ id: CUSTOMER, dataClass: "customer" });
  await createUser({ id: ADMIN, role: "admin", dataClass: "internal" });
  await createUser({ id: INACTIVE, role: "support", dataClass: "internal" });
  await createUser({ id: REVOKED, role: "support", dataClass: "internal" });
  await createUser({ id: GRANTED, role: "user", dataClass: "internal" });
  await prisma.user.update({ where: { id: INACTIVE }, data: { status: "suspended" } });
  await prisma.adminUserPermission.createMany({ data: [
    { userId: REVOKED, permissionKey: "case.read", effect: "revoke", reason: "Withdraw Case access", createdById: ADMIN },
    { userId: GRANTED, permissionKey: "case.read", effect: "grant", reason: "Allow the operator to own Cases", createdById: ADMIN },
  ] });
});
afterAll(() => purgeTestData(P));

async function fileRequest() {
  const filed = await api("POST", "support/requests", { userId: CUSTOMER, ageGate: true, body: {
    category: "bug", subject: "A download needs investigation", description: "The saved image does not open.",
  } });
  expectOk(filed, 201);
  const ticket = await prisma.supportRequest.findUniqueOrThrow({ where: { ticketId: filed.data.request.ticketId } });
  const intake = await prisma.caseEvidence.findFirstOrThrow({ where: { sourceType: "support_request", sourceId: ticket.id } });
  const adminCase = await prisma.adminCase.findUniqueOrThrow({ where: { id: intake.caseId } });
  return { ticket, adminCase };
}

describe("Case and Support owner authority", () => {
  it.each([CUSTOMER, INACTIVE, REVOKED])("rejects %s through both assignment doors with no partial changes", async (ownerId) => {
    const { ticket, adminCase } = await fileRequest();
    expectError(await adminV2("PATCH", `support/requests/${ticket.ticketId}`, { userId: ADMIN, role: "admin", body: {
      expectedUpdatedAt: ticket.updatedAt.toISOString(), assignedToId: ownerId,
      reason: "Assign the investigation", confirmation: ticket.ticketId,
    } }), 400, "bad_request");
    expectError(await adminV2("POST", `cases/${adminCase.id}/assignment`, { userId: ADMIN, role: "admin", body: {
      entityVersion: adminCase.version, ownerId, reason: "Assign the investigation",
    } }), 400, "bad_request");
    await expect(prisma.supportRequest.findUniqueOrThrow({ where: { id: ticket.id } })).resolves.toEqual(ticket);
    await expect(prisma.adminCase.findUniqueOrThrow({ where: { id: adminCase.id } })).resolves.toEqual(adminCase);
    await expect(prisma.adminAuditLog.count({ where: { targetId: { in: [ticket.ticketId, adminCase.id] }, action: { in: ["case.assigned", "support.request.update"] } } })).resolves.toBe(0);
    await expect(prisma.controlPlaneCommand.count({ where: { targetId: { in: [ticket.ticketId, adminCase.id] } } })).resolves.toBe(0);
  });

  it("accepts an active account with an explicit effective Case grant through both doors", async () => {
    const { ticket, adminCase } = await fileRequest();
    expectOk(await adminV2("PATCH", `support/requests/${ticket.ticketId}`, { userId: ADMIN, role: "admin", body: {
      expectedUpdatedAt: ticket.updatedAt.toISOString(), assignedToId: GRANTED,
      reason: "Use the explicitly authorized Case owner", confirmation: ticket.ticketId,
    } }));
    const current = await prisma.adminCase.findUniqueOrThrow({ where: { id: adminCase.id } });
    expectOk(await adminV2("POST", `cases/${adminCase.id}/assignment`, { userId: ADMIN, role: "admin", body: {
      entityVersion: current.version, ownerId: GRANTED, reason: "Keep the authorized Case owner",
    } }));
    await expect(prisma.supportRequest.findUniqueOrThrow({ where: { id: ticket.id } })).resolves.toMatchObject({ assignedToId: GRANTED });
    await expect(prisma.adminCase.findUniqueOrThrow({ where: { id: adminCase.id } })).resolves.toMatchObject({ ownerId: GRANTED });
  });
});
