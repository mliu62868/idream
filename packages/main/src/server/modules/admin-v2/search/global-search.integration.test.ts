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
  const characterId = `global-search-character-${suffix}`;

  beforeAll(async () => {
    await prisma.user.createMany({ data: [
      { id: adminId, email: `${adminId}@idream.internal`, role: "admin", status: "active" },
      { id: supportId, email: `${supportId}@idream.internal`, role: "support", status: "active" },
      { id: customerId, email: `${term.toLowerCase()}@customer.local`, displayName: `${term} Customer`, role: "user", status: "active" },
    ] });
    await prisma.character.create({ data: {
      id: characterId,
      creatorId: customerId,
      name: `${term} Character`,
      age: 24,
      description: "Global search authority fixture",
      visibility: "public",
      status: "approved",
      appearance: {},
      advancedDetails: {},
    } });
  });

  afterAll(async () => {
    await prisma.character.delete({ where: { id: characterId } });
    await prisma.user.deleteMany({ where: { id: { in: [adminId, supportId, customerId] } } });
    await prisma.$disconnect();
  });

  async function search(userId: string, role: string) {
    const response = await globalAdminSearch(new Request(`http://localhost/api/v2/admin/search?q=${term}&limit=10`, {
      headers: { "x-idream-user-id": userId, "x-idream-role": role },
    }));
    return response.json();
  }

  it("returns only domains present in the actor's effective permissions", async () => {
    const admin = await search(adminId, "admin");
    expect(admin.data.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "customer", id: customerId }),
      expect.objectContaining({ kind: "character", id: characterId }),
    ]));
    const support = await search(supportId, "support");
    expect(support.data.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "customer", id: customerId }),
    ]));
    expect(support.data.items.some((item: { kind: string }) => item.kind === "character")).toBe(false);
  });
});
