import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as listRoute, POST as createRoute } from "@/app/api/v2/admin/pricing/rules/route";
import { PATCH as patchRoute } from "@/app/api/v2/admin/pricing/rules/[id]/route";
import { POST as publishRoute } from "@/app/api/v2/admin/pricing/rules/[id]/publish/route";
import { POST as rollbackRoute } from "@/app/api/v2/admin/pricing/rules/[id]/rollback/route";
import { prisma } from "@/server/lib/db";
import { createUser, expectError, expectOk, purgeTestData } from "@/server/test/helpers";
import { adminV2Route } from "@/server/test/admin-v2-route-client";

const P = "zt-adminv2-pricing-";
const adminId = `${P}admin`;
const supportId = `${P}support`;
const opsId = `${P}ops`;
const seedPricingAuthorities = [
  { id: "seed-pricing-image-default-v1", mode: "image" },
  { id: "seed-pricing-video-default-v1", mode: "video" },
  { id: "seed-pricing-voice-default-v1", mode: "voice" },
] as const;

function listRules(options: { userId: string; role: string; query?: Record<string, string> }) {
  return adminV2Route(listRoute, {
    path: "pricing/rules",
    userId: options.userId,
    role: options.role,
    query: options.query,
  });
}

function createRule(options: {
  userId: string;
  role: string;
  body: Record<string, unknown>;
  requestId?: string;
}) {
  return adminV2Route(createRoute, {
    method: "POST",
    path: "pricing/rules",
    userId: options.userId,
    role: options.role,
    headers: options.requestId ? { "x-request-id": options.requestId } : undefined,
    body: options.body,
  });
}

function ruleCommand(
  handler: typeof patchRoute | typeof publishRoute | typeof rollbackRoute,
  options: {
    method: "POST" | "PATCH";
    suffix: string;
    id: string;
    userId: string;
    role: string;
    body: Record<string, unknown>;
    requestId?: string;
  },
) {
  return adminV2Route(handler, {
    method: options.method,
    path: `pricing/rules/${options.id}${options.suffix}`,
    params: { id: options.id },
    userId: options.userId,
    role: options.role,
    headers: options.requestId ? { "x-request-id": options.requestId } : undefined,
    body: options.body,
  });
}

async function restoreSeedPricingAuthorities() {
  const archivedAt = new Date();
  for (const authority of seedPricingAuthorities) {
    await prisma.$transaction([
      prisma.pricingRule.updateMany({
        where: { mode: authority.mode, status: "active", id: { not: authority.id } },
        data: { status: "archived", archivedAt },
      }),
      prisma.pricingRule.update({
        where: { id: authority.id },
        data: { status: "active", archivedAt: null },
      }),
    ]);
  }
}

async function cleanup() {
  await prisma.controlPlaneCommand.deleteMany({ where: { actorId: { startsWith: P } } });
  await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: { startsWith: P } } });
  await prisma.pricingRule.deleteMany({ where: { ruleKey: { startsWith: P } } });
  await prisma.pricingRule.deleteMany({ where: { id: { startsWith: P } } });
  await purgeTestData(P);
}

// SPEC: 让「Audit 行写失败」变成可复现的故障，用来证明领域写与 Audit 同生共死。
// INTENT: 触发器按 requestId 前缀命中，所以同一个文件里的正常用例不受影响。
async function installFaultInjectionTriggers() {
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION zt_adminv2_pricing_fail_audit()
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
    DROP TRIGGER IF EXISTS zt_adminv2_pricing_fail_audit ON "admin_audit_logs";
    CREATE TRIGGER zt_adminv2_pricing_fail_audit
    BEFORE INSERT ON "admin_audit_logs"
    FOR EACH ROW EXECUTE FUNCTION zt_adminv2_pricing_fail_audit();
  `);
}

async function removeFaultInjectionTriggers() {
  await prisma.$executeRawUnsafe(`
    DROP TRIGGER IF EXISTS zt_adminv2_pricing_fail_audit ON "admin_audit_logs";
    DROP FUNCTION IF EXISTS zt_adminv2_pricing_fail_audit();
  `);
}

beforeAll(async () => {
  await installFaultInjectionTriggers();
  await cleanup();
  await restoreSeedPricingAuthorities();
  await createUser({ id: adminId, role: "admin", dataClass: "internal" });
  await createUser({ id: supportId, role: "support", dataClass: "internal" });
  await createUser({ id: opsId, role: "ops", dataClass: "internal" });
});

afterAll(async () => {
  await cleanup();
  await restoreSeedPricingAuthorities();
  await removeFaultInjectionTriggers();
  await prisma.$disconnect();
});

describe.sequential("Admin v2 pricing control plane", () => {
  it("gates pricing reads by billing.read and writes by config.pricing.write", async () => {
    expectOk(await listRules({ userId: supportId, role: "support" }));
    expectOk(await listRules({ userId: adminId, role: "admin" }));
    expectError(await listRules({ userId: opsId, role: "ops" }), 403);
    expectError(
      await createRule({
        userId: supportId,
        role: "support",
        body: {
          ruleKey: `${P}noop`,
          label: "x",
          mode: "video",
          baseCost: 10,
          reason: "denied write",
          confirmation: `${P}noop`,
        },
      }),
      403,
    );
  });

  it("creates a draft only when the confirmation names the rule key", async () => {
    const voice = await createRule({
      userId: adminId,
      role: "admin",
      body: {
        ruleKey: `${P}voice_pricing`,
        label: "Voice overflow",
        mode: "voice",
        baseCost: 2,
        reason: "voice pricing draft",
        confirmation: `${P}voice_pricing`,
      },
    });
    expectOk(voice);
    expect(voice.data.rule).toMatchObject({ mode: "voice", status: "draft", version: 1 });

    const wrongConfirmation = await createRule({
      userId: adminId,
      role: "admin",
      body: {
        ruleKey: `${P}voice_pricing_wrong`,
        label: "Voice wrong confirmation",
        mode: "voice",
        baseCost: 3,
        reason: "wrong confirmation",
        confirmation: "CREATE",
      },
    });
    expectError(wrongConfirmation, 400, "bad_request");
    expect(await prisma.pricingRule.count({ where: { ruleKey: `${P}voice_pricing_wrong` } })).toBe(0);
  });

  it("publishes and rolls back with audit, keeping one active rule per mode", async () => {
    const ruleKey = `${P}video_base`;
    await prisma.pricingRule.create({
      data: {
        id: `${P}pricing-v1`,
        ruleKey,
        label: "Video base v1",
        mode: "video",
        baseCost: 80,
        multiplier: 1,
        version: 1,
        status: "active",
        publishedAt: new Date(),
      },
    });

    const draft = await createRule({
      userId: adminId,
      role: "admin",
      body: {
        ruleKey,
        label: "Video base v2",
        mode: "video",
        baseCost: 60,
        multiplier: 1,
        reason: "create promo price draft",
        confirmation: ruleKey,
      },
    });
    expectOk(draft);
    expect(draft.data.rule).toMatchObject({ status: "draft", version: 2, baseCost: 60 });
    const draftId = draft.data.rule.id as string;

    // 只有 draft 能编辑；active 规则改价必须走新 draft + publish。
    const editActive = await ruleCommand(patchRoute, {
      method: "PATCH",
      suffix: "",
      id: `${P}pricing-v1`,
      userId: adminId,
      role: "admin",
      body: { baseCost: 70 },
    });
    expectError(editActive, 400, "bad_request");

    const patched = await ruleCommand(patchRoute, {
      method: "PATCH",
      suffix: "",
      id: draftId,
      userId: adminId,
      role: "admin",
      requestId: `${P}patch-request`,
      body: { baseCost: 75 },
    });
    expectOk(patched);
    expect(patched.data.rule).toMatchObject({ baseCost: 75, status: "draft" });

    const publishWrongConfirmation = await ruleCommand(publishRoute, {
      method: "POST",
      suffix: "/publish",
      id: draftId,
      userId: adminId,
      role: "admin",
      body: { reason: "promo price drop", confirmation: "PUBLISH" },
    });
    expectError(publishWrongConfirmation, 400, "bad_request");

    const futurePublish = await ruleCommand(publishRoute, {
      method: "POST",
      suffix: "/publish",
      id: draftId,
      userId: adminId,
      role: "admin",
      body: {
        reason: "unsupported scheduled price",
        confirmation: draftId,
        effectiveFrom: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
    expectError(futurePublish, 400, "bad_request");
    expect(futurePublish.error?.message).toContain("effectiveFrom cannot be in the future");

    const published = await ruleCommand(publishRoute, {
      method: "POST",
      suffix: "/publish",
      id: draftId,
      userId: adminId,
      role: "admin",
      requestId: `${P}publish-request`,
      body: { reason: "promo price drop", confirmation: draftId },
    });
    expectOk(published);
    // previousActiveId 只报告发布前该 mode 上任意一条 active 规则（v1 起就是 findFirst，
    // 没有排序保证），所以只断言它确实指向了一条被归档掉的规则。
    expect(published.data).toMatchObject({
      rule: { status: "active", version: 2, baseCost: 75 },
      previousActiveId: expect.any(String),
    });
    expect(await prisma.pricingRule.findUnique({ where: { id: `${P}pricing-v1` } })).toMatchObject({
      status: "archived",
    });
    // 不变量：每个 mode 至多一个 active 规则（generationCost 的资金侧 SSoT）。
    expect(
      await prisma.pricingRule.count({ where: { ruleKey, mode: "video", status: "active" } }),
    ).toBe(1);

    const rollbackWrongConfirmation = await ruleCommand(rollbackRoute, {
      method: "POST",
      suffix: "/rollback",
      id: draftId,
      userId: adminId,
      role: "admin",
      body: { reason: "promo ended", confirmation: "ROLLBACK" },
    });
    expectError(rollbackWrongConfirmation, 400, "bad_request");

    const rolledBack = await ruleCommand(rollbackRoute, {
      method: "POST",
      suffix: "/rollback",
      id: draftId,
      userId: adminId,
      role: "admin",
      requestId: `${P}rollback-request`,
      body: { reason: "promo ended", confirmation: draftId },
    });
    expectOk(rolledBack);
    expect(rolledBack.data).toMatchObject({ fromVersion: 2, toVersion: 1 });
    expect(await prisma.pricingRule.findUnique({ where: { id: `${P}pricing-v1` } })).toMatchObject({
      status: "active",
      baseCost: 80,
    });

    const actions = (
      await prisma.adminAuditLog.findMany({
        where: { actorId: adminId, targetType: "pricing_rule" },
      })
    ).map((audit) => audit.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "config.pricing.create",
        "config.pricing.update",
        "config.pricing.publish",
        "config.pricing.rollback",
      ]),
    );

    const events = await prisma.mainOutboxEvent.findMany({
      where: { aggregateType: "pricing_rule", aggregateId: { in: [draftId, `${P}pricing-v1`] } },
      orderBy: { createdAt: "asc" },
    });
    expect(events.map((event) => event.eventType)).toEqual(expect.arrayContaining([
      "config.pricing.rule.created.v2",
      "config.pricing.rule.updated.v2",
      "config.pricing.rule.published.v2",
      "config.pricing.rule.rolled_back.v2",
    ]));
    expect(events.find((event) => event.eventType === "config.pricing.rule.updated.v2")?.payload)
      .toMatchObject({ actorId: adminId, requestId: `${P}patch-request`, ruleId: draftId, baseCost: 75 });
    expect(events.find((event) => event.eventType === "config.pricing.rule.rolled_back.v2")?.payload)
      .toMatchObject({
        actorId: adminId,
        requestId: `${P}rollback-request`,
        fromRuleId: draftId,
        restoredRuleId: `${P}pricing-v1`,
        fromVersion: 2,
        toVersion: 1,
      });
  });

  it("replays an exact create command instead of versioning a second draft", async () => {
    const ruleKey = `${P}replayed`;
    const idempotencyKey = `${P}replayed-key`;
    const body = {
      ruleKey,
      label: "Replayed draft",
      mode: "image",
      baseCost: 7,
      reason: "verify exact command replay",
      confirmation: ruleKey,
    };
    const first = await adminV2Route(createRoute, {
      method: "POST",
      path: "pricing/rules",
      userId: adminId,
      role: "admin",
      idempotencyKey,
      body,
    });
    const replay = await adminV2Route(createRoute, {
      method: "POST",
      path: "pricing/rules",
      userId: adminId,
      role: "admin",
      idempotencyKey,
      body,
    });
    expectOk(first);
    expectOk(replay);
    expect(replay.data.rule.id).toBe(first.data.rule.id);
    expect(await prisma.pricingRule.count({ where: { ruleKey } })).toBe(1);
  });

  it("requires an Idempotency-Key on every pricing write", async () => {
    expectError(
      await adminV2Route(createRoute, {
        method: "POST",
        path: "pricing/rules",
        userId: adminId,
        role: "admin",
        idempotencyKey: false,
        body: {
          ruleKey: `${P}no_key`,
          label: "No key",
          mode: "image",
          baseCost: 4,
          reason: "missing idempotency key",
          confirmation: `${P}no_key`,
        },
      }),
      400,
      "bad_request",
    );
    expect(await prisma.pricingRule.count({ where: { ruleKey: `${P}no_key` } })).toBe(0);
  });

  it("paginates by (ruleKey, version, id) and returns the full set without a limit", async () => {
    const page = await listRules({
      userId: adminId,
      role: "admin",
      query: { search: P, limit: "1" },
    });
    expectOk(page);
    expect(page.data.items).toHaveLength(1);
    expect(page.data.pageInfo.hasNextPage).toBe(true);
    expect(page.data.pageInfo.endCursor).toEqual(expect.any(String));

    const next = await listRules({
      userId: adminId,
      role: "admin",
      query: { search: P, limit: "1", cursor: page.data.pageInfo.endCursor as string },
    });
    expectOk(next);
    expect(next.data.items[0]?.id).not.toBe(page.data.items[0]?.id);

    const unbounded = await listRules({ userId: adminId, role: "admin", query: { search: P } });
    expectOk(unbounded);
    expect(unbounded.data.pageInfo).toEqual({ endCursor: null, hasNextPage: false });
    expect(unbounded.data.items.length).toBeGreaterThan(1);
  });

  it("rolls back every pricing command when Audit persistence fails", async () => {
    const createRuleKey = `${P}audit-failure`;
    await expect(createRule({
      userId: adminId,
      role: "admin",
      requestId: `${P}fail-audit-create`,
      body: {
        ruleKey: createRuleKey,
        label: createRuleKey,
        mode: "voice",
        baseCost: 10,
        reason: "verify transactional pricing writes",
        confirmation: createRuleKey,
      },
    })).rejects.toThrow();
    await expect(prisma.pricingRule.count({ where: { ruleKey: createRuleKey } })).resolves.toBe(0);

    const patchId = `${P}audit-failure-patch`;
    await seedPricingRule({ id: patchId, ruleKey: `${P}audit-failure-patch-key`, baseCost: 20, status: "draft", version: 1 });
    await expect(ruleCommand(patchRoute, {
      method: "PATCH",
      suffix: "",
      id: patchId,
      userId: adminId,
      role: "admin",
      requestId: `${P}fail-audit-patch`,
      body: { baseCost: 21 },
    })).rejects.toThrow();
    await expect(prisma.pricingRule.findUnique({ where: { id: patchId } }))
      .resolves.toMatchObject({ baseCost: 20 });

    const activeId = `${P}audit-failure-active`;
    const publishId = `${P}audit-failure-publish`;
    await seedPricingRule({ id: activeId, ruleKey: `${P}audit-failure-publish-key`, baseCost: 30, status: "active", version: 1 });
    await seedPricingRule({ id: publishId, ruleKey: `${P}audit-failure-publish-key`, baseCost: 25, status: "draft", version: 2 });
    await expect(ruleCommand(publishRoute, {
      method: "POST",
      suffix: "/publish",
      id: publishId,
      userId: adminId,
      role: "admin",
      requestId: `${P}fail-audit-publish`,
      body: { reason: "verify transactional pricing publish", confirmation: publishId },
    })).rejects.toThrow();
    await expect(prisma.pricingRule.findUnique({ where: { id: activeId } }))
      .resolves.toMatchObject({ status: "active" });
    await expect(prisma.pricingRule.findUnique({ where: { id: publishId } }))
      .resolves.toMatchObject({ status: "draft" });

    const rollbackPreviousId = `${P}audit-failure-rollback-previous`;
    const rollbackCurrentId = `${P}audit-failure-rollback-current`;
    const rollbackKey = `${P}audit-failure-rollback-key`;
    await seedPricingRule({ id: rollbackPreviousId, ruleKey: rollbackKey, baseCost: 40, status: "archived", version: 1 });
    await seedPricingRule({ id: rollbackCurrentId, ruleKey: rollbackKey, baseCost: 35, status: "active", version: 2 });
    await expect(ruleCommand(rollbackRoute, {
      method: "POST",
      suffix: "/rollback",
      id: rollbackCurrentId,
      userId: adminId,
      role: "admin",
      requestId: `${P}fail-audit-rollback`,
      body: { reason: "verify transactional pricing rollback", confirmation: rollbackCurrentId },
    })).rejects.toThrow();
    await expect(prisma.pricingRule.findUnique({ where: { id: rollbackPreviousId } }))
      .resolves.toMatchObject({ status: "archived" });
    await expect(prisma.pricingRule.findUnique({ where: { id: rollbackCurrentId } }))
      .resolves.toMatchObject({ status: "active" });
  });
});

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
