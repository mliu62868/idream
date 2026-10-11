import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { getMetricQualityReport } from "./query";
import { GET as getMetrics } from "@/app/api/v2/admin/metrics/route";

describe("Metric v2 authorization", () => {
  const suffix = randomUUID();
  const growthOperatorId = `metric-growth-operator-${suffix}`;
  const deniedOperatorId = `metric-denied-operator-${suffix}`;
  const technicalOperatorId = `metric-technical-operator-${suffix}`;
  const customerId = `metric-quality-customer-${suffix}`;
  const sourceEventId = `metric-quality-signup-${suffix}`;

  beforeAll(async () => {
    await prisma.user.createMany({ data: [
      { id: growthOperatorId, email: `${growthOperatorId}@example.test`, role: "support" },
      { id: deniedOperatorId, email: `${deniedOperatorId}@example.test`, role: "support" },
      { id: technicalOperatorId, email: `${technicalOperatorId}@example.test`, role: "ops" },
      { id: customerId, email: `${customerId}@example.test`, role: "user" },
    ] });
    await prisma.adminUserGrantBundle.create({ data: {
      userId: growthOperatorId,
      bundleKey: "growth_operator",
      reason: "Metric authorization integration fixture",
      createdById: growthOperatorId,
    } });
  });

  afterAll(async () => {
    await prisma.customerSignupFact.deleteMany({ where: { userId: customerId } });
    await prisma.metricProjectionReceipt.deleteMany({ where: { sourceEventId } });
    await prisma.adminUserGrantBundle.deleteMany({ where: { userId: growthOperatorId } });
    await prisma.user.deleteMany({ where: { id: { in: [growthOperatorId, deniedOperatorId, technicalOperatorId, customerId] } } });
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
    const response = await getMetrics(new Request("http://localhost/api/v2/admin/metrics?asOf=2026-10-01T00:00:00.000Z", {
      headers: {
        "x-idream-user-id": technicalOperatorId,
        "x-idream-role": "ops",
      },
    }));
    expect(response.status).toBe(200);
    const envelope = await response.json() as { data: { definitions: unknown[]; cards: unknown[]; quality: unknown } };
    expect(envelope.data.definitions).toEqual([]);
    expect(envelope.data.cards).toEqual([]);
    const qualityResponse = await getMetricQualityReport(new Request("http://localhost/api/v2/admin/metrics/quality?asOf=2026-10-01T00:00:00.000Z", {
      headers: { "x-idream-user-id": technicalOperatorId, "x-idream-role": "ops" },
    }));
    expect(qualityResponse.status).toBe(200);
    expect(envelope.data.quality).toEqual((await qualityResponse.json()).data);
  });

  it("preserves certified source quality for technical operators when business cards are uncertified", async () => {
    const asOf = new Date("2026-10-01T00:00:00.000Z");
    const occurredAt = new Date(asOf.getTime() - 60_000);
    await prisma.customerSignupFact.create({ data: {
      userId: customerId, sourceService: "main", sourceEventId,
      environment: "production", dataClass: "customer", trustClass: "canonical",
      actorIsInternal: false, eligible: true, occurredAt, validFrom: occurredAt,
    } });
    await prisma.metricProjectionReceipt.create({ data: {
      sourceService: "main", sourceEventId, canonicalEventId: sourceEventId,
      eventType: "customer.signup.completed.v2", outcome: "applied", factType: "customer_signup_fact",
      occurredAt, processedAt: new Date(occurredAt.getTime() + 1_000),
    } });
    const at = `?asOf=${asOf.toISOString()}`;
    const qualityResponse = await getMetricQualityReport(new Request(`http://localhost/api/v2/admin/metrics/quality${at}`, {
      headers: { "x-idream-user-id": technicalOperatorId, "x-idream-role": "ops" },
    }));
    expect(qualityResponse.status).toBe(200);
    const quality = (await qualityResponse.json()).data;
    expect(quality).toMatchObject({ qualityState: "certified", scannedFactCount: 1, eventLagP95Ms: 1_000 });

    // The same source facts cannot certify business-card definitions and snapshots.
    const businessResponse = await getMetrics(new Request(`http://localhost/api/v2/admin/metrics${at}`, {
      headers: { "x-idream-user-id": growthOperatorId, "x-idream-role": "support" },
    }));
    expect(businessResponse.status).toBe(200);
    const business = (await businessResponse.json()).data;
    expect(business.cards.length).toBeGreaterThan(0);
    expect(business.cards.every((card: { decisionUse: string }) => card.decisionUse === "blocked")).toBe(true);
    expect(business.quality.qualityState).toBe("invalid");

    const technicalResponse = await getMetrics(new Request(`http://localhost/api/v2/admin/metrics${at}`, {
      headers: { "x-idream-user-id": technicalOperatorId, "x-idream-role": "ops" },
    }));
    expect(technicalResponse.status).toBe(200);
    const technical = (await technicalResponse.json()).data;
    expect(technical).toMatchObject({ definitions: [], cards: [], freshness: "fresh" });
    expect(technical.quality).toEqual(quality);
  });
});
