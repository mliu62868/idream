import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { verifyAdminCanaryAuthority } from "./admin-canary-authority-probe";

describe("Admin canary Audit/Outbox authority probe", () => {
  const suffix = randomUUID();
  const commandId = `canary-command-${suffix}`;
  const caseId = `canary-case-${suffix}`;
  const requestId = `canary-request-${suffix}`;

  afterAll(async () => {
    await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: caseId } });
    await prisma.adminAuditLog.deleteMany({ where: { targetId: caseId } });
    await prisma.controlPlaneCommand.deleteMany({ where: { id: commandId } });
    await prisma.$disconnect();
  });

  it("passes only when the succeeded canonical command has matching Audit and Outbox authority", async () => {
    await prisma.controlPlaneCommand.create({
      data: {
        id: commandId,
        scope: "production:case.close",
        idempotencyKey: `canary-${suffix}`,
        commandType: "case.close",
        targetType: "admin_case",
        targetId: caseId,
        actorId: `canary-actor-${suffix}`,
        requestId,
        requestHash: "a".repeat(64),
        requestPayload: {},
        expectedVersion: 3,
        retryMode: "idempotent",
        status: "succeeded",
        result: { caseId, status: "closed", version: 4 },
        finishedAt: new Date(),
      },
    });
    const audit = await prisma.adminAuditLog.create({
      data: {
        actorId: `canary-actor-${suffix}`,
        actorRole: "command_executor",
        action: "case.closed",
        targetType: "admin_case",
        targetId: caseId,
        requestId,
      },
    });
    const outbox = await prisma.mainOutboxEvent.create({
      data: {
        id: `canary-outbox-${suffix}`,
        eventType: "admin.case.closed.v2",
        aggregateType: "admin_case",
        aggregateId: caseId,
        payload: { caseId, commandId, version: 4 },
      },
    });

    await expect(verifyAdminCanaryAuthority({
      runId: suffix,
      commands: [{ iteration: 0, commandId, requestId, caseId }],
    })).resolves.toEqual({
      status: "pass",
      checks: [{
        iteration: 0,
        commandId,
        commandStatus: "succeeded",
        auditRecordId: audit.id,
        outboxEventId: outbox.id,
        outcome: "pass",
      }],
    });

    await prisma.mainOutboxEvent.delete({ where: { id: outbox.id } });
    await expect(verifyAdminCanaryAuthority({
      runId: suffix,
      commands: [{ iteration: 0, commandId, requestId, caseId }],
    })).resolves.toMatchObject({
      status: "fail",
      checks: [{ outcome: "fail", auditRecordId: audit.id, outboxEventId: null }],
    });
  });
});
