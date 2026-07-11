import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolvePermissions } from "@/server/admin/permissions";
import { prisma } from "@/server/lib/db";
import { buildTodayProjection, getTodayProjection } from "./query";

describe("Today authoritative projection", () => {
  const suffix = randomUUID();
  const actorId = `today-support-${suffix}`;
  const caseIds = Array.from({ length: 14 }, (_, index) => `today-case-${index}-${suffix}`);
  const incidentId = `today-incident-${suffix}`;
  const now = new Date("2026-07-11T12:00:00.000Z");

  beforeAll(async () => {
    await prisma.user.create({
      data: { id: actorId, email: `${actorId}@example.test`, role: "support", status: "active" },
    });
    await prisma.adminCase.createMany({
      data: [
        ...caseIds.slice(0, 12).map((id, index) => ({
          id,
          type: "support_request",
          targetType: "user",
          targetId: `customer-${index}`,
          caseKey: `support-${index}-${suffix}`,
          activeKey: `active-${index}-${suffix}`,
          status: "in_progress",
          priority: index === 0 ? "urgent" : "high",
          ownerId: actorId,
          slaDueAt: new Date("2026-07-11T18:00:00.000Z"),
          verificationState: "pending",
          createdAt: new Date("2026-07-10T12:00:00.000Z"),
          updatedAt: new Date("2026-07-11T11:00:00.000Z"),
        })),
        {
          id: caseIds[12],
          type: "support_request",
          targetType: "user",
          targetId: "unassigned-customer",
          caseKey: `unassigned-${suffix}`,
          activeKey: `unassigned-active-${suffix}`,
          status: "new",
          priority: "normal",
          ownerId: null,
          slaDueAt: new Date("2026-07-12T18:00:00.000Z"),
          verificationState: "pending",
          createdAt: new Date("2026-07-11T09:00:00.000Z"),
          updatedAt: new Date("2026-07-11T10:00:00.000Z"),
        },
        {
          id: caseIds[13],
          type: "support_request",
          targetType: "user",
          targetId: "resolved-customer",
          caseKey: `resolved-${suffix}`,
          status: "resolved",
          priority: "normal",
          ownerId: actorId,
          slaDueAt: new Date("2026-07-11T10:00:00.000Z"),
          resolution: { summary: "customer confirmed" },
          verificationState: "passed",
          createdAt: new Date("2026-07-10T09:00:00.000Z"),
          updatedAt: new Date("2026-07-11T11:30:00.000Z"),
        },
      ],
    });
    await prisma.opsIncident.create({
      data: {
        id: incidentId,
        signature: `support-linked-${suffix}`,
        signatureVersion: "v1",
        activeCorrelationKey: `today-correlation-${suffix}`,
        status: "mitigating",
        severity: "critical",
        ownerId: actorId,
        firstSeen: new Date("2026-07-11T08:00:00.000Z"),
        lastSeen: new Date("2026-07-11T11:30:00.000Z"),
        slaDueAt: new Date("2026-07-11T13:00:00.000Z"),
        impact: { affectedUsers: 4 },
        mitigation: { state: "active" },
        verificationState: "pending",
        createdAt: new Date("2026-07-11T08:00:00.000Z"),
        updatedAt: new Date("2026-07-11T11:30:00.000Z"),
      },
    });
    await prisma.operationalWorkPreference.createMany({
      data: [
        {
          actorId,
          sourceType: "admin_case",
          sourceId: caseIds[0],
          watching: true,
          pinned: true,
        },
        {
          actorId,
          sourceType: "admin_case",
          sourceId: caseIds[1],
          snoozedUntil: new Date("2026-07-12T12:00:00.000Z"),
        },
      ],
    });
  });

  afterAll(async () => {
    await prisma.operationalWorkPreference.deleteMany({ where: { actorId } });
    await prisma.opsIncident.deleteMany({ where: { id: incidentId } });
    await prisma.adminCase.deleteMany({ where: { id: { in: caseIds } } });
    await prisma.user.deleteMany({ where: { id: actorId } });
    await prisma.$disconnect();
  });

  it("separates complete counts from the ten displayed rows and preserves domain truth", async () => {
    const projection = await buildTodayProjection({
      actor: { id: actorId, role: "support" },
      permissions: resolvePermissions("support"),
      now,
    });

    expect(projection.myShift.totalCount).toBe(12);
    expect(projection.myShift.items).toHaveLength(10);
    expect(projection.nextBestActions.totalCount).toBe(13);
    expect(projection.nextBestActions.items).toHaveLength(10);
    expect(projection.unassigned).toMatchObject({ totalCount: 1 });
    expect(projection.watching).toMatchObject({ totalCount: 1 });
    expect(projection.recentlyResolved).toMatchObject({ totalCount: 1 });
    expect(projection.myShift.items[0]).toMatchObject({
      sourceType: "admin_case",
      sourceId: caseIds[0],
      ownerId: actorId,
      pinned: true,
      environment: "test",
      dataClass: "customer",
    });
    expect(projection.myShift.items.some((item) => item.sourceId === caseIds[1])).toBe(false);
    expect(projection.watching.items[0]?.deepLink).toBe(`/admin/cases/${caseIds[0]}`);
  });

  it("returns real empty queues when effective permissions expose no authoritative source", async () => {
    const projection = await buildTodayProjection({
      actor: { id: actorId, role: "analyst" },
      permissions: resolvePermissions("analyst"),
      now,
    });

    expect(projection.myShift).toEqual({ totalCount: 0, items: [] });
    expect(projection.nextBestActions).toEqual({ totalCount: 0, items: [] });
    expect(projection.watching).toEqual({ totalCount: 0, items: [] });
  });

  it("authenticates before returning the Today read model", async () => {
    const response = await getTodayProjection(new Request("http://localhost/api/v2/admin/today"));
    expect(response.status).toBe(401);
  });
});
