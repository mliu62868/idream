import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { handle } from "@/server/lib/http";
import { createUser, purgeTestData } from "@/server/test/helpers";
import {
  setUserPermission,
  updateUserRole,
  updateUserStatus,
} from "./service";

const P = "zt-admin-user-command-";
const actorId = `${P}actor`;

beforeAll(async () => {
  await installFaultInjectionTriggers();
  await purgeTestData(P);
  await createUser({ id: actorId, role: "admin" });
});

afterAll(async () => {
  await prisma.controlPlaneCommand.deleteMany({ where: { actorId } });
  await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: { startsWith: P } } });
  await purgeTestData(P);
  await removeFaultInjectionTriggers();
  await prisma.$disconnect();
});

describe("idempotent user authority commands", () => {
  it("replays an exact status request and conflicts on a changed canonical request", async () => {
    const targetId = `${P}status-target`;
    const key = `${P}status-key`;
    await createUser({ id: targetId });
    const body = {
      status: "suspended",
      reason: "verify exact status replay",
      confirmation: `${targetId}:suspended`,
    };

    const first = await callStatus(targetId, body, key, `${P}status-first`);
    const replay = await callStatus(targetId, body, key, `${P}status-replay`);
    expect(first.status).toBe(200);
    expect((await first.json()).data.replayed).toBe(false);
    expect(replay.status).toBe(200);
    expect((await replay.json()).data.replayed).toBe(true);
    await expect(prisma.user.findUnique({ where: { id: targetId } })).resolves.toMatchObject({ status: "suspended" });
    await expect(prisma.controlPlaneCommand.count({ where: { actorId, idempotencyKey: key } })).resolves.toBe(1);
    await expect(prisma.adminAuditLog.count({ where: { actorId, action: "user.status.write", targetId } })).resolves.toBe(1);
    await expect(prisma.mainOutboxEvent.count({ where: { aggregateId: targetId, eventType: "admin.user.status_changed.v2" } })).resolves.toBe(1);

    const conflict = await callStatus(targetId, {
      status: "active",
      reason: "changed replay must conflict",
      confirmation: `${targetId}:active`,
    }, key, `${P}status-conflict`);
    expect(conflict.status).toBe(409);
    await expect(prisma.user.findUnique({ where: { id: targetId } })).resolves.toMatchObject({ status: "suspended" });
  });

  it("deduplicates role and permission commands without duplicate Audit or Outbox", async () => {
    const targetId = `${P}role-permission-target`;
    await createUser({ id: targetId });
    const roleKey = `${P}role-key`;
    const roleBody = {
      role: "support",
      reason: "assign support duties",
      confirmation: `${targetId}:support`,
    };
    expect((await callRole(targetId, roleBody, roleKey, `${P}role-first`)).status).toBe(200);
    expect((await callRole(targetId, roleBody, roleKey, `${P}role-replay`)).status).toBe(200);

    const permissionKey = `${P}permission-key`;
    const permissionBody = {
      permissionKey: "billing.ledger.adjust",
      effect: "grant",
      reason: "temporary finance coverage",
      confirmation: `${targetId}:billing.ledger.adjust:grant`,
    };
    expect((await callPermission(targetId, permissionBody, permissionKey, `${P}permission-first`)).status).toBe(200);
    const replay = await callPermission(targetId, permissionBody, permissionKey, `${P}permission-replay`);
    expect(replay.status).toBe(200);
    expect((await replay.json()).data.replayed).toBe(true);

    await expect(prisma.controlPlaneCommand.count({ where: { actorId, targetId } })).resolves.toBe(2);
    await expect(prisma.adminAuditLog.count({ where: { actorId, targetId, action: { in: ["user.role.write", "admin.permission.grant"] } } })).resolves.toBe(2);
    await expect(prisma.mainOutboxEvent.count({ where: { aggregateId: targetId, eventType: { in: ["admin.user.role_changed.v2", "admin.user.permission_changed.v2"] } } })).resolves.toBe(2);
    await expect(prisma.adminUserPermission.count({ where: { userId: targetId, permissionKey: "billing.ledger.adjust" } })).resolves.toBe(1);
  });

  it("rolls back receipt, user state, Audit, and Outbox on injected persistence failures", async () => {
    for (const failure of ["audit", "outbox"] as const) {
      const targetId = `${P}${failure}-failure-target`;
      const requestId = `${P}fail-${failure}-status`;
      await createUser({ id: targetId });
      const response = await callStatus(targetId, {
        status: "suspended",
        reason: `inject ${failure} persistence failure`,
        confirmation: `${targetId}:suspended`,
      }, `${P}${failure}-failure-key`, requestId);

      expect(response.status).toBe(500);
      await expect(prisma.user.findUnique({ where: { id: targetId } })).resolves.toMatchObject({ status: "active" });
      await expect(prisma.controlPlaneCommand.count({ where: { actorId, targetId } })).resolves.toBe(0);
      await expect(prisma.adminAuditLog.count({ where: { actorId, targetId } })).resolves.toBe(0);
      await expect(prisma.mainOutboxEvent.count({ where: { aggregateId: targetId } })).resolves.toBe(0);
    }
  });

  it("requires an Idempotency-Key before changing user authority", async () => {
    const targetId = `${P}missing-key-target`;
    await createUser({ id: targetId });
    const response = await callStatus(targetId, {
      status: "suspended",
      reason: "missing idempotency must fail",
      confirmation: `${targetId}:suspended`,
    }, null, `${P}missing-key`);
    expect(response.status).toBe(400);
    await expect(prisma.user.findUnique({ where: { id: targetId } })).resolves.toMatchObject({ status: "active" });
  });
});

function request(path: string, body: unknown, idempotencyKey: string | null, requestId: string) {
  return new Request(`http://localhost/api/v1/admin/users/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-idream-user-id": actorId,
      "x-idream-role": "admin",
      "x-request-id": requestId,
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  });
}

function callStatus(targetId: string, body: unknown, key: string | null, requestId: string) {
  const req = request(`${targetId}/status`, body, key, requestId);
  return handle(() => updateUserStatus(req, targetId))(req);
}

function callRole(targetId: string, body: unknown, key: string, requestId: string) {
  const req = request(`${targetId}/role`, body, key, requestId);
  return handle(() => updateUserRole(req, targetId))(req);
}

function callPermission(targetId: string, body: unknown, key: string, requestId: string) {
  const req = request(`${targetId}/permissions`, body, key, requestId);
  return handle(() => setUserPermission(req, targetId))(req);
}

async function installFaultInjectionTriggers() {
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION zt_admin_user_command_fail_audit()
    RETURNS trigger AS $$
    BEGIN
      IF NEW."requestId" LIKE '${P}fail-audit-%' THEN
        RAISE EXCEPTION 'injected user command audit failure';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await prisma.$executeRawUnsafe(`
    DROP TRIGGER IF EXISTS zt_admin_user_command_fail_audit ON "admin_audit_logs";
    CREATE TRIGGER zt_admin_user_command_fail_audit
    BEFORE INSERT ON "admin_audit_logs"
    FOR EACH ROW EXECUTE FUNCTION zt_admin_user_command_fail_audit();
  `);
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION zt_admin_user_command_fail_outbox()
    RETURNS trigger AS $$
    BEGIN
      IF COALESCE(NEW."payload"->>'requestId', '') LIKE '${P}fail-outbox-%' THEN
        RAISE EXCEPTION 'injected user command outbox failure';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await prisma.$executeRawUnsafe(`
    DROP TRIGGER IF EXISTS zt_admin_user_command_fail_outbox ON "main_outbox_events";
    CREATE TRIGGER zt_admin_user_command_fail_outbox
    BEFORE INSERT ON "main_outbox_events"
    FOR EACH ROW EXECUTE FUNCTION zt_admin_user_command_fail_outbox();
  `);
}

async function removeFaultInjectionTriggers() {
  await prisma.$executeRawUnsafe(`
    DROP TRIGGER IF EXISTS zt_admin_user_command_fail_audit ON "admin_audit_logs";
    DROP FUNCTION IF EXISTS zt_admin_user_command_fail_audit();
    DROP TRIGGER IF EXISTS zt_admin_user_command_fail_outbox ON "main_outbox_events";
    DROP FUNCTION IF EXISTS zt_admin_user_command_fail_outbox();
  `);
}
