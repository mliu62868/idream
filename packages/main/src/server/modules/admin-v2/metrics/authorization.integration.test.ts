import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { GET as getMetrics } from "@/app/api/v2/admin/metrics/route";

describe("Metric v2 authorization", () => {
  const suffix = randomUUID();
  const growthOperatorId = `metric-growth-operator-${suffix}`;
  const deniedOperatorId = `metric-denied-operator-${suffix}`;
  const technicalOperatorId = `metric-technical-operator-${suffix}`;

  beforeAll(async () => {
    await prisma.user.createMany({ data: [
      { id: growthOperatorId, email: `${growthOperatorId}@example.test`, role: "support" },
      { id: deniedOperatorId, email: `${deniedOperatorId}@example.test`, role: "support" },
      { id: technicalOperatorId, email: `${technicalOperatorId}@example.test`, role: "ops" },
    ] });
    await prisma.adminUserGrantBundle.create({ data: {
      userId: growthOperatorId,
      bundleKey: "growth_operator",
      reason: "Metric authorization integration fixture",
      createdById: growthOperatorId,
    } });
  });

  afterAll(async () => {
    await prisma.adminUserGrantBundle.deleteMany({ where: { userId: growthOperatorId } });
    await prisma.user.deleteMany({ where: { id: { in: [growthOperatorId, deniedOperatorId, technicalOperatorId] } } });
    await prisma.$disconnect();
  });

  function request(userId: string) {
    return new Request("http://localhost/api/v2/admin/metrics", {
      headers: {
        "x-idream-user-id": userId,
        "x-idream-role": "support",
      },
    });
  }

  it("accepts the v2 growth_operator grant and rejects an operator without metric read", async () => {
    const response = await getMetrics(request(growthOperatorId));
    expect(response.status).toBe(200);
    const envelope = await response.json() as { data: { definitions: unknown[]; cards: unknown[] } };
    expect(envelope.data.definitions.length).toBeGreaterThan(0);
    expect(envelope.data.cards.length).toBeGreaterThan(0);
    await expect(getMetrics(request(deniedOperatorId))).resolves.toMatchObject({ status: 403 });
  });

  it("limits the base ops role to technical quality evidence", async () => {
    const response = await getMetrics(new Request("http://localhost/api/v2/admin/metrics", {
      headers: {
        "x-idream-user-id": technicalOperatorId,
        "x-idream-role": "ops",
      },
    }));
    expect(response.status).toBe(200);
    const envelope = await response.json() as { data: { definitions: unknown[]; cards: unknown[]; quality: unknown } };
    expect(envelope.data.definitions).toEqual([]);
    expect(envelope.data.cards).toEqual([]);
    expect(envelope.data.quality).toBeTruthy();
  });
});
