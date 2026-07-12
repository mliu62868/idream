import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { listCases } from "./query";

describe("Admin Case authoritative search", () => {
  const suffix = randomUUID();
  const actorId = `case-search-actor-${suffix}`;
  const customerId = `case-search-customer-${suffix}`;
  const decoyCaseId = `case-search-decoy-${suffix}`;
  const targetCaseId = `case-search-target-${suffix}`;
  const needle = `complete-relation-${suffix}`;
  const supportRequestIds = Array.from(
    { length: 501 },
    (_, index) => `case-search-request-${index.toString().padStart(3, "0")}-${suffix}`,
  );
  const headers = {
    "x-idream-user-id": actorId,
    "x-idream-role": "support",
  };

  beforeAll(async () => {
    await prisma.user.createMany({
      data: [
        { id: actorId, email: `${actorId}@example.test`, role: "support", status: "active" },
        { id: customerId, email: `${customerId}@example.test`, role: "user", status: "active" },
      ],
    });
    await prisma.supportRequest.createMany({
      data: supportRequestIds.map((id, index) => ({
        id,
        ticketId: `CASE-SEARCH-${index.toString().padStart(3, "0")}-${suffix}`,
        userId: customerId,
        category: "technical",
        subject: `${needle} subject ${index}`,
        description: `${needle} description ${index}`,
        status: "open",
        priority: 2,
      })),
    });
    await prisma.adminCase.createMany({
      data: [
        {
          id: decoyCaseId,
          type: "support_request",
          targetType: "user",
          targetId: customerId,
          caseKey: `decoy-${suffix}`,
          status: "new",
          updatedAt: new Date("2026-07-12T10:00:00.000Z"),
        },
        {
          id: targetCaseId,
          type: "support_request",
          targetType: "user",
          targetId: customerId,
          caseKey: `target-${suffix}`,
          status: "new",
          updatedAt: new Date("2026-07-12T11:00:00.000Z"),
        },
      ],
    });
    await prisma.caseEvidence.createMany({
      data: supportRequestIds.map((sourceId, index) => ({
        caseId: index === supportRequestIds.length - 1 ? targetCaseId : decoyCaseId,
        sourceType: "support_request",
        sourceId,
        snapshot: { subject: `${needle} subject ${index}` },
        occurredAt: new Date("2026-07-12T09:00:00.000Z"),
      })),
    });
  });

  afterAll(async () => {
    await prisma.caseEvidence.deleteMany({ where: { caseId: { in: [decoyCaseId, targetCaseId] } } });
    await prisma.adminCase.deleteMany({ where: { id: { in: [decoyCaseId, targetCaseId] } } });
    await prisma.supportRequest.deleteMany({ where: { id: { in: supportRequestIds } } });
    await prisma.user.deleteMany({ where: { id: { in: [actorId, customerId] } } });
    await prisma.$disconnect();
  });

  it("finds a Case linked through the 501st matching Support Request and paginates every matching Case", async () => {
    const firstResponse = await listCases(new Request(
      `http://localhost/api/v2/admin/cases?view=all&search=${encodeURIComponent(needle)}&sort=updated_desc&limit=1`,
      { headers },
    ));
    const first = await firstResponse.json();

    expect(first.data.items.map((item: { id: string }) => item.id)).toEqual([targetCaseId]);
    expect(first.data.pageInfo).toMatchObject({ hasNextPage: true, endCursor: expect.any(String) });

    const secondResponse = await listCases(new Request(
      `http://localhost/api/v2/admin/cases?view=all&search=${encodeURIComponent(needle)}&sort=updated_desc&limit=1&cursor=${encodeURIComponent(first.data.pageInfo.endCursor)}`,
      { headers },
    ));
    const second = await secondResponse.json();

    expect(second.data.items.map((item: { id: string }) => item.id)).toEqual([decoyCaseId]);
    expect(second.data.pageInfo).toEqual({ hasNextPage: false, endCursor: null });
  });
});
