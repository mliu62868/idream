import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { adminV2 } from "@/server/test/admin-v2-http";
import { api, createUser, expectError, expectOk, purgeTestData } from "@/server/test/helpers";

const P = "zt-case-support-lifecycle-";
const CUSTOMER = `${P}customer`;
const ADMIN = `${P}admin`;

beforeAll(async () => {
  await purgeTestData(P);
  await createUser({ id: CUSTOMER, dataClass: "customer" });
  await createUser({ id: ADMIN, role: "admin", dataClass: "internal" });
});
afterAll(() => purgeTestData(P));

async function fileRequest() {
  const filed = await api("POST", "support/requests", {
    userId: CUSTOMER, ageGate: true,
    body: { category: "bug", subject: "Cannot save my image", description: "The generated image cannot be saved after refresh." },
  });
  expectOk(filed, 201);
  const request = await prisma.supportRequest.findUniqueOrThrow({ where: { ticketId: filed.data.request.ticketId } });
  const intake = await prisma.caseEvidence.findFirstOrThrow({ where: { sourceType: "support_request", sourceId: request.id } });
  return { request, caseId: intake.caseId };
}

async function resolveRequest(ticketId: string, message = "The image download works again.") {
  expectOk(await adminV2("PATCH", `support/requests/${ticketId}`, {
    userId: ADMIN, role: "admin",
    body: { status: "resolved", customerMessage: message, reason: message, confirmation: ticketId },
  }));
}

async function caseCommand(caseId: string, command: "wait" | "reopen" | "close", idempotencyKey = crypto.randomUUID(), entityVersion?: number) {
  const current = await prisma.adminCase.findUniqueOrThrow({ where: { id: caseId } });
  return adminV2("POST", `cases/${caseId}/commands/${command}`, {
    userId: ADMIN, role: "admin", idempotencyKey,
    body: {
      entityVersion: entityVersion ?? current.version,
      confirmation: `${caseId}:${command}`,
      reason: command === "close" ? { code: "outcome_verified", summary: "Customer outcome verified" } : "Continue investigating the customer issue",
    },
  });
}

describe("linked Support and Case lifecycle", () => {
  it("keeps dependency waiting open to customers, reopens replies, and closes the ticket with the Case", async () => {
    const { request, caseId } = await fileRequest();
    const initialCase = await prisma.adminCase.findUniqueOrThrow({ where: { id: caseId } });
    expectOk(await adminV2("POST", `cases/${caseId}/assignment`, {
      userId: ADMIN, role: "admin",
      body: { entityVersion: initialCase.version, ownerId: ADMIN, priority: "high", reason: "Own the customer follow-up" },
    }));
    expectOk(await caseCommand(caseId, "wait"));
    await expect(prisma.adminCase.findUniqueOrThrow({ where: { id: caseId } })).resolves.toMatchObject({ status: "waiting" });
    const waiting = await api("GET", `support/requests/${request.ticketId}`, { userId: CUSTOMER });
    expectOk(waiting);
    expect(waiting.data.request).toMatchObject({ status: "open", canReply: true });
    expectOk(await api("POST", `support/requests/${request.ticketId}/messages`, {
      userId: CUSTOMER, body: { messageId: crypto.randomUUID(), body: "The same download still fails." },
    }), 201);
    await resolveRequest(request.ticketId);
    const firstResolution = await prisma.caseEvidence.findFirstOrThrow({ where: { caseId, sourceType: "support_resolution" } });
    expectOk(await caseCommand(caseId, "close"), 202);
    await expect(prisma.supportRequest.findUniqueOrThrow({ where: { id: request.id } })).resolves.toMatchObject({ status: "closed" });
    const reopenKey = crypto.randomUUID();
    const closed = await prisma.adminCase.findUniqueOrThrow({ where: { id: caseId } });
    expectOk(await caseCommand(caseId, "reopen", reopenKey, closed.version));
    expectOk(await caseCommand(caseId, "reopen", reopenKey, closed.version));
    const reopened = await api("GET", `support/requests/${request.ticketId}`, { userId: CUSTOMER });
    expectOk(reopened);
    expect(reopened.data.request).toMatchObject({ status: "open", canReply: true });
    await expect(prisma.supportRequest.findUniqueOrThrow({ where: { id: request.id } })).resolves.toMatchObject({ assignedToId: ADMIN, priority: 2, resolvedAt: null });
    const reopenedCase = await adminV2("GET", `cases/${caseId}`, { userId: ADMIN, role: "admin" });
    expectOk(reopenedCase);
    expect(reopenedCase.data.case).toMatchObject({ status: "reopened", verification: { state: "pending" } });
    expectOk(await api("POST", `support/requests/${request.ticketId}/messages`, {
      userId: CUSTOMER, body: { messageId: crypto.randomUUID(), body: "It failed again after refresh." },
    }), 201);
    await resolveRequest(request.ticketId, "The second failure is fixed too.");
    expectOk(await caseCommand(caseId, "close"), 202);
    await expect(prisma.caseEvidence.findUniqueOrThrow({ where: { id: firstResolution.id } })).resolves.toEqual(firstResolution);
    await expect(prisma.caseEvidence.count({ where: { caseId, sourceType: "support_resolution" } })).resolves.toBe(2);
    const final = await api("GET", `support/requests/${request.ticketId}`, { userId: CUSTOMER });
    expectOk(final);
    expect(final.data.request).toMatchObject({ status: "closed", canReply: false });
    expect(final.data.request.messages).toHaveLength(4);
    await expect(prisma.supportRequest.findUniqueOrThrow({ where: { id: request.id } })).resolves.toMatchObject({ assignedToId: ADMIN, priority: 2 });
  });

  it("binds a recurrence to the ticket while preserving history and message idempotency across cases", async () => {
    const { request, caseId } = await fileRequest();
    const messageId = crypto.randomUUID();
    const oldReply = { userId: CUSTOMER, body: { messageId, body: "The download link is broken." } };
    expectOk(await api("POST", `support/requests/${request.ticketId}/messages`, oldReply), 201);
    await resolveRequest(request.ticketId);
    const prior = await prisma.adminCase.update({ where: { id: caseId }, data: { updatedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) } });
    const reopened = await caseCommand(caseId, "reopen");
    expectOk(reopened);
    expect(reopened.data.mode).toBe("recurrence");
    const recurrenceId = reopened.data.caseId as string;
    expect(recurrenceId).not.toBe(caseId);
    await expect(prisma.caseEvidence.count({ where: { caseId: recurrenceId, sourceType: "support_request", sourceId: request.id } })).resolves.toBe(1);
    await expect(prisma.adminCase.findUniqueOrThrow({ where: { id: caseId } })).resolves.toEqual(prior);
    const recurrenceBeforeReplay = await prisma.adminCase.findUniqueOrThrow({ where: { id: recurrenceId } });
    const replay = await api("POST", `support/requests/${request.ticketId}/messages`, oldReply);
    expectOk(replay);
    expect(replay.data).toMatchObject({ replayed: true, request: { status: "open", canReply: true } });
    expect(replay.data.request.messages).toHaveLength(2);
    await expect(prisma.adminCase.findUniqueOrThrow({ where: { id: recurrenceId } })).resolves.toEqual(recurrenceBeforeReplay);
    expectError(await api("POST", `support/requests/${request.ticketId}/messages`, { ...oldReply, body: { ...oldReply.body, body: "Different reply with an old ID" } }), 409, "conflict");
    // Closing the historical episode must not close its active recurrence.
    expectOk(await caseCommand(caseId, "close"), 202);
    await expect(prisma.supportRequest.findUniqueOrThrow({ where: { id: request.id } })).resolves.toMatchObject({ status: "open" });
    expectOk(await api("POST", `support/requests/${request.ticketId}/messages`, {
      userId: CUSTOMER, body: { messageId: crypto.randomUUID(), body: "The problem has returned today." },
    }), 201);
    await expect(prisma.adminCase.findUniqueOrThrow({ where: { id: recurrenceId } })).resolves.toMatchObject({ status: "in_progress" });
    await expect(prisma.adminCase.findUniqueOrThrow({ where: { id: caseId } })).resolves.toMatchObject({ status: "closed", version: prior.version + 1 });
    await resolveRequest(request.ticketId, "The recurring issue is fixed.");
    await expect(prisma.adminCase.findUniqueOrThrow({ where: { id: recurrenceId } })).resolves.toMatchObject({ status: "resolved" });
    expectOk(await caseCommand(recurrenceId, "close"), 202);
    const final = await api("GET", `support/requests/${request.ticketId}`, { userId: CUSTOMER });
    expectOk(final);
    expect(final.data.request).toMatchObject({ status: "closed", canReply: false });
    expect(final.data.request.messages).toHaveLength(4);
    const historical = await prisma.adminCase.findUniqueOrThrow({ where: { id: caseId } });
    const latest = await prisma.adminCase.findUniqueOrThrow({ where: { id: recurrenceId } });
    const closedTicket = await prisma.supportRequest.findUniqueOrThrow({ where: { id: request.id } });
    const beforeEvidence = await prisma.caseEvidence.count({ where: { caseId: { in: [caseId, recurrenceId] } } });
    const rejected = await caseCommand(caseId, "reopen");
    expectError(rejected, 409, "conflict");
    expect(rejected.error?.details).toMatchObject({ currentCaseId: recurrenceId });
    await expect(prisma.adminCase.findUniqueOrThrow({ where: { id: caseId } })).resolves.toEqual(historical);
    await expect(prisma.adminCase.findUniqueOrThrow({ where: { id: recurrenceId } })).resolves.toEqual(latest);
    await expect(prisma.supportRequest.findUniqueOrThrow({ where: { id: request.id } })).resolves.toEqual(closedTicket);
    await expect(prisma.caseEvidence.count({ where: { caseId: { in: [caseId, recurrenceId] } } })).resolves.toBe(beforeEvidence);
    await expect(prisma.adminAuditLog.count({ where: { targetId: caseId, action: "case.reopened" } })).resolves.toBe(0);
    await expect(prisma.mainOutboxEvent.count({ where: { aggregateId: caseId, eventType: "admin.case.reopened.v2" } })).resolves.toBe(0);

    expectOk(await caseCommand(recurrenceId, "reopen"));
    expectOk(await api("POST", `support/requests/${request.ticketId}/messages`, {
      userId: CUSTOMER, body: { messageId: crypto.randomUUID(), body: "I need help with the latest occurrence." },
    }), 201);
    await expect(prisma.adminCase.findUniqueOrThrow({ where: { id: recurrenceId } })).resolves.toMatchObject({ status: "in_progress" });
    await expect(prisma.adminCase.findUniqueOrThrow({ where: { id: caseId } })).resolves.toEqual(historical);
    const continued = await api("GET", `support/requests/${request.ticketId}`, { userId: CUSTOMER });
    expectOk(continued);
    expect(continued.data.request).toMatchObject({ status: "open", canReply: true });
    expect(continued.data.request.messages).toHaveLength(5);
  });

  it("allows one concurrent recurrence and leaves the prior terminal Case immutable", async () => {
    const { request, caseId } = await fileRequest();
    await resolveRequest(request.ticketId);
    const prior = await prisma.adminCase.update({ where: { id: caseId }, data: { updatedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) } });
    const attempts = await Promise.all([caseCommand(caseId, "reopen", crypto.randomUUID(), prior.version), caseCommand(caseId, "reopen", crypto.randomUUID(), prior.version)]);
    expect(attempts.map((result) => result.status).sort()).toEqual([200, 409]);
    await expect(prisma.adminCase.count({ where: { caseKey: prior.caseKey, activeKey: { not: null } } })).resolves.toBe(1);
    await expect(prisma.adminCase.findUniqueOrThrow({ where: { id: caseId } })).resolves.toEqual(prior);
    await expect(prisma.caseEvidence.count({ where: { sourceType: "support_request", sourceId: request.id } })).resolves.toBe(2);
    await expect(prisma.supportRequest.findUniqueOrThrow({ where: { id: request.id } })).resolves.toMatchObject({ status: "open", resolvedAt: null });
  });

  it("rolls back a reopened ticket, Case and added evidence when receipt persistence fails", async () => {
    const { request, caseId } = await fileRequest();
    await resolveRequest(request.ticketId);
    const beforeCase = await prisma.adminCase.findUniqueOrThrow({ where: { id: caseId } });
    const beforeTicket = await prisma.supportRequest.findUniqueOrThrow({ where: { id: request.id } });
    const evidenceCount = await prisma.caseEvidence.count({ where: { caseId } });
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION fail_support_reopen_receipt() RETURNS trigger AS $$ BEGIN
        IF NEW."commandType" = 'case.reopen' AND NEW."targetId" = '${caseId}' THEN RAISE EXCEPTION 'injected support reopen receipt failure'; END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_support_reopen_receipt_trigger BEFORE INSERT ON "control_plane_commands" FOR EACH ROW EXECUTE FUNCTION fail_support_reopen_receipt();
    `);
    try {
      expect((await caseCommand(caseId, "reopen")).status).toBe(500);
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS fail_support_reopen_receipt_trigger ON "control_plane_commands"; DROP FUNCTION IF EXISTS fail_support_reopen_receipt();');
    }
    await expect(prisma.adminCase.findUniqueOrThrow({ where: { id: caseId } })).resolves.toEqual(beforeCase);
    await expect(prisma.supportRequest.findUniqueOrThrow({ where: { id: request.id } })).resolves.toEqual(beforeTicket);
    await expect(prisma.caseEvidence.count({ where: { caseId } })).resolves.toBe(evidenceCount);
    await expect(prisma.adminAuditLog.count({ where: { targetId: caseId, action: "case.reopened" } })).resolves.toBe(0);
    await expect(prisma.mainOutboxEvent.count({ where: { aggregateId: caseId, eventType: "admin.case.reopened.v2" } })).resolves.toBe(0);
  });
});
