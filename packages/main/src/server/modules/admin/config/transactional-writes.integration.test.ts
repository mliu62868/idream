import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import {
  api,
  createUser,
  expectError,
  expectOk,
  purgeTestData,
} from "@/server/test/helpers";

const P = "zt-admin-config-atomic-";
const actorId = `${P}admin`;

beforeAll(async () => {
  await installFaultInjectionTriggers();
  await purgeTestData(P);
  await createUser({ id: actorId, role: "admin" });
});

afterAll(async () => {
  await prisma.mainOutboxEvent.deleteMany({
    where: { aggregateId: { startsWith: P } },
  });
  await purgeTestData(P);
  await removeFaultInjectionTriggers();
  await prisma.$disconnect();
});

describe("transactional admin configuration writes", () => {
  it("commits a feature flag change, Audit, and Outbox together", async () => {
    const key = `${P}image-edit`;
    const requestId = `${P}flag-success`;

    const result = await patchFlag(key, true, requestId);

    expectOk(result);
    await expect(prisma.featureFlag.findUnique({ where: { key } })).resolves.toMatchObject({
      enabled: true,
      version: 1,
    });
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
      payload: expect.objectContaining({
        actorId,
        requestId,
        key,
        enabled: true,
        version: 1,
      }),
    });
  });

  it("rolls back a feature flag change when Audit or Outbox persistence fails", async () => {
    const auditFailureKey = `${P}flag-audit-failure`;
    const auditFailureRequestId = `${P}fail-audit-flag`;
    const auditFailure = await patchFlag(auditFailureKey, true, auditFailureRequestId);

    expectError(auditFailure, 500, "internal");
    await expect(prisma.featureFlag.findUnique({ where: { key: auditFailureKey } })).resolves.toBeNull();
    await expect(prisma.mainOutboxEvent.count({
      where: { aggregateType: "feature_flag", aggregateId: auditFailureKey },
    })).resolves.toBe(0);

    const outboxFailureKey = `${P}flag-outbox-failure`;
    const outboxFailureRequestId = `${P}fail-outbox-flag`;
    const outboxFailure = await patchFlag(outboxFailureKey, true, outboxFailureRequestId);

    expectError(outboxFailure, 500, "internal");
    await expect(prisma.featureFlag.findUnique({ where: { key: outboxFailureKey } })).resolves.toBeNull();
    await expect(prisma.adminAuditLog.count({
      where: { requestId: outboxFailureRequestId },
    })).resolves.toBe(0);
  });
});

async function patchFlag(key: string, enabled: boolean, requestId: string) {
  return api("PATCH", `admin/feature-flags/${key}`, {
    userId: actorId,
    role: "admin",
    headers: { "x-request-id": requestId },
    body: {
      enabled,
      reason: "verify transactional configuration writes",
      confirmation: `${key}:${enabled ? "enabled" : "disabled"}`,
    },
  });
}

async function installFaultInjectionTriggers() {
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION zt_admin_config_fail_audit()
    RETURNS trigger AS $$
    BEGIN
      IF NEW."requestId" LIKE '${P}fail-audit-%' THEN
        RAISE EXCEPTION 'injected admin audit failure';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await prisma.$executeRawUnsafe(`
    DROP TRIGGER IF EXISTS zt_admin_config_fail_audit ON "admin_audit_logs";
    CREATE TRIGGER zt_admin_config_fail_audit
    BEFORE INSERT ON "admin_audit_logs"
    FOR EACH ROW EXECUTE FUNCTION zt_admin_config_fail_audit();
  `);
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION zt_admin_config_fail_outbox()
    RETURNS trigger AS $$
    BEGIN
      IF COALESCE(NEW."payload"->>'requestId', '') LIKE '${P}fail-outbox-%' THEN
        RAISE EXCEPTION 'injected admin outbox failure';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await prisma.$executeRawUnsafe(`
    DROP TRIGGER IF EXISTS zt_admin_config_fail_outbox ON "main_outbox_events";
    CREATE TRIGGER zt_admin_config_fail_outbox
    BEFORE INSERT ON "main_outbox_events"
    FOR EACH ROW EXECUTE FUNCTION zt_admin_config_fail_outbox();
  `);
}

async function removeFaultInjectionTriggers() {
  await prisma.$executeRawUnsafe(`
    DROP TRIGGER IF EXISTS zt_admin_config_fail_audit ON "admin_audit_logs";
    DROP FUNCTION IF EXISTS zt_admin_config_fail_audit();
    DROP TRIGGER IF EXISTS zt_admin_config_fail_outbox ON "main_outbox_events";
    DROP FUNCTION IF EXISTS zt_admin_config_fail_outbox();
  `);
}
