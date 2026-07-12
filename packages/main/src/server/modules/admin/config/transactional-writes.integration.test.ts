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

  it("emits typed Outbox events for the complete pricing lifecycle", async () => {
    const ruleKey = `${P}pricing-lifecycle`;
    const createRequestId = `${P}pricing-create-success`;
    const created = await createRule(ruleKey, 80, createRequestId);
    expectOk(created);
    const firstId = created.data.rule.id as string;

    const patchRequestId = `${P}pricing-patch-success`;
    const patched = await api("PATCH", `admin/pricing/rules/${firstId}`, {
      userId: actorId,
      role: "admin",
      headers: { "x-request-id": patchRequestId },
      body: { baseCost: 75 },
    });
    expectOk(patched);

    const firstPublishRequestId = `${P}pricing-publish-first-success`;
    const firstPublished = await publishRule(firstId, firstPublishRequestId);
    expectOk(firstPublished);

    const secondCreated = await createRule(ruleKey, 60, `${P}pricing-create-second-success`);
    expectOk(secondCreated);
    const secondId = secondCreated.data.rule.id as string;
    const secondPublishRequestId = `${P}pricing-publish-second-success`;
    const secondPublished = await publishRule(secondId, secondPublishRequestId);
    expectOk(secondPublished);

    const rollbackRequestId = `${P}pricing-rollback-success`;
    const rolledBack = await rollbackRule(secondId, rollbackRequestId);
    expectOk(rolledBack);
    expect(rolledBack.data).toMatchObject({ fromVersion: 2, toVersion: 1 });

    const events = await prisma.mainOutboxEvent.findMany({
      where: {
        aggregateType: "pricing_rule",
        aggregateId: { in: [firstId, secondId] },
      },
      orderBy: { createdAt: "asc" },
    });
    expect(events.map((event) => event.eventType)).toEqual(expect.arrayContaining([
      "config.pricing.rule.created.v2",
      "config.pricing.rule.updated.v2",
      "config.pricing.rule.published.v2",
      "config.pricing.rule.rolled_back.v2",
    ]));
    expect(events.find((event) => event.eventType === "config.pricing.rule.updated.v2")?.payload)
      .toMatchObject({ actorId, requestId: patchRequestId, ruleId: firstId, baseCost: 75 });
    expect(events.find((event) => event.eventType === "config.pricing.rule.rolled_back.v2")?.payload)
      .toMatchObject({
        actorId,
        requestId: rollbackRequestId,
        fromRuleId: secondId,
        restoredRuleId: firstId,
        fromVersion: 2,
        toVersion: 1,
      });
  });

  it("rolls back every pricing command when Audit persistence fails", async () => {
    const createRuleKey = `${P}pricing-create-audit-failure`;
    const createFailure = await createRule(
      createRuleKey,
      10,
      `${P}fail-audit-pricing-create`,
    );
    expectError(createFailure, 500, "internal");
    await expect(prisma.pricingRule.count({ where: { ruleKey: createRuleKey } })).resolves.toBe(0);

    const patchId = `${P}pricing-patch-target`;
    await seedPricingRule({ id: patchId, ruleKey: `${P}pricing-patch`, baseCost: 20, status: "draft", version: 1 });
    const patchFailure = await api("PATCH", `admin/pricing/rules/${patchId}`, {
      userId: actorId,
      role: "admin",
      headers: { "x-request-id": `${P}fail-audit-pricing-patch` },
      body: { baseCost: 21 },
    });
    expectError(patchFailure, 500, "internal");
    await expect(prisma.pricingRule.findUnique({ where: { id: patchId } })).resolves.toMatchObject({ baseCost: 20 });

    const activeId = `${P}pricing-publish-active`;
    const publishId = `${P}pricing-publish-target`;
    await seedPricingRule({ id: activeId, ruleKey: `${P}pricing-publish-v1`, baseCost: 30, status: "active", version: 1 });
    await seedPricingRule({ id: publishId, ruleKey: `${P}pricing-publish-v2`, baseCost: 25, status: "draft", version: 2 });
    const publishFailure = await publishRule(publishId, `${P}fail-audit-pricing-publish`);
    expectError(publishFailure, 500, "internal");
    await expect(prisma.pricingRule.findUnique({ where: { id: activeId } })).resolves.toMatchObject({ status: "active" });
    await expect(prisma.pricingRule.findUnique({ where: { id: publishId } })).resolves.toMatchObject({ status: "draft" });

    const rollbackPreviousId = `${P}pricing-rollback-previous`;
    const rollbackCurrentId = `${P}pricing-rollback-current`;
    const rollbackKey = `${P}pricing-rollback`;
    await seedPricingRule({ id: rollbackPreviousId, ruleKey: rollbackKey, baseCost: 40, status: "archived", version: 1 });
    await seedPricingRule({ id: rollbackCurrentId, ruleKey: rollbackKey, baseCost: 35, status: "active", version: 2 });
    const rollbackFailure = await rollbackRule(rollbackCurrentId, `${P}fail-audit-pricing-rollback`);
    expectError(rollbackFailure, 500, "internal");
    await expect(prisma.pricingRule.findUnique({ where: { id: rollbackPreviousId } })).resolves.toMatchObject({ status: "archived" });
    await expect(prisma.pricingRule.findUnique({ where: { id: rollbackCurrentId } })).resolves.toMatchObject({ status: "active" });
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

async function createRule(ruleKey: string, baseCost: number, requestId: string) {
  return api("POST", "admin/pricing/rules", {
    userId: actorId,
    role: "admin",
    headers: { "x-request-id": requestId },
    body: {
      ruleKey,
      label: ruleKey,
      mode: "voice",
      baseCost,
      reason: "verify transactional pricing writes",
      confirmation: ruleKey,
    },
  });
}

async function publishRule(id: string, requestId: string) {
  return api("POST", `admin/pricing/rules/${id}/publish`, {
    userId: actorId,
    role: "admin",
    headers: { "x-request-id": requestId },
    body: {
      reason: "verify transactional pricing publish",
      confirmation: id,
    },
  });
}

async function rollbackRule(id: string, requestId: string) {
  return api("POST", `admin/pricing/rules/${id}/rollback`, {
    userId: actorId,
    role: "admin",
    headers: { "x-request-id": requestId },
    body: {
      reason: "verify transactional pricing rollback",
      confirmation: id,
    },
  });
}

async function seedPricingRule(input: {
  id: string;
  ruleKey: string;
  baseCost: number;
  status: "draft" | "active" | "archived";
  version: number;
}) {
  return prisma.pricingRule.create({
    data: {
      ...input,
      label: input.ruleKey,
      mode: "voice",
      multiplier: 1,
      publishedAt: input.status === "active" ? new Date() : null,
      archivedAt: input.status === "archived" ? new Date() : null,
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
