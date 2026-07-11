import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_METRIC_REGISTRY, metricDashboardResponseSchema, metricQualityReportSchema, metricReconciliationReportSchema } from "@idream/shared/admin";
import { prisma } from "@/server/lib/db";
import { projectCanonicalMetricEvent } from "./projector";
import {
  getMetricDashboard,
  getMetricQualityReport,
  getMetricReconciliationReport,
  publishMetricRegistrySnapshots,
} from "./query";

describe("Admin v2 canonical metrics query", () => {
  const prefix = `metric-query-${randomUUID()}`;
  const analystId = `${prefix}-analyst`;
  const customerId = `${prefix}-customer`;
  const eventId = `${prefix}-signup`;

  beforeAll(async () => {
    await prisma.user.createMany({ data: [
      { id: analystId, email: `${analystId}@example.test`, role: "analyst", status: "active" },
      { id: customerId, email: `${customerId}@example.test`, role: "user", status: "active" },
    ] });
    await projectCanonicalMetricEvent(prisma, {
      id: eventId,
      sourceService: "main",
      sourceEventId: eventId,
      name: "customer.signup.completed.v2",
      schemaVersion: 2,
      occurredAt: new Date("2026-07-12T00:00:00Z"),
      ingestedAt: new Date("2026-07-12T00:00:01Z"),
      environment: "production",
      dataClass: "customer",
      trustClass: "canonical",
      actor: { userId: customerId, isInternal: false },
      context: {},
      props: { userId: customerId },
    });
  });

  afterAll(async () => {
    await prisma.dataQualityCheck.deleteMany({ where: { checkKey: { startsWith: "metrics." } } });
    await prisma.metricSnapshot.deleteMany({ where: { metricKey: { in: ADMIN_METRIC_REGISTRY.map((row) => row.key) } } });
    await prisma.metricDefinitionSnapshot.deleteMany({ where: { key: { in: ADMIN_METRIC_REGISTRY.map((row) => row.key) } } });
    await prisma.metricProjectionReceipt.deleteMany({ where: { sourceEventId: { startsWith: prefix } } });
    await prisma.customerSignupFact.deleteMany({ where: { userId: { startsWith: prefix } } });
    await prisma.user.deleteMany({ where: { id: { in: [analystId, customerId] } } });
    await prisma.$disconnect();
  });

  function request(path: string, authenticated = true) {
    return new Request(`http://localhost${path}`, authenticated ? {
      headers: { "x-idream-user-id": analystId, "x-idream-role": "analyst" },
    } : undefined);
  }

  it("fails closed when facts exist but no persisted certification authority exists", async () => {
    const response = await getMetricDashboard(request("/api/v2/admin/metrics?asOf=2026-08-20T00:00:00.000Z"));
    expect(response.status).toBe(200);
    const body = await response.json();
    const parsed = metricDashboardResponseSchema.parse(body.data);
    const byKey = Object.fromEntries(parsed.cards.map((card) => [card.key, card]));

    expect(byKey["activation.chat_24h"]).toMatchObject({
      numeratorValue: 0,
      denominatorValue: 1,
      value: null,
      sampleSize: 1,
      matureSampleSize: 1,
      maturity: "mature",
      definitionVersion: 1,
      timezone: "UTC",
      qualityState: "invalid",
      decisionUse: "blocked",
    });
    expect(byKey["activation.chat_24h"].qualityEvidence).toContain("definition_snapshot_missing");
    expect(byKey["conversion.paid_d30"]).toMatchObject({ numeratorValue: 0, denominatorValue: 1, value: null });
    expect(byKey["retention.same_character_d1"]).toMatchObject({
      denominatorValue: 0,
      value: null,
      maturity: "insufficient_data",
    });
    expect(byKey["north_star.wpcu"]).toMatchObject({ publicationStatus: "official" });
    expect(byKey["north_star.wscu"]).toMatchObject({
      publicationStatus: "shadow",
      qualityState: "invalid",
      decisionUse: "blocked",
    });
    expect(parsed.quality.qualityState).toBe("invalid");
    expect(parsed.freshness).toBe("degraded");
    expect(parsed.definitions.find((row) => row.key === "north_star.wscu")?.decisionGate).toBe("NS-01");
    expect(parsed.asOf).toBe("2026-08-20T00:00:00.000Z");
  });

  it("fails closed for unauthenticated callers", async () => {
    expect((await getMetricDashboard(request("/api/v2/admin/metrics", false))).status).toBe(401);
  });

  it("publishes immutable registry snapshots and exposes the reconciliation quality report", async () => {
    const first = await publishMetricRegistrySnapshots(prisma);
    const second = await publishMetricRegistrySnapshots(prisma);
    expect(first.created).toBeGreaterThan(0);
    expect(second).toEqual({ created: 0, existing: ADMIN_METRIC_REGISTRY.length });

    const response = await getMetricQualityReport(request("/api/v2/admin/metrics/quality"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(metricQualityReportSchema.parse(body.data)).toMatchObject({
      duplicateEffectCount: 0,
      impossibleStateCount: 0,
      fixtureInternalLeakageCount: 0,
      userJoinCoverage: 1,
    });
    const reconciliationResponse = await getMetricReconciliationReport(
      request("/api/v2/admin/metrics/reconciliation"),
    );
    expect(reconciliationResponse.status).toBe(200);
    const reconciliationBody = await reconciliationResponse.json();
    expect(metricReconciliationReportSchema.parse(reconciliationBody.data)).toMatchObject({
      quality: { duplicateEffectCount: 0, impossibleStateCount: 0 },
    });
  });
});
