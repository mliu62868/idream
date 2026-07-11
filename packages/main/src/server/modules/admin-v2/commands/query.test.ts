import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { acceptControlPlaneCommand } from "../shared/control-plane-command";
import { getControlPlaneCommand } from "./query";

describe("Admin v2 command status query", () => {
  const adminId = `admin-v2-query-${randomUUID()}`;
  const analystId = `admin-v2-query-analyst-${randomUUID()}`;
  let commandId = "";

  beforeAll(async () => {
    await prisma.user.create({
      data: {
        id: adminId,
        email: `${adminId}@example.test`,
        role: "admin",
        status: "active",
      },
    });
    await prisma.user.create({
      data: {
        id: analystId,
        email: `${analystId}@example.test`,
        role: "analyst",
        status: "active",
      },
    });
    const accepted = await acceptControlPlaneCommand(prisma, {
      environment: "test",
      actor: { id: adminId, role: "admin" },
      idempotencyKey: randomUUID(),
      commandType: "incident.resolve",
      target: { type: "ops_incident", id: "incident-query-1" },
      expectedVersion: 2,
      payload: {},
      reason: "verify status endpoint",
      requestId: randomUUID(),
    });
    commandId = accepted.commandId;
  });

  afterAll(async () => {
    await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: "incident-query-1" } });
    await prisma.adminAuditLog.deleteMany({ where: { actorId: adminId } });
    await prisma.controlPlaneCommand.deleteMany({ where: { actorId: adminId } });
    await prisma.user.deleteMany({ where: { id: { in: [adminId, analystId] } } });
    await prisma.$disconnect();
  });

  it("returns the authoritative command state through effective permissions", async () => {
    const response = await getControlPlaneCommand(
      new Request("http://localhost/api/v2/admin/commands/command", {
        headers: { "x-idream-user-id": adminId, "x-idream-role": "admin" },
      }),
      commandId,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: true,
      data: {
        commandId,
        commandType: "incident.resolve",
        target: { type: "ops_incident", id: "incident-query-1" },
        status: "accepted",
        verificationState: "pending",
        needsReconciliation: false,
      },
    });
  });

  it("does not expose command state to an unauthenticated caller", async () => {
    for (const id of [commandId, "unknown-command"]) {
      const response = await getControlPlaneCommand(
        new Request("http://localhost/api/v2/admin/commands/command"),
        id,
      );
      expect(response.status).toBe(401);
    }
  });

  it("rejects an authenticated actor without the target read permission", async () => {
    const response = await getControlPlaneCommand(
      new Request("http://localhost/api/v2/admin/commands/command", {
        headers: { "x-idream-user-id": analystId, "x-idream-role": "analyst" },
      }),
      commandId,
    );
    expect(response.status).toBe(403);
  });
});
