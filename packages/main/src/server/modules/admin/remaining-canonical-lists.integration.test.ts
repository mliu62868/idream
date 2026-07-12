import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { handle } from "@/server/lib/http";
import { dispatchAdmin } from "./service";

type PageInfo = { endCursor: string | null; hasNextPage: boolean };

describe("remaining canonical admin lists", () => {
  const suffix = randomUUID();
  const token = `remaining-${suffix}`;
  const actorId = `remaining-admin-${suffix}`;
  const planId = `remaining-plan-${suffix}`;
  const ids = (kind: string) => [0, 1].map((index) => `${token}-${kind}-${index}`);

  async function call(segments: string[], query: string) {
    const request = new Request(`http://test.local/api/v1/admin/${segments.join("/")}?${query}`, {
      headers: { "x-idream-user-id": actorId, "x-idream-role": "admin" },
    });
    const response = await handle(() => dispatchAdmin(request, segments))(request);
    return { response, body: await response.json() as { data?: Record<string, unknown>; error?: unknown } };
  }

  beforeAll(async () => {
    await prisma.user.create({ data: { id: actorId, email: `${token}@example.test`, role: "admin", status: "active" } });
    await prisma.plan.create({ data: {
      id: planId,
      slug: token,
      name: token,
      billingPeriod: "monthly",
      priceCents: 100,
      features: {},
    } });
    await prisma.dreamcoinLedger.createMany({ data: ids("ledger").map((id, index) => ({
      id,
      userId: actorId,
      delta: index + 1,
      balanceAfter: index + 1,
      reason: "admin_adjust",
      sourceId: token,
      createdAt: new Date(Date.UTC(2026, 6, 11, 1, index)),
    })) });
    await prisma.subscription.createMany({ data: ids("subscription").map((id, index) => ({
      id,
      userId: actorId,
      planId,
      provider: "mock",
      providerSubscriptionId: `${token}-provider-${index}`,
      status: "active",
      createdAt: new Date(Date.UTC(2026, 6, 11, 2, index)),
    })) });
    await prisma.pricingRule.createMany({ data: ids("pricing").map((id, index) => ({
      id,
      ruleKey: `${token}-rule-${index}`,
      label: `${token} pricing ${index}`,
      mode: "image",
      baseCost: index + 1,
      status: "draft",
      version: 1,
    })) });
    await prisma.generationJob.createMany({ data: ids("job").map((id, index) => ({
      id,
      userId: actorId,
      mode: "image",
      controls: {},
      presetIds: [],
      status: "failed",
      errorCode: `${token}-failure`,
      updatedAt: new Date(Date.UTC(2026, 6, 11, 3, index)),
    })) });
    await prisma.contentReport.createMany({ data: ids("report").map((id, index) => ({
      id,
      reporterId: actorId,
      targetType: "character",
      targetId: `${token}-target-${index}`,
      category: token,
      status: "open",
      priority: 3,
      createdAt: new Date(Date.UTC(2026, 6, 11, 4, index)),
    })) });
    await prisma.mediaAsset.createMany({ data: ids("media").map((id, index) => ({
      id,
      ownerId: actorId,
      type: "image",
      url: `memory://${id}`,
      safetyStatus: "blocked",
      metadata: { token },
      createdAt: new Date(Date.UTC(2026, 6, 11, 5, index)),
    })) });
    await prisma.appeal.createMany({ data: ids("appeal").map((id, index) => ({
      id,
      userId: actorId,
      targetType: "character",
      targetId: `${token}-appeal-target-${index}`,
      status: "open",
      appealText: token,
      createdAt: new Date(Date.UTC(2026, 6, 11, 6, index)),
    })) });
    await prisma.character.createMany({ data: ids("character").map((id, index) => ({
      id,
      creatorId: actorId,
      name: `${token} character ${index}`,
      age: 21,
      description: token,
      visibility: "public",
      status: "approved",
      appearance: {},
      advancedDetails: {},
      createdAt: new Date(Date.UTC(2026, 6, 11, 7, index)),
    })) });
    await prisma.redeemCode.createMany({ data: ids("code").map((id, index) => ({
      id,
      codeHash: `${token}-hash-${index}`,
      reward: { note: token },
      status: "active",
      createdAt: new Date(Date.UTC(2026, 6, 11, 8, index)),
    })) });
    await prisma.referral.createMany({ data: ids("referral").map((id, index) => ({
      id,
      inviterId: actorId,
      code: `${token}-ref-${index}`,
      status: "pending",
      createdAt: new Date(Date.UTC(2026, 6, 11, 9, index)),
    })) });
    await prisma.adminActionRequest.createMany({ data: ids("approval").map((id, index) => ({
      id,
      requestedById: actorId,
      permissionKey: "billing.read",
      action: `${token}.approve`,
      targetType: "test",
      targetId: `${token}-approval-target-${index}`,
      payload: {},
      status: "pending",
      reason: token,
      createdAt: new Date(Date.UTC(2026, 6, 11, 10, index)),
    })) });
    await prisma.adminAuditLog.createMany({ data: ids("audit").map((id, index) => ({
      id,
      actorId,
      actorRole: "admin",
      action: `${token}.action`,
      targetType: "test",
      targetId: `${token}-audit-target-${index}`,
      reason: token,
      createdAt: new Date(Date.UTC(2026, 6, 11, 11, index)),
    })) });
    await prisma.generationModelProfile.createMany({ data: ids("profile").map((id, index) => ({
      id,
      profileKey: `${token}-profile-${index}`,
      label: `${token} profile ${index}`,
      mode: "image",
      pipelineModel: "test-model",
      allowedOrientations: ["1:1"],
      status: "draft",
    })) });
    await prisma.featureFlag.createMany({ data: ids("flag").map((key) => ({
      key,
      label: `${token} flag`,
      description: token,
      enabled: false,
      targetRoles: [],
      targetPlans: [],
    })) });
  });

  afterAll(async () => {
    await prisma.featureFlag.deleteMany({ where: { key: { startsWith: token } } });
    await prisma.generationModelProfile.deleteMany({ where: { id: { in: ids("profile") } } });
    await prisma.adminAuditLog.deleteMany({ where: { id: { in: ids("audit") } } });
    await prisma.adminActionRequest.deleteMany({ where: { id: { in: ids("approval") } } });
    await prisma.referral.deleteMany({ where: { id: { in: ids("referral") } } });
    await prisma.redeemCode.deleteMany({ where: { id: { in: ids("code") } } });
    await prisma.character.deleteMany({ where: { id: { in: ids("character") } } });
    await prisma.appeal.deleteMany({ where: { id: { in: ids("appeal") } } });
    await prisma.contentReport.deleteMany({ where: { id: { in: ids("report") } } });
    await prisma.mediaAsset.deleteMany({ where: { id: { in: ids("media") } } });
    await prisma.generationJob.deleteMany({ where: { id: { in: ids("job") } } });
    await prisma.pricingRule.deleteMany({ where: { id: { in: ids("pricing") } } });
    await prisma.subscription.deleteMany({ where: { id: { in: ids("subscription") } } });
    await prisma.dreamcoinLedger.deleteMany({ where: { id: { in: ids("ledger") } } });
    await prisma.plan.deleteMany({ where: { id: planId } });
    await prisma.user.deleteMany({ where: { id: actorId } });
    await prisma.$disconnect();
  });

  const cases = [
    { name: "billing ledger", segments: ["billing", "ledger"], query: `search=${token}&limit=1` },
    { name: "subscriptions", segments: ["billing", "subscriptions"], query: `search=${token}&status=active&limit=1` },
    { name: "pricing", segments: ["pricing", "rules"], query: `search=${token}&mode=image&limit=1` },
    { name: "dead-letter", segments: ["generation", "dead-letter"], query: `search=${token}&status=failed&limit=1` },
    { name: "merchandising characters", segments: ["content", "characters"], query: `search=${token}&status=approved&limit=1` },
    { name: "merchandising characters without stats", segments: ["content", "characters"], query: `search=${token}&status=approved&sort=popular&limit=1` },
    { name: "redeem codes", segments: ["promo", "redeem-codes"], query: `search=${token}&status=active&limit=1` },
    { name: "referrals", segments: ["promo", "referrals"], query: `search=${token}&status=pending&limit=1` },
    { name: "approvals", segments: ["approvals"], query: `search=${token}&status=pending&limit=1` },
    { name: "audit", segments: ["audit-log"], query: `search=${token}&limit=1` },
    { name: "generation profiles", segments: ["generation", "model-profiles"], query: `search=${token}&mode=image&limit=1` },
    { name: "feature flags", segments: ["feature-flags"], query: `search=${token}&enabled=false&limit=1` },
  ] as const;

  for (const testCase of cases) {
    it(`paginates ${testCase.name} with server filters and a query-bound cursor`, async () => {
      const first = await call([...testCase.segments], testCase.query);
      expect(first.response.status, JSON.stringify(first.body)).toBe(200);
      const firstData = first.body.data as { items: Array<{ id?: string; key?: string }>; pageInfo: PageInfo };
      expect(firstData.items).toHaveLength(1);
      expect(firstData.pageInfo).toMatchObject({ hasNextPage: true, endCursor: expect.any(String) });

      const cursor = firstData.pageInfo.endCursor ?? "";
      const second = await call([...testCase.segments], `${testCase.query}&cursor=${encodeURIComponent(cursor)}`);
      expect(second.response.status, JSON.stringify(second.body)).toBe(200);
      const secondData = second.body.data as { items: Array<{ id?: string; key?: string }>; pageInfo: PageInfo };
      expect(secondData.items).toHaveLength(1);
      expect(secondData.items[0]?.id ?? secondData.items[0]?.key).not.toBe(firstData.items[0]?.id ?? firstData.items[0]?.key);

      const mismatch = await call([...testCase.segments], `${testCase.query.replace(token, "different")}&cursor=${encodeURIComponent(cursor)}`);
      expect(mismatch.response.status).toBe(400);
    });
  }

  it("paginates all three moderation collections independently", async () => {
    const first = await call(["moderation", "queue"], `search=${token}&limit=1`);
    expect(first.response.status, JSON.stringify(first.body)).toBe(200);
    const data = first.body.data as {
      reports: Array<{ id: string }>;
      blockedMedia: Array<{ id: string }>;
      appeals: Array<{ id: string }>;
      pageInfo: { reports: PageInfo; blockedMedia: PageInfo; appeals: PageInfo };
    };
    expect(data.reports).toHaveLength(1);
    expect(data.blockedMedia).toHaveLength(1);
    expect(data.appeals).toHaveLength(1);
    expect(data.pageInfo.reports.hasNextPage).toBe(true);
    expect(data.pageInfo.blockedMedia.hasNextPage).toBe(true);
    expect(data.pageInfo.appeals.hasNextPage).toBe(true);

    const second = await call(["moderation", "queue"], [
      `search=${token}`,
      "limit=1",
      `reportCursor=${encodeURIComponent(data.pageInfo.reports.endCursor ?? "")}`,
      `mediaCursor=${encodeURIComponent(data.pageInfo.blockedMedia.endCursor ?? "")}`,
      `appealCursor=${encodeURIComponent(data.pageInfo.appeals.endCursor ?? "")}`,
    ].join("&"));
    expect(second.response.status, JSON.stringify(second.body)).toBe(200);
    const secondData = second.body.data as typeof data;
    expect(secondData.reports[0]?.id).not.toBe(data.reports[0]?.id);
    expect(secondData.blockedMedia[0]?.id).not.toBe(data.blockedMedia[0]?.id);
    expect(secondData.appeals[0]?.id).not.toBe(data.appeals[0]?.id);
  });

  it("preserves unbounded V1 defaults while the Admin UI opts into pagination", async () => {
    for (const testCase of [
      { segments: ["pricing", "rules"], query: `search=${token}` },
      { segments: ["generation", "model-profiles"], query: `search=${token}` },
      { segments: ["feature-flags"], query: `search=${token}` },
    ]) {
      const result = await call(testCase.segments, testCase.query);
      expect(result.response.status, JSON.stringify(result.body)).toBe(200);
      const data = result.body.data as { items: unknown[]; pageInfo: PageInfo };
      expect(data.items).toHaveLength(2);
      expect(data.pageInfo).toEqual({ endCursor: null, hasNextPage: false });
    }
  });

  it("rejects malformed canonical pricing, profile, and flag queries at the boundary", async () => {
    await expect(call(["pricing", "rules"], "limit=1junk")).resolves.toMatchObject({ response: { status: 400 } });
    await expect(call(["generation", "model-profiles"], "status=mystery")).resolves.toMatchObject({ response: { status: 400 } });
    await expect(call(["feature-flags"], "enabled=banana")).resolves.toMatchObject({ response: { status: 400 } });
  });

  it("continues from encoded sort keys when the cursor row is deleted", async () => {
    const first = await call(["audit-log"], `search=${token}&limit=1`);
    const firstData = first.body.data as { items: Array<{ id: string }>; pageInfo: PageInfo };
    await prisma.adminAuditLog.delete({ where: { id: firstData.items[0]!.id } });

    const second = await call(
      ["audit-log"],
      `search=${token}&limit=1&cursor=${encodeURIComponent(firstData.pageInfo.endCursor ?? "")}`,
    );
    expect(second.response.status, JSON.stringify(second.body)).toBe(200);
    const secondData = second.body.data as { items: Array<{ id: string }> };
    expect(secondData.items).toHaveLength(1);
    expect(secondData.items[0]?.id).not.toBe(firstData.items[0]?.id);
  });
});
