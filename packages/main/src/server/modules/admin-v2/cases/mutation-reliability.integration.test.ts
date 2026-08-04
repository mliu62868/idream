import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as assignCaseRoute } from "@/app/api/v2/admin/cases/[id]/assignment/route";
import { prisma } from "@/server/lib/db";
import { adminCaseActiveKey } from "./service";

describe("Case mutation reliability", () => {
  const suffix = randomUUID();
  const actorId = `case-reliability-admin-${suffix}`;
  const ownerId = `case-reliability-owner-${suffix}`;
  const caseId = `case-reliability-${suffix}`;
  const rollbackCaseId = `case-reliability-rollback-${suffix}`;
  const terminalCaseId = `case-reliability-terminal-${suffix}`;
  const context = { params: Promise.resolve({ id: caseId }) };

  function assignmentRequest(headers: Record<string, string> = {}, body: Record<string, unknown> = {}) {
    return new Request(`http://localhost/api/v2/admin/cases/${caseId}/assignment`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-idream-user-id": actorId,
        "x-idream-role": "admin",
        ...headers,
      },
      body: JSON.stringify({ entityVersion: 1, ownerId, reason: "Take ownership", ...body }),
    });
  }

  beforeAll(async () => {
    await prisma.user.createMany({ data: [
      { id: actorId, email: `${actorId}@example.test`, role: "admin", status: "active" },
      { id: ownerId, email: `${ownerId}@example.test`, role: "support", status: "active" },
    ] });
    await prisma.adminCase.create({ data: {
      id: caseId,
      type: "support_request",
      targetType: "user",
      targetId: `customer-${suffix}`,
      caseKey: `reliability-${suffix}`,
      activeKey: adminCaseActiveKey(
        "support_request",
        "user",
        `customer-${suffix}`,
        `reliability-${suffix}`,
      ),
      status: "new",
      priority: "normal",
      verificationState: "pending",
    } });
    await prisma.adminCase.create({ data: {
      id: rollbackCaseId,
      type: "support_request",
      targetType: "user",
      targetId: `rollback-customer-${suffix}`,
      caseKey: `rollback-${suffix}`,
      activeKey: adminCaseActiveKey(
        "support_request",
        "user",
        `rollback-customer-${suffix}`,
        `rollback-${suffix}`,
      ),
      status: "new",
      priority: "normal",
      verificationState: "pending",
    } });
    await prisma.adminCase.create({ data: {
      id: terminalCaseId,
      type: "support_request",
      targetType: "user",
      targetId: `terminal-customer-${suffix}`,
      caseKey: `terminal-${suffix}`,
      status: "closed",
      priority: "normal",
      verificationState: "passed",
    } });
  });

  afterAll(async () => {
    await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: { in: [caseId, rollbackCaseId, terminalCaseId] } } });
    await prisma.adminAuditLog.deleteMany({ where: { targetId: { in: [caseId, rollbackCaseId, terminalCaseId] } } });
    await prisma.controlPlaneCommand.deleteMany({ where: { targetId: { in: [caseId, rollbackCaseId, terminalCaseId] } } });
    await prisma.adminCase.deleteMany({ where: { id: { in: [caseId, rollbackCaseId, terminalCaseId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [actorId, ownerId] } } });
    await prisma.$disconnect();
  });

  it("requires Idempotency-Key before assigning a Case", async () => {
    const response = await assignCaseRoute(assignmentRequest({ "x-request-id": `missing-${suffix}` }), context);
    expect(response.status).toBe(400);
    await expect(prisma.adminCase.findUniqueOrThrow({ where: { id: caseId } })).resolves.toMatchObject({ ownerId: null, version: 1 });
  });

  it("rejects assignment from a terminal Case without persisting side effects", async () => {
    const response = await assignCaseRoute(new Request(`http://localhost/api/v2/admin/cases/${terminalCaseId}/assignment`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-idream-user-id": actorId,
        "x-idream-role": "admin",
        "x-request-id": `terminal-${suffix}`,
        "idempotency-key": `terminal-${suffix}`,
      },
      body: JSON.stringify({ entityVersion: 1, ownerId, reason: "Terminal assignment must fail closed" }),
    }), { params: Promise.resolve({ id: terminalCaseId }) });

    expect(response.status).toBe(409);
    await expect(prisma.adminCase.findUniqueOrThrow({ where: { id: terminalCaseId } })).resolves.toMatchObject({
      status: "closed",
      ownerId: null,
      version: 1,
    });
    await expect(prisma.adminAuditLog.count({ where: { targetId: terminalCaseId } })).resolves.toBe(0);
    await expect(prisma.mainOutboxEvent.count({ where: { aggregateId: terminalCaseId } })).resolves.toBe(0);
    await expect(prisma.controlPlaneCommand.count({ where: { targetId: terminalCaseId } })).resolves.toBe(0);
  });

  it("replays the exact assignment result and rejects a changed payload", async () => {
    const key = `assignment-${suffix}`;
    const first = await assignCaseRoute(assignmentRequest({
      "idempotency-key": key,
      "x-request-id": `assignment-first-${suffix}`,
    }), context);
    const firstPayload = await first.json();
    const replay = await assignCaseRoute(assignmentRequest({
      "idempotency-key": key,
      "x-request-id": `assignment-replay-${suffix}`,
    }), context);
    expect(await replay.json()).toEqual(firstPayload);

    const collision = await assignCaseRoute(assignmentRequest({
      "idempotency-key": key,
      "x-request-id": `assignment-collision-${suffix}`,
    }, { priority: "high" }), context);
    expect(collision.status).toBe(409);
    await expect(prisma.adminAuditLog.count({ where: { targetId: caseId, action: "case.assigned" } })).resolves.toBe(1);
    await expect(prisma.mainOutboxEvent.count({ where: { aggregateId: caseId, eventType: "admin.case.assigned.v2" } })).resolves.toBe(1);
    await expect(prisma.controlPlaneCommand.findUniqueOrThrow({
      where: { scope_idempotencyKey: { scope: `test:${actorId}`, idempotencyKey: key } },
    })).resolves.toMatchObject({
      commandType: "case.assignment",
      requestId: `assignment-first-${suffix}`,
      requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      status: "succeeded",
    });
  });

  it("rolls the Case, Audit and Outbox back when receipt persistence fails", async () => {
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION fail_case_mutation_receipt() RETURNS trigger AS $$
      BEGIN
        IF NEW."commandType" = 'case.assignment' AND NEW."targetId" = '${rollbackCaseId}' THEN
          RAISE EXCEPTION 'injected case receipt failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_case_mutation_receipt_trigger
      BEFORE INSERT ON "control_plane_commands"
      FOR EACH ROW EXECUTE FUNCTION fail_case_mutation_receipt();
    `);
    try {
      const request = assignmentRequest({
        "idempotency-key": `rollback-${suffix}`,
        "x-request-id": `rollback-${suffix}`,
      }, { sourceId: undefined });
      const rollbackContext = { params: Promise.resolve({ id: rollbackCaseId }) };
      await expect(assignCaseRoute(request, rollbackContext)).rejects.toThrow("injected case receipt failure");
    } finally {
      await prisma.$executeRawUnsafe(`
        DROP TRIGGER IF EXISTS fail_case_mutation_receipt_trigger ON "control_plane_commands";
        DROP FUNCTION IF EXISTS fail_case_mutation_receipt();
      `);
    }
    await expect(prisma.adminCase.findUniqueOrThrow({ where: { id: rollbackCaseId } })).resolves.toMatchObject({ ownerId: null, version: 1 });
    await expect(prisma.adminAuditLog.count({ where: { targetId: rollbackCaseId } })).resolves.toBe(0);
    await expect(prisma.mainOutboxEvent.count({ where: { aggregateId: rollbackCaseId } })).resolves.toBe(0);
    await expect(prisma.controlPlaneCommand.count({ where: { targetId: rollbackCaseId } })).resolves.toBe(0);
  });
});
