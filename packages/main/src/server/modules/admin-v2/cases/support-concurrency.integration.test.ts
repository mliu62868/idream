import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { adminV2 } from "@/server/test/admin-v2-http";
import { api, createUser, expectError, expectOk, purgeTestData } from "@/server/test/helpers";

const P = "zt-support-concurrency-";
const CUSTOMER = `${P}customer`;
const ADMIN = `${P}admin`;
const OTHER = `${P}other`;

beforeAll(async () => {
  await purgeTestData(P);
  await createUser({ id: CUSTOMER, dataClass: "customer" });
  await createUser({ id: ADMIN, role: "admin", dataClass: "internal" });
  await createUser({ id: OTHER, role: "support", dataClass: "internal" });
});
afterAll(() => purgeTestData(P));

async function fileRequest() {
  const filed = await api("POST", "support/requests", { userId: CUSTOMER, ageGate: true, body: {
    category: "bug", subject: "Cannot download image", description: "The image download returns an error after refresh.",
  } });
  expectOk(filed, 201);
  const ticket = await prisma.supportRequest.findUniqueOrThrow({ where: { ticketId: filed.data.request.ticketId } });
  const intake = await prisma.caseEvidence.findFirstOrThrow({ where: { sourceType: "support_request", sourceId: ticket.id } });
  return { ticket, caseId: intake.caseId };
}

describe("Support operator snapshot authority", () => {
  it("rejects an unversioned status update without changing the ticket or Case", async () => {
    const { ticket, caseId } = await fileRequest();
    const before = await prisma.adminCase.findUniqueOrThrow({ where: { id: caseId } });
    expectError(await adminV2("PATCH", `support/requests/${ticket.ticketId}`, { userId: ADMIN, role: "admin", body: {
      status: "open", reason: "Start investigation", confirmation: ticket.ticketId,
    } }), 400, "bad_request");
    await expect(prisma.supportRequest.findUniqueOrThrow({ where: { id: ticket.id } })).resolves.toEqual(ticket);
    await expect(prisma.adminCase.findUniqueOrThrow({ where: { id: caseId } })).resolves.toEqual(before);
  });

  it("admits one of two operator decisions and replays the winner against its original snapshot", async () => {
    const { ticket, caseId } = await fileRequest();
    const commands = [ADMIN, OTHER].map((ownerId) => ({
      userId: ownerId, role: ownerId === ADMIN ? "admin" : "support", idempotencyKey: `${ticket.ticketId}:${ownerId}`,
      body: { expectedUpdatedAt: ticket.updatedAt.toISOString(), status: "open", assignedToId: ownerId,
        reason: "Own this customer investigation", confirmation: ticket.ticketId },
    }));
    const replies = await Promise.all(commands.map((command) => adminV2("PATCH", `support/requests/${ticket.ticketId}`, command)));
    expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409]);
    const index = replies.findIndex((reply) => reply.status === 200);
    const winner = commands[index];
    await expect(prisma.adminCase.findUniqueOrThrow({ where: { id: caseId } })).resolves.toMatchObject({ ownerId: winner.userId });
    await expect(prisma.supportRequest.findUniqueOrThrow({ where: { id: ticket.id } })).resolves.toMatchObject({ assignedToId: winner.userId });
    const replay = await adminV2("PATCH", `support/requests/${ticket.ticketId}`, winner);
    expectOk(replay);
    expect(replay.data).toMatchObject({ replayed: true, request: { assignedToId: winner.userId } });
    expectError(await adminV2("PATCH", `support/requests/${ticket.ticketId}`, { ...winner, body: { ...winner.body, priority: 1 } }), 409, "conflict");
    expect(await prisma.adminAuditLog.count({ where: { targetId: ticket.ticketId, action: "support.request.update" } })).toBe(1);
    expect(await prisma.controlPlaneCommand.count({ where: { targetId: ticket.ticketId } })).toBe(1);
  });

  it("updates new-ticket priority and owner while retaining its new Case lifecycle", async () => {
    const { ticket, caseId } = await fileRequest();
    const updated = await adminV2("PATCH", `support/requests/${ticket.ticketId}`, { userId: ADMIN, role: "admin", body: {
      expectedUpdatedAt: ticket.updatedAt.toISOString(), priority: 2, assignedToId: OTHER,
      reason: "Route this new request to the right operator", confirmation: ticket.ticketId,
    } });
    expectOk(updated);
    expect(updated.data.request).toMatchObject({ status: "received", priority: 2, assignedToId: OTHER });
    await expect(prisma.adminCase.findUniqueOrThrow({ where: { id: caseId } })).resolves.toMatchObject({ status: "new", priority: "high", ownerId: OTHER });
  });

  it("preserves an in-progress investigation when its source ticket is opened or reassigned", async () => {
    const { ticket, caseId } = await fileRequest();
    expectOk(await api("POST", `support/requests/${ticket.ticketId}/messages`, { userId: CUSTOMER, body: {
      messageId: crypto.randomUUID(), body: "The image still fails in a different browser.",
    } }), 201);
    const current = await prisma.supportRequest.findUniqueOrThrow({ where: { id: ticket.id } });
    const updated = await adminV2("PATCH", `support/requests/${ticket.ticketId}`, { userId: ADMIN, role: "admin", body: {
      expectedUpdatedAt: current.updatedAt.toISOString(), status: "open", priority: 1, assignedToId: OTHER,
      reason: "Continue the current investigation with an urgent owner", confirmation: ticket.ticketId,
    } });
    expectOk(updated);
    await expect(prisma.adminCase.findUniqueOrThrow({ where: { id: caseId } })).resolves.toMatchObject({ status: "in_progress", priority: "urgent", ownerId: OTHER });
  });

  it("uses one ticket SLA in Support and Case and exposes an operator's explicit deadline in both", async () => {
    const filed = await fileRequest();
    const ticket = await prisma.supportRequest.update({ where: { id: filed.ticket.id }, data: { createdAt: new Date("2026-10-01T10:00:00.000Z") } });
    const updated = await adminV2("PATCH", `support/requests/${ticket.ticketId}`, { userId: ADMIN, role: "admin", body: {
      expectedUpdatedAt: ticket.updatedAt.toISOString(), priority: 2,
      reason: "Prioritize this support ticket", confirmation: ticket.ticketId,
    } });
    expectOk(updated);
    expect(updated.data.request.slaDueAt).toBe("2026-10-01T22:00:00.000Z");
    const current = await prisma.adminCase.findUniqueOrThrow({ where: { id: filed.caseId } });
    expect(current.slaDueAt?.toISOString()).toBe("2026-10-01T22:00:00.000Z");
    expectOk(await adminV2("POST", `cases/${current.id}/assignment`, { userId: ADMIN, role: "admin", body: {
      entityVersion: current.version, ownerId: OTHER, slaDueAt: "2026-10-02T14:00:00.000Z", reason: "Agree a concrete follow-up deadline",
    } }));
    const queue = await adminV2("GET", "support/requests", { userId: ADMIN, role: "admin", query: { ticketId: ticket.ticketId } });
    expectOk(queue);
    expect(queue.data.items[0].slaDueAt).toBe("2026-10-02T14:00:00.000Z");
  });
});
