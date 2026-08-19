import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { adminV2 } from "@/server/test/admin-v2-http";

type PageInfo = { endCursor: string | null; hasNextPage: boolean };

describe("Admin v2 approvals list", () => {
  const suffix = randomUUID();
  const token = `approvals-list-${suffix}`;
  const actorId = `approvals-list-admin-${suffix}`;
  const ids = [0, 1].map((index) => `${token}-approval-${index}`);

  beforeAll(async () => {
    await prisma.user.create({
      data: { id: actorId, email: `${token}@example.test`, role: "admin", status: "active" },
    });
    await prisma.adminActionRequest.createMany({ data: ids.map((id, index) => ({
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
  });

  afterAll(async () => {
    await prisma.adminActionRequest.deleteMany({ where: { id: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: actorId } });
    await prisma.$disconnect();
  });

  function list(query: Record<string, string | number>) {
    return adminV2("GET", "approvals", { userId: actorId, role: "admin", query });
  }

  it("paginates with server filters and a query-bound cursor", async () => {
    const first = await list({ search: token, status: "pending", limit: 1 });
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    const firstData = first.data as { items: Array<{ id: string }>; pageInfo: PageInfo };
    expect(firstData.items).toHaveLength(1);
    expect(firstData.pageInfo).toMatchObject({ hasNextPage: true, endCursor: expect.any(String) });

    const cursor = firstData.pageInfo.endCursor ?? "";
    const second = await list({ search: token, status: "pending", limit: 1, cursor });
    expect(second.status, JSON.stringify(second.json)).toBe(200);
    const secondData = second.data as typeof firstData;
    expect(secondData.items).toHaveLength(1);
    expect(secondData.items[0]?.id).not.toBe(firstData.items[0]?.id);

    const mismatch = await list({ search: "different", status: "pending", limit: 1, cursor });
    expect(mismatch.status).toBe(400);
  });
});
