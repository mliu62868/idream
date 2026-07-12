import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_METRIC_REGISTRY, metricDashboardResponseSchema, metricQualityReportSchema, metricReconciliationReportSchema } from "@idream/shared/admin";
import { prisma } from "@/server/lib/db";
import { projectCanonicalMetricEvent } from "./projector";
import {
  getMetricDashboard,
  getMetricQualityReport,
  getMetricReconciliationReport,
  materializeMetricSnapshots,
  publishMetricRegistrySnapshots,
  selectQualityChecksForMetric,
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
    await prisma.aiUsageFact.deleteMany({ where: { sourceEventId: { startsWith: prefix } } });
    await prisma.user.deleteMany({ where: { id: { in: [analystId, customerId] } } });
    await prisma.$disconnect();
  });

  function request(path: string, authenticated = true) {
    return new Request(`http://localhost${path}`, authenticated ? {
      headers: { "x-idream-user-id": analystId, "x-idream-role": "analyst" },
    } : undefined);
  }

  it("keeps a metric blocked while any quarantine in the quality window remains unresolved", () => {
    const metricKey = "activation.generation_7d";
    const checks = selectQualityChecksForMetric([
      {
        checkKey: "metrics.server_outcome_completeness",
        status: "failed",
        metricKeys: [metricKey],
        checkedAt: new Date("2026-07-11T12:00:00Z"),
        evidence: { sourceEventId: "still-unresolved" },
        source: "still-unresolved",
      },
      {
        checkKey: "metrics.server_outcome_completeness",
        status: "passed",
        metricKeys: [metricKey],
        checkedAt: new Date("2026-07-11T12:05:00Z"),
        evidence: { sourceEventId: "resolved" },
        source: "newer-but-only-one-resolved",
      },
    ], metricKey);

    expect(checks.get("metrics.server_outcome_completeness")).toMatchObject({
      status: "failed",
      source: "still-unresolved",
    });
  });

  it("lets a newer materialized passed state supersede an older aggregate failure", () => {
    const metricKey = "activation.generation_7d";
    const checks = selectQualityChecksForMetric([
      {
        checkKey: "metrics.server_outcome_completeness",
        status: "failed",
        metricKeys: [metricKey],
        checkedAt: new Date("2026-07-11T12:00:00Z"),
        evidence: { asOf: "2026-07-11T12:00:00.000Z" },
      },
      {
        checkKey: "metrics.server_outcome_completeness",
        status: "passed",
        metricKeys: [metricKey],
        checkedAt: new Date("2026-07-11T12:10:00Z"),
        evidence: { asOf: "2026-07-11T12:10:00.000Z" },
      },
    ], metricKey);

    expect(checks.get("metrics.server_outcome_completeness")).toMatchObject({ status: "passed" });
  });

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

  it("publishes complete provider cost while failing closed for unavailable cash margin", async () => {
    await prisma.aiUsageFact.createMany({
      data: [
        {
          source: "chat",
          provider: "test-provider",
          model: "test-model",
          usage: { inputTokens: 10, outputTokens: 20 },
          costMicros: BigInt(125),
          pricingVersion: "test-v1",
          sourceService: "main",
          sourceEventId: `${prefix}-usage-priced-1`,
          environment: "production",
          dataClass: "customer",
          trustClass: "canonical",
          actorIsInternal: false,
          occurredAt: new Date("2026-08-19T00:00:00.000Z"),
        },
        {
          source: "generation",
          provider: "test-provider",
          model: "test-model",
          usage: { images: 1 },
          costMicros: BigInt(375),
          pricingVersion: "test-v1",
          sourceService: "main",
          sourceEventId: `${prefix}-usage-priced-2`,
          environment: "production",
          dataClass: "customer",
          trustClass: "canonical",
          actorIsInternal: false,
          occurredAt: new Date("2026-08-19T01:00:00.000Z"),
        },
      ],
    });

    const response = await getMetricDashboard(request("/api/v2/admin/metrics?asOf=2026-08-20T00:00:00.000Z"));
    const body = await response.json();
    const parsed = metricDashboardResponseSchema.parse(body.data);
    const byKey = Object.fromEntries(parsed.cards.map((card) => [card.key, card]));

    expect(byKey["cost.provider_variable_7d"]).toMatchObject({
      value: 500,
      numeratorValue: 500,
      sampleSize: 2,
      matureSampleSize: 2,
      maturity: "mature",
      qualityState: "directional",
      decisionUse: "directional_only",
    });
    expect(byKey["margin.character_contribution_7d"]).toMatchObject({
      value: null,
      qualityState: "invalid",
      decisionUse: "blocked",
    });
  });

  it("does not report a partial provider cost when pricing coverage is incomplete", async () => {
    await prisma.aiUsageFact.create({
      data: {
        source: "chat",
        provider: "test-provider",
        model: "unpriced-model",
        usage: { inputTokens: 1 },
        costMicros: null,
        sourceService: "main",
        sourceEventId: `${prefix}-usage-unpriced`,
        environment: "production",
        dataClass: "customer",
        trustClass: "canonical",
        actorIsInternal: false,
        occurredAt: new Date("2026-08-19T02:00:00.000Z"),
      },
    });

    const response = await getMetricDashboard(request("/api/v2/admin/metrics?asOf=2026-08-20T00:00:00.000Z"));
    const body = await response.json();
    const parsed = metricDashboardResponseSchema.parse(body.data);
    expect(parsed.cards.find((card) => card.key === "cost.provider_variable_7d")).toMatchObject({
      value: null,
      sampleSize: 3,
      matureSampleSize: 2,
      immatureSampleSize: 1,
      maturity: "immature",
      qualityState: "invalid",
      decisionUse: "blocked",
      qualityEvidence: expect.arrayContaining(["priced_invocations=2/3"]),
    });
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

  it("reports quarantined authoritative outcomes as an unavailable completeness gate", async () => {
    await projectCanonicalMetricEvent(prisma, {
      id: `${prefix}-canonical-unknown-schema`,
      sourceService: "main",
      sourceEventId: `${prefix}-unknown-schema`,
      name: "customer.signup.completed.v2",
      schemaVersion: 99,
      occurredAt: new Date("2026-07-12T00:00:00Z"),
      ingestedAt: new Date("2026-07-12T00:00:01Z"),
      environment: "production",
      dataClass: "customer",
      trustClass: "canonical",
      actor: { userId: customerId, isInternal: false },
      context: {},
      props: { userId: customerId },
    });

    const beforeResponse = await getMetricQualityReport(request("/api/v2/admin/metrics/quality?asOf=2026-07-01T00:00:00.000Z"));
    const beforeBody = await beforeResponse.json();
    expect(metricQualityReportSchema.parse(beforeBody.data).incompleteOutcomeCount).toBe(0);

    const response = await getMetricQualityReport(request("/api/v2/admin/metrics/quality?asOf=2026-08-01T00:00:00.000Z"));
    const body = await response.json();
    const quality = metricQualityReportSchema.parse(body.data);
    expect(quality).toMatchObject({ qualityState: "invalid", incompleteOutcomeCount: 1 });
    expect(quality.checks).toContainEqual({
      key: "server_outcome_completeness",
      status: "failed",
      observed: 1,
      threshold: "= 0",
    });

    await materializeMetricSnapshots(prisma, new Date("2026-08-01T00:00:00.000Z"));
    const completeness = await prisma.dataQualityCheck.findFirstOrThrow({
      where: { checkKey: "metrics.server_outcome_completeness", checkedAt: new Date("2026-08-01T00:00:00.000Z") },
    });
    expect(completeness).toMatchObject({
      status: "failed",
      metricKeys: expect.arrayContaining(["activation.chat_24h"]),
    });
    expect(completeness.metricKeys).not.toContain("north_star.wscu");
  });
});
