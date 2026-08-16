import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { adminV2 as adminV2Api } from "@/server/test/admin-v2-http";

// SPEC: 跨多个域抽查「服务端过滤 + 查询绑定游标」这一条清单契约。
// INTENT: 断言的是共享分页原语（list-cursor 的 queryIdentity 绑定、queryParams 的边界 400）
//         的性质，不是某个资源自己的性质 —— 所以它按契约聚在一起，而不是拆进各域的测试。
//         v1 dispatcher 已经删除，这里全部经各自的 Admin v2 Route Handler。
type PageInfo = { endCursor: string | null; hasNextPage: boolean };

describe("remaining canonical admin lists", () => {
  const suffix = randomUUID();
  const token = `remaining-${suffix}`;
  const actorId = `remaining-admin-${suffix}`;
  const ids = (kind: string) => [0, 1].map((index) => `${token}-${kind}-${index}`);

  type ListEnvelope = { data?: Record<string, unknown>; error?: unknown };

  async function call(path: string, query: string) {
    const result = await adminV2Api("GET", `${path}?${query}`, {
      userId: actorId,
      role: "admin",
    });
    return { status: result.status, body: result.json as ListEnvelope };
  }

  beforeAll(async () => {
    await prisma.user.create({ data: { id: actorId, email: `${token}@example.test`, role: "admin", status: "active" } });
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
    await prisma.adminAuditLog.deleteMany({ where: { id: { in: ids("audit") } } });
    await prisma.character.deleteMany({ where: { id: { in: ids("character") } } });
    await prisma.user.deleteMany({ where: { id: actorId } });
    await prisma.$disconnect();
  });

  const cases = [
    { name: "merchandising characters", path: "/api/v2/admin/content/characters", query: `search=${token}&status=approved&limit=1` },
    { name: "merchandising characters without stats", path: "/api/v2/admin/content/characters", query: `search=${token}&status=approved&sort=popular&limit=1` },
    { name: "audit", path: "/api/v2/admin/audit-log", query: `search=${token}&limit=1` },
    { name: "feature flags", path: "/api/v2/admin/feature-flags", query: `search=${token}&enabled=false&limit=1` },
  ] as const;

  for (const testCase of cases) {
    it(`paginates ${testCase.name} with server filters and a query-bound cursor`, async () => {
      const first = await call(testCase.path, testCase.query);
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      const firstData = first.body.data as { items: Array<{ id?: string; key?: string }>; pageInfo: PageInfo };
      expect(firstData.items).toHaveLength(1);
      expect(firstData.pageInfo).toMatchObject({ hasNextPage: true, endCursor: expect.any(String) });

      const cursor = firstData.pageInfo.endCursor ?? "";
      const second = await call(testCase.path, `${testCase.query}&cursor=${encodeURIComponent(cursor)}`);
      expect(second.status, JSON.stringify(second.body)).toBe(200);
      const secondData = second.body.data as { items: Array<{ id?: string; key?: string }>; pageInfo: PageInfo };
      expect(secondData.items).toHaveLength(1);
      expect(secondData.items[0]?.id ?? secondData.items[0]?.key).not.toBe(firstData.items[0]?.id ?? firstData.items[0]?.key);

      const mismatch = await call(testCase.path, `${testCase.query.replace(token, "different")}&cursor=${encodeURIComponent(cursor)}`);
      expect(mismatch.status).toBe(400);
    });
  }

  it("preserves unbounded list defaults while the Admin UI opts into pagination", async () => {
    const result = await call("/api/v2/admin/feature-flags", `search=${token}`);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const data = result.body.data as { items: unknown[]; pageInfo: PageInfo };
    expect(data.items).toHaveLength(2);
    expect(data.pageInfo).toEqual({ endCursor: null, hasNextPage: false });
  });

  it("rejects malformed canonical flag queries at the boundary", async () => {
    await expect(call("/api/v2/admin/feature-flags", "enabled=banana")).resolves.toMatchObject({ status: 400 });
  });

  it("rejects malformed Audit queries at the boundary", async () => {
    await expect(call("/api/v2/admin/audit-log", "limit=1junk")).resolves.toMatchObject({ status: 400 });
    await expect(call("/api/v2/admin/audit-log", "unknown=value")).resolves.toMatchObject({ status: 400 });
  });

  it("continues from encoded sort keys when the cursor row is deleted", async () => {
    const first = await call("/api/v2/admin/audit-log", `search=${token}&limit=1`);
    const firstData = first.body.data as { items: Array<{ id: string }>; pageInfo: PageInfo };
    await prisma.adminAuditLog.delete({ where: { id: firstData.items[0]!.id } });

    const second = await call(
      "/api/v2/admin/audit-log",
      `search=${token}&limit=1&cursor=${encodeURIComponent(firstData.pageInfo.endCursor ?? "")}`,
    );
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    const secondData = second.body.data as { items: Array<{ id: string }> };
    expect(secondData.items).toHaveLength(1);
    expect(secondData.items[0]?.id).not.toBe(firstData.items[0]?.id);
  });
});
