import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_METRIC_REGISTRY, metricDashboardResponseSchema } from "@idream/shared/admin";
import { prisma } from "@/server/lib/db";
import { toInputJson } from "../shared/prisma-json";
import { getMetricDashboard, materializeMetricSnapshots, validateMetricDefinitions } from "./query";

describe("metric snapshot materialization", () => {
  const prefix = `metric-materialize-${randomUUID()}`;
  const userId = `${prefix}-user`;
  const analystId = `${prefix}-analyst`;
  const characterId = `${prefix}-character`;
  const contentVersionId = `${prefix}-content`;
  const asOf = new Date("2026-08-02T12:00:00.000Z");
  const latestDataAt = new Date(asOf.getTime() - 60_000);
  const definition = ADMIN_METRIC_REGISTRY.find((row) => row.key === "north_star.wscu")!;

  beforeAll(async () => {
    await prisma.user.createMany({ data: [
      { id: userId, email: `${userId}@customer.invalid`, role: "user", status: "active" },
      { id: analystId, email: `${analystId}@customer.invalid`, role: "analyst", status: "active" },
    ] });
    await prisma.character.create({ data: {
      id: characterId, name: "Metric integration fixture", age: 24,
      description: "Dedicated test database only", appearance: {}, advancedDetails: {},
    } });
    await prisma.characterContentVersion.create({ data: {
      id: contentVersionId, characterId, version: 1, contentHash: prefix,
      personaSnapshot: {}, openingSnapshot: {}, appearanceSnapshot: {}, sourceType: "test",
    } });
    // Published definitions start unvalidated and remain immutable.
    await prisma.metricDefinitionSnapshot.create({ data: {
      key: definition.key, version: definition.version, definition: toInputJson(definition),
      queryHash: definition.queryHash, qualityState: "invalid",
      effectiveAt: new Date(definition.effectiveAt), lastValidatedAt: null,
      validationEvidence: [],
    } });
    await prisma.metricProjectionReceipt.create({ data: {
      sourceService: "main", sourceEventId: `${prefix}-receipt`, canonicalEventId: `${prefix}-event`,
      eventType: "chat.exchange.completed.v2", outcome: "applied", factType: "chat_exchange_fact",
      occurredAt: latestDataAt, processedAt: new Date(latestDataAt.getTime() + 1_000),
    } });
    await addEpisode("today", latestDataAt);
  });

  afterAll(async () => {
    await prisma.dataQualityCheck.deleteMany({ where: { checkKey: { startsWith: "metrics." } } });
    await prisma.metricSnapshot.deleteMany({});
    await prisma.metricDefinitionSnapshot.deleteMany({});
    await prisma.metricProjectionReceipt.deleteMany({ where: { sourceEventId: { startsWith: prefix } } });
    await prisma.chatExchangeFact.deleteMany({ where: { userId } });
    await prisma.characterContentVersion.delete({ where: { id: contentVersionId } });
    await prisma.character.delete({ where: { id: characterId } });
    await prisma.user.deleteMany({ where: { id: { in: [userId, analystId] } } });
    await prisma.$disconnect();
  });

  async function addEpisode(session: string, completedAt: Date) {
    await prisma.chatExchangeFact.createMany({ data: Array.from({ length: 5 }, (_, index) => ({
      exchangeId: `${prefix}-${session}-${index}`, sourceService: "main",
      sourceEventId: `${prefix}-${session}-${index}`, userMessageId: `${prefix}-${session}-${index}-user`,
      assistantMessageId: `${prefix}-${session}-${index}-assistant`,
      selectedAssistantMessageId: `${prefix}-${session}-${index}-assistant`, assistantAttemptNo: 1,
      sessionId: `${prefix}-${session}`, engagementSessionId: `${prefix}-${session}`,
      userId, characterId, characterContentVersionId: contentVersionId,
      environment: "production", dataClass: "customer", trustClass: "canonical", actorIsInternal: false,
      eligible: true, occurredAt: new Date(completedAt.getTime() - (4 - index) * 1_000),
      productDay: new Date(`${completedAt.toISOString().slice(0, 10)}T00:00:00Z`),
      sourceUpdatedAt: completedAt, validFrom: new Date(definition.validFrom),
    })) });
  }

  it("publishes the first evaluated value and updates it when a late fact changes the same source watermark", async () => {
    const before = await materializeMetricSnapshots(prisma, asOf);
    expect(before.cards.find((card) => card.key === definition.key)?.decisionUse).toBe("blocked");
    const immature = await validateMetricDefinitions(prisma, new Date(latestDataAt.getTime() - 120_000));
    expect(immature.results.find((row) => row.key === definition.key)?.failures).toContain("definition_validation_mature_sample_missing");
    const validation = await validateMetricDefinitions(prisma, asOf);
    expect(validation.results.find((row) => row.key === definition.key)?.status).toBe("passed");
    const evidence = await prisma.dataQualityCheck.findUniqueOrThrow({ where: {
      id: validation.results.find((row) => row.key === definition.key)!.evidenceId,
    } });
    expect(evidence.evidence).toMatchObject({
      validatorVersion: 2, queryHash: definition.queryHash,
      formulaInputHash: expect.any(String), formulaEvidenceHash: expect.any(String),
      formulaChecks: expect.arrayContaining([expect.objectContaining({ metricKey: definition.key, passed: true })]),
    });
    expect(validation.results.find((row) => row.key === "north_star.wpcu")?.failures).toContain("source_fact_missing:subscription_lifecycle_fact");
    const immutable = await prisma.metricDefinitionSnapshot.findUniqueOrThrow({ where: { key_version: { key: definition.key, version: definition.version } } });
    expect(immutable.lastValidatedAt).toBeNull();
    expect(immutable.qualityState).toBe("invalid");
    const first = await materializeMetricSnapshots(prisma, asOf);
    expect(first.cards.find((card) => card.key === definition.key)).toMatchObject({
      value: 0, numeratorValue: 0, sampleSize: 1,
      qualityState: "directional", decisionUse: "directional_only",
    });
    await addEpisode("yesterday", new Date(latestDataAt.getTime() - 24 * 60 * 60 * 1_000));
    const nextAsOf = new Date(asOf.getTime() + 60_000);
    const second = await materializeMetricSnapshots(prisma, nextAsOf);
    expect(second.cards.find((card) => card.key === definition.key)).toMatchObject({
      value: 1, numeratorValue: 1, sampleSize: 1, latestDataAt: latestDataAt.toISOString(),
    });
    const response = await getMetricDashboard(new Request(`http://localhost/api/v2/admin/metrics?asOf=${nextAsOf.toISOString()}`, {
      headers: { "x-idream-user-id": analystId, "x-idream-role": "analyst" },
    }));
    expect(response.status).toBe(200);
    const dashboard = metricDashboardResponseSchema.parse((await response.json()).data);
    expect(dashboard.cards.find((card) => card.key === definition.key)).toMatchObject({
      value: 1, numeratorValue: 1, decisionUse: "directional_only",
    });
    expect(dashboard.cards.find((card) => card.key === "north_star.wpcu")).toMatchObject({
      value: null, publicationStatus: "official", decisionUse: "blocked",
      qualityEvidence: expect.arrayContaining(["definition_validation_failed"]),
    });
    expect(await prisma.metricSnapshot.findMany({
      where: { metricKey: definition.key }, orderBy: { asOf: "asc" }, select: { value: true },
    })).toEqual([{ value: 0 }, { value: 1 }]);
  });
});
