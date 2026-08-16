import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { globalAdminSearch } from "./global-search";

describe("permission-trimmed global Admin search", () => {
  const suffix = randomUUID();
  const term = `SearchNeedle${suffix.slice(0, 8)}`;
  const adminId = `global-search-admin-${suffix}`;
  const supportId = `global-search-support-${suffix}`;
  const customerId = `global-search-customer-${suffix}`;
  const fixtureCustomerId = `global-search-fixture-customer-${suffix}`;
  const characterId = `global-search-character-${suffix}`;
  // 一个中文词 + 一个只在 id 中段出现的片段，验证 ILIKE '%…%' 的召回范围。
  const cjkTerm = "夜莺歌手";
  const cjkCharacterId = `global-search-cjk-${suffix}`;
  // 客户比角色多，且都比角色新 —— 改造前按新鲜度截断会把角色全挤掉。
  const crowdTerm = `CrowdNeedle${suffix.slice(0, 8)}`;
  const crowdCustomerIds = Array.from({ length: 6 }, (_, index) => `global-search-crowd-customer-${index}-${suffix}`);
  const crowdCharacterId = `global-search-crowd-character-${suffix}`;

  beforeAll(async () => {
    await prisma.user.createMany({ data: [
      { id: adminId, email: `${adminId}@idream.internal`, role: "admin", status: "active", dataClass: "internal" },
      { id: supportId, email: `${supportId}@idream.internal`, role: "support", status: "active", dataClass: "internal" },
      { id: customerId, email: `${term.toLowerCase()}@customer.invalid`, displayName: `${term} Customer`, role: "user", status: "active", dataClass: "customer" },
      { id: fixtureCustomerId, email: `${term.toLowerCase()}-fixture@example.test`, displayName: `${term} Fixture`, role: "user", status: "active", dataClass: "fixture" },
      ...crowdCustomerIds.map((id) => ({ id, email: `${id}@customer.invalid`, displayName: `${crowdTerm} Customer`, role: "user", status: "active", dataClass: "customer" })),
    ] });
    const characterFixture = {
      creatorId: customerId,
      age: 24,
      description: "Global search authority fixture",
      visibility: "public",
      status: "approved",
      appearance: {},
      advancedDetails: {},
    } as const;
    await prisma.character.create({ data: { ...characterFixture, id: characterId, name: `${term} Character` } });
    await prisma.character.create({ data: { ...characterFixture, id: cjkCharacterId, name: `${cjkTerm}·测试角色` } });
    await prisma.character.create({ data: { ...characterFixture, id: crowdCharacterId, name: `${crowdTerm} Character` } });
    // 角色比所有客户旧，所以只有公平分配才能让它进结果。
    await prisma.character.update({
      where: { id: crowdCharacterId },
      data: { updatedAt: new Date(Date.now() - 60 * 60 * 1000) },
    });
  });

  afterAll(async () => {
    await prisma.character.deleteMany({ where: { id: { in: [characterId, cjkCharacterId, crowdCharacterId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [adminId, supportId, customerId, fixtureCustomerId, ...crowdCustomerIds] } } });
    await prisma.$disconnect();
  });

  async function search(userId: string, role: string, q = term, limit = 10) {
    const response = await globalAdminSearch(new Request(
      `http://localhost/api/v2/admin/search?q=${encodeURIComponent(q)}&limit=${limit}`,
      { headers: { "x-idream-user-id": userId, "x-idream-role": role } },
    ));
    return response.json();
  }

  it("returns only domains present in the actor's effective permissions", async () => {
    const admin = await search(adminId, "admin");
    expect(admin.data.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "customer", id: customerId }),
      expect.objectContaining({ kind: "character", id: characterId }),
    ]));
    expect(admin.data.items).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "customer", id: fixtureCustomerId }),
    ]));
    const support = await search(supportId, "support");
    expect(support.data.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "customer", id: customerId }),
    ]));
    expect(support.data.items.some((item: { kind: string }) => item.kind === "character")).toBe(false);
  });

  it("keeps a busier entity kind from crowding every other kind out of the page", async () => {
    const result = await search(adminId, "admin", crowdTerm, 4);
    expect(result.data.items).toHaveLength(4);
    expect(result.data.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "character", id: crowdCharacterId }),
    ]));
    // 展示顺序仍然是新鲜度优先，只是选取时先保证了每类都有位置。
    const timestamps = result.data.items.map((item: { updatedAt: string }) => item.updatedAt);
    expect([...timestamps].sort((left, right) => right.localeCompare(left))).toEqual(timestamps);
  });

  it("recalls a Chinese substring and an id fragment, not just a prefix", async () => {
    const cjk = await search(adminId, "admin", "歌手");
    expect(cjk.data.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "character", id: cjkCharacterId }),
    ]));

    const fragment = await search(adminId, "admin", suffix.slice(9, 17));
    expect(fragment.data.items.some((item: { id: string }) => item.id === characterId)).toBe(true);
  });
});
