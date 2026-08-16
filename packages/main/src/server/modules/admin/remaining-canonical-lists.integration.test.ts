import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as auditLogRoute } from "@/app/api/v2/admin/audit-log/route";
import { GET as featureFlagsRoute } from "@/app/api/v2/admin/feature-flags/route";
import { prisma } from "@/server/lib/db";
import { handle } from "@/server/lib/http";
import { dispatchAdmin } from "./service";

// SPEC: 已迁到 v2 的清单经自己的 Route Handler 走，其余仍走 v1 dispatcher。
// INTENT: 这个文件同时覆盖十几个域，迁移是分批的 —— 一张表把「谁已经搬走了」写明，
//         比按域拆成十几个文件更容易看出还剩谁。
const migratedListRoutes: Record<string, (request: Request) => Promise<Response>> = {
  "audit-log": auditLogRoute,
  "feature-flags": featureFlagsRoute,
};

type PageInfo = { endCursor: string | null; hasNextPage: boolean };

describe("remaining canonical admin lists", () => {
  const suffix = randomUUID();
  const token = `remaining-${suffix}`;
  const actorId = `remaining-admin-${suffix}`;
  const ids = (kind: string) => [0, 1].map((index) => `${token}-${kind}-${index}`);

  async function call(segments: string[], query: string) {
    const migrated = segments.length === 1 ? migratedListRoutes[segments[0]!] : undefined;
    const request = new Request(
      `http://test.local/api/${migrated ? "v2" : "v1"}/admin/${segments.join("/")}?${query}`,
      { headers: { "x-idream-user-id": actorId, "x-idream-role": "admin" } },
    );
    const response = migrated
      ? await migrated(request)
      : await handle(() => dispatchAdmin(request, segments))(request);
    return { response, body: await response.json() as { data?: Record<string, unknown>; error?: unknown } };
  }

  beforeAll(async () => {
    await prisma.user.create({ data: { id: actorId, email: `${token}@example.test`, role: "admin", status: "active" } });
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
    await prisma.character.deleteMany({ where: { id: { in: ids("character") } } });
    await prisma.generationJob.deleteMany({ where: { id: { in: ids("job") } } });
    await prisma.user.deleteMany({ where: { id: actorId } });
    await prisma.$disconnect();
  });

  const cases = [
    { name: "dead-letter", segments: ["generation", "dead-letter"], query: `search=${token}&status=failed&limit=1` },
    { name: "merchandising characters", segments: ["content", "characters"], query: `search=${token}&status=approved&limit=1` },
    { name: "merchandising characters without stats", segments: ["content", "characters"], query: `search=${token}&status=approved&sort=popular&limit=1` },
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

  it("preserves unbounded V1 defaults while the Admin UI opts into pagination", async () => {
    for (const testCase of [
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

  it("rejects malformed canonical profile and flag queries at the boundary", async () => {
    await expect(call(["generation", "model-profiles"], "status=mystery")).resolves.toMatchObject({ response: { status: 400 } });
    await expect(call(["feature-flags"], "enabled=banana")).resolves.toMatchObject({ response: { status: 400 } });
  });

  it("rejects malformed Audit queries at the boundary", async () => {
    await expect(call(["audit-log"], "limit=1junk")).resolves.toMatchObject({ response: { status: 400 } });
    await expect(call(["audit-log"], "unknown=value")).resolves.toMatchObject({ response: { status: 400 } });
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
