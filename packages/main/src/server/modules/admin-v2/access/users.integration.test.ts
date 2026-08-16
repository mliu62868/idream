import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as listUsersRoute } from "@/app/api/v2/admin/users/route";
import { GET as userDetailRoute } from "@/app/api/v2/admin/users/[id]/route";
import { POST as userStatusRoute } from "@/app/api/v2/admin/users/[id]/status/route";
import { POST as userRoleRoute } from "@/app/api/v2/admin/users/[id]/role/route";
import {
  GET as userPermissionsReadRoute,
  POST as userPermissionsWriteRoute,
} from "@/app/api/v2/admin/users/[id]/permissions/route";
import { prisma } from "@/server/lib/db";
import { createUser, purgeTestData } from "@/server/test/helpers";

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
  it("applies server search, role/status filters, and stable cursor pagination", async () => {
    const olderId = `${P}access-older`;
    const newerId = `${P}access-newer`;
    await createUser({ id: olderId, role: "support", email: `${P}match-older@example.test` });
    await createUser({ id: newerId, role: "support", email: `${P}match-newer@example.test` });
    await prisma.user.update({ where: { id: olderId }, data: { createdAt: new Date("2026-01-01T00:00:00.000Z") } });
    await prisma.user.update({ where: { id: newerId }, data: { createdAt: new Date("2026-01-02T00:00:00.000Z") } });

    const first = await callList(`q=${P}match&role=support&status=active&limit=1`);
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.data.items).toEqual([expect.objectContaining({ id: newerId })]);
    expect(firstBody.data.pageInfo.hasNextPage).toBe(true);
    const second = await callList(`q=${P}match&role=support&status=active&limit=1&cursor=${encodeURIComponent(firstBody.data.pageInfo.endCursor)}`);
    expect(second.status).toBe(200);
    expect((await second.json()).data.items).toEqual([expect.objectContaining({ id: olderId })]);
  });

  it("returns every user data class and applies an explicit dataClass filter", async () => {
    const scopeToken = `${P}data-class`;
    const classes = ["customer", "internal", "fixture", "audit"] as const;
    for (const dataClass of classes) {
      await createUser({
        id: `${scopeToken}-${dataClass}`,
        email: `${scopeToken}-${dataClass}@idream.test`,
        dataClass,
      });
    }

    const all = await callList(`q=${scopeToken}&role=user&status=active&limit=10`);
    expect(all.status).toBe(200);
    const allItems = (await all.json()).data.items as Array<{ id: string; dataClass: string }>;
    expect(allItems.map((item) => item.dataClass).sort()).toEqual([...classes].sort());

    for (const dataClass of classes) {
      const filtered = await callList(
        `q=${scopeToken}&role=user&status=active&dataClass=${dataClass}&limit=10`,
      );
      expect(filtered.status).toBe(200);
      expect((await filtered.json()).data.items).toEqual([
        expect.objectContaining({ id: `${scopeToken}-${dataClass}`, dataClass }),
      ]);
    }

    expect((await callList(`q=${scopeToken}&dataClass=unknown&limit=10`)).status).toBe(400);
  });

  it("serves the user detail projection through the declared contract", async () => {
    const targetId = `${P}detail-target`;
    await createUser({ id: targetId });
    const response = await userDetailRoute(
      new Request(`http://localhost/api/v2/admin/users/${targetId}`, { headers: authHeaders() }),
      { params: Promise.resolve({ id: targetId }) },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.user).toMatchObject({ id: targetId, status: "active" });
    expect(body.data.dreamcoins.balance).toBeTypeOf("number");
    expect(Array.isArray(body.data.generationJobs)).toBe(true);

    const missing = await userDetailRoute(
      new Request(`http://localhost/api/v2/admin/users/${P}absent`, { headers: authHeaders() }),
      { params: Promise.resolve({ id: `${P}absent` }) },
    );
    expect(missing.status).toBe(404);
  });

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

    const effective = await userPermissionsReadRoute(
      new Request(`http://localhost/api/v2/admin/users/${targetId}/permissions`, { headers: authHeaders() }),
      { params: Promise.resolve({ id: targetId }) },
    );
    expect(effective.status).toBe(200);
    const permissions = await effective.json();
    expect(permissions.data.role).toBe("support");
    expect(permissions.data.effective).toContain("billing.ledger.adjust");
    expect(permissions.data.overrides).toEqual([
      expect.objectContaining({ permissionKey: "billing.ledger.adjust", effect: "grant" }),
    ]);
  });

  // SPEC: 注入持久化失败时，命令回执 / 用户状态 / 审计 / Outbox 一起回滚。
  // INTENT: v1 经 `handle()` 把未知错误折成 500 响应；`adminV2Route` 只折 AppError，其余原样抛给
  // 框架（线上仍是 500）。所以这里断言的是「抛出」而不是「返回 500」—— 换成后者只会掩盖真实行为。
  it("rolls back receipt, user state, Audit, and Outbox on injected persistence failures", async () => {
    for (const failure of ["audit", "outbox"] as const) {
      const targetId = `${P}${failure}-failure-target`;
      const requestId = `${P}fail-${failure}-status`;
      await createUser({ id: targetId });
      await expect(callStatus(targetId, {
        status: "suspended",
        reason: `inject ${failure} persistence failure`,
        confirmation: `${targetId}:suspended`,
      }, `${P}${failure}-failure-key`, requestId)).rejects.toThrow();

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

function authHeaders(extra: Record<string, string> = {}) {
  return { "x-idream-user-id": actorId, "x-idream-role": "admin", ...extra };
}

function commandRequest(path: string, body: unknown, idempotencyKey: string | null, requestId: string) {
  return new Request(`http://localhost/api/v2/admin/users/${path}`, {
    method: "POST",
    headers: authHeaders({
      "content-type": "application/json",
      "x-request-id": requestId,
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    }),
    body: JSON.stringify(body),
  });
}

function callList(query: string) {
  return listUsersRoute(
    new Request(`http://localhost/api/v2/admin/users?${query}`, { headers: authHeaders() }),
  );
}

function callStatus(targetId: string, body: unknown, key: string | null, requestId: string) {
  return userStatusRoute(commandRequest(`${targetId}/status`, body, key, requestId), {
    params: Promise.resolve({ id: targetId }),
  });
}

function callRole(targetId: string, body: unknown, key: string, requestId: string) {
  return userRoleRoute(commandRequest(`${targetId}/role`, body, key, requestId), {
    params: Promise.resolve({ id: targetId }),
  });
}

function callPermission(targetId: string, body: unknown, key: string, requestId: string) {
  return userPermissionsWriteRoute(commandRequest(`${targetId}/permissions`, body, key, requestId), {
    params: Promise.resolve({ id: targetId }),
  });
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
