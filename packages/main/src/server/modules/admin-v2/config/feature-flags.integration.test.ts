import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as featureFlagListRoute } from "@/app/api/v2/admin/feature-flags/route";
import { PATCH as featureFlagPatchRoute } from "@/app/api/v2/admin/feature-flags/[key]/route";
import { prisma } from "@/server/lib/db";
import { createUser, purgeTestData } from "@/server/test/helpers";

const P = "zt-admin-flag-atomic-";
const actorId = `${P}admin`;

beforeAll(async () => {
  await installFaultInjectionTriggers();
  await purgeTestData(P);
  await createUser({ id: actorId, role: "admin" });
});

afterAll(async () => {
  await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: { startsWith: P } } });
  await prisma.controlPlaneCommand.deleteMany({ where: { actorId } });
  await prisma.featureFlag.deleteMany({ where: { key: { startsWith: P } } });
  await purgeTestData(P);
  await removeFaultInjectionTriggers();
  await prisma.$disconnect();
});

describe("feature flag authority", () => {
  it("commits a flag change, Audit, and Outbox together", async () => {
    const key = `${P}image-edit`;
    const requestId = `${P}flag-success`;

    const response = await patchFlag(key, true, requestId, `${P}flag-success-key`);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.flag).toMatchObject({ key, enabled: true, version: 1 });
    expect(body.data.replayed).toBe(false);
    await expect(prisma.adminAuditLog.count({
      where: { requestId, action: "config.feature_flag.write", targetId: key },
    })).resolves.toBe(1);
    await expect(prisma.mainOutboxEvent.findFirst({
      where: {
        aggregateType: "feature_flag",
        aggregateId: key,
        eventType: "config.feature_flag.changed.v2",
      },
    })).resolves.toMatchObject({
      status: "pending",
      payload: expect.objectContaining({ actorId, requestId, key, enabled: true, version: 1 }),
    });

    const replay = await patchFlag(key, true, `${P}flag-replay`, `${P}flag-success-key`);
    expect(replay.status).toBe(200);
    expect((await replay.json()).data.replayed).toBe(true);
    await expect(prisma.adminAuditLog.count({
      where: { action: "config.feature_flag.write", targetId: key },
    })).resolves.toBe(1);
  });

  it("lists flags through the declared query contract", async () => {
    const response = await featureFlagListRoute(
      new Request(`http://localhost/api/v2/admin/feature-flags?search=${P}&limit=25`, {
        headers: authHeaders(),
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.items.map((flag: { key: string }) => flag.key)).toContain(`${P}image-edit`);
    expect(body.data.pageInfo).toMatchObject({ hasNextPage: false });
  });

  // SPEC: 审计或 Outbox 写失败时开关本身不得留下。
  // INTENT: `adminV2Route` 只把 AppError 折成响应，注入的 Postgres 异常原样抛出（线上由框架转 500），
  // 所以断言写成「抛出 + 什么都没落库」。
  it("rolls back the flag when Audit or Outbox persistence fails", async () => {
    for (const failure of ["audit", "outbox"] as const) {
      const key = `${P}flag-${failure}-failure`;
      const requestId = `${P}fail-${failure}-flag`;
      await expect(
        patchFlag(key, true, requestId, `${P}${failure}-failure-key`),
      ).rejects.toThrow();
      await expect(prisma.featureFlag.findUnique({ where: { key } })).resolves.toBeNull();
      await expect(prisma.adminAuditLog.count({ where: { requestId } })).resolves.toBe(0);
      await expect(prisma.mainOutboxEvent.count({
        where: { aggregateType: "feature_flag", aggregateId: key },
      })).resolves.toBe(0);
    }
  });

  it("refuses to touch hard safety policy flags", async () => {
    const response = await patchFlag(
      `${P}age_gate`,
      false,
      `${P}hard-policy`,
      `${P}hard-policy-key`,
    );
    expect(response.status).toBe(403);
  });
});

function authHeaders(extra: Record<string, string> = {}) {
  return { "x-idream-user-id": actorId, "x-idream-role": "admin", ...extra };
}

function patchFlag(key: string, enabled: boolean, requestId: string, idempotencyKey: string) {
  return featureFlagPatchRoute(
    new Request(`http://localhost/api/v2/admin/feature-flags/${key}`, {
      method: "PATCH",
      headers: authHeaders({
        "content-type": "application/json",
        "x-request-id": requestId,
        "idempotency-key": idempotencyKey,
      }),
      body: JSON.stringify({
        enabled,
        reason: "verify transactional configuration writes",
        confirmation: `${key}:${enabled ? "enabled" : "disabled"}`,
      }),
    }),
    { params: Promise.resolve({ key }) },
  );
}

async function installFaultInjectionTriggers() {
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION zt_admin_flag_fail_audit()
    RETURNS trigger AS $$
    BEGIN
      IF NEW."requestId" LIKE '${P}fail-audit-%' THEN
        RAISE EXCEPTION 'injected admin flag audit failure';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await prisma.$executeRawUnsafe(`
    DROP TRIGGER IF EXISTS zt_admin_flag_fail_audit ON "admin_audit_logs";
    CREATE TRIGGER zt_admin_flag_fail_audit
    BEFORE INSERT ON "admin_audit_logs"
    FOR EACH ROW EXECUTE FUNCTION zt_admin_flag_fail_audit();
  `);
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION zt_admin_flag_fail_outbox()
    RETURNS trigger AS $$
    BEGIN
      IF COALESCE(NEW."payload"->>'requestId', '') LIKE '${P}fail-outbox-%' THEN
        RAISE EXCEPTION 'injected admin flag outbox failure';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await prisma.$executeRawUnsafe(`
    DROP TRIGGER IF EXISTS zt_admin_flag_fail_outbox ON "main_outbox_events";
    CREATE TRIGGER zt_admin_flag_fail_outbox
    BEFORE INSERT ON "main_outbox_events"
    FOR EACH ROW EXECUTE FUNCTION zt_admin_flag_fail_outbox();
  `);
}

async function removeFaultInjectionTriggers() {
  await prisma.$executeRawUnsafe(`
    DROP TRIGGER IF EXISTS zt_admin_flag_fail_audit ON "admin_audit_logs";
    DROP FUNCTION IF EXISTS zt_admin_flag_fail_audit();
    DROP TRIGGER IF EXISTS zt_admin_flag_fail_outbox ON "main_outbox_events";
    DROP FUNCTION IF EXISTS zt_admin_flag_fail_outbox();
  `);
}
