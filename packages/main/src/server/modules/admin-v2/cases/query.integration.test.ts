import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { listCases } from "./query";
import { adminCaseActiveKey } from "./service";

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
          activeKey: adminCaseActiveKey(
            "support_request",
            "user",
            customerId,
            `decoy-${suffix}`,
          ),
          status: "new",
          updatedAt: new Date("2026-07-12T10:00:00.000Z"),
        },
        {
          id: targetCaseId,
          type: "support_request",
          targetType: "user",
          targetId: customerId,
          caseKey: `target-${suffix}`,
          activeKey: adminCaseActiveKey(
            "support_request",
            "user",
            customerId,
            `target-${suffix}`,
          ),
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

describe("Admin Case queue scope", () => {
  const suffix = randomUUID();
  const actorId = `case-scope-actor-${suffix}`;
  const customerId = `case-scope-customer-${suffix}`;
  const fixtureUserId = `case-scope-fixture-${suffix}`;
  const openCaseId = `case-scope-open-${suffix}`;
  const resolvedCaseId = `case-scope-resolved-${suffix}`;
  const fixtureCaseId = `case-scope-fixture-case-${suffix}`;
  const headers = { "x-idream-user-id": actorId, "x-idream-role": "support" };
  // Far-future updatedAt keeps these rows at the top of updated_desc regardless of other test data.
  const future = (minute: number) => new Date(`2099-01-01T00:0${minute}:00.000Z`);
  const supportCase = (id: string, targetId: string, status: string, minute: number) => ({
    id,
    type: "support_request",
    targetType: "user",
    targetId,
    caseKey: `${id}-key`,
    activeKey: status === "resolved" ? null : adminCaseActiveKey("support_request", "user", targetId, `${id}-key`),
    status,
    ownerId: null,
    updatedAt: future(minute),
  });

  beforeAll(async () => {
    await prisma.user.createMany({
      data: [
        { id: actorId, email: `${actorId}@example.test`, role: "support", status: "active" },
        { id: customerId, email: `${customerId}@example.test`, role: "user", status: "active" },
        { id: fixtureUserId, email: `${fixtureUserId}@example.test`, role: "user", status: "active", dataClass: "fixture" },
      ],
    });
    await prisma.adminCase.createMany({
      data: [
        supportCase(openCaseId, customerId, "new", 1),
        supportCase(resolvedCaseId, customerId, "resolved", 2),
        supportCase(fixtureCaseId, fixtureUserId, "new", 3),
      ],
    });
  });

  afterAll(async () => {
    await prisma.adminCase.deleteMany({ where: { id: { in: [openCaseId, resolvedCaseId, fixtureCaseId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [actorId, customerId, fixtureUserId] } } });
    await prisma.$disconnect();
  });

  async function ids(params: string) {
    const response = await listCases(new Request(`http://localhost/api/v2/admin/cases?${params}&limit=3`, { headers }));
    const body = await response.json();
    return body.data.items.map((item: { id: string }) => item.id);
  }

  it("keeps terminal and fixture-subject cases out of the unassigned work queue", async () => {
    // The fixture and resolved rows are newer, so they would lead the page if they leaked in.
    expect((await ids("view=unassigned"))[0]).toBe(openCaseId);
    expect(await ids(`view=unassigned&search=${suffix}`)).toEqual([openCaseId]);
  });

  it("keeps resolved cases in the all view but never fixture subjects", async () => {
    expect((await ids("view=all")).slice(0, 2)).toEqual([resolvedCaseId, openCaseId]);
    expect(await ids(`view=all&search=${suffix}`)).toEqual([resolvedCaseId, openCaseId]);
  });
});
