import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { ADMIN_METRIC_REGISTRY } from "@idream/shared/admin";
import { GET as analysisRoute } from "@/app/api/v2/admin/experiments/[id]/analysis/route";
import { analyzeExperiment } from "./analysis";

describe("experiment exposed-cohort analysis", () => {
  const suffix = randomUUID();
  const asOf = new Date("2026-07-20T00:00:00.000Z");
  const matureAt = new Date("2026-07-11T00:00:00.000Z");
  const immatureAt = new Date("2026-07-19T00:00:00.000Z");
  let experimentId = "";
  const adminId = `${suffix}-admin`;
  const analystId = `${suffix}-analyst`;
  const subjects = ["control-a", "control-b", "treatment-a", "treatment-b", "treatment-immature", "anonymous"]
    .map((value) => `${suffix}-${value}`);

  beforeAll(async () => {
    await prisma.user.createMany({
      data: [
        { id: adminId, email: `${adminId}@example.test`, role: "admin", status: "active" },
        { id: analystId, email: `${analystId}@example.test`, role: "analyst", status: "active" },
      ],
    });
    const experiment = await prisma.experimentDefinition.create({
      data: {
        key: `analysis-${suffix}`,
        version: 1,
        hypothesis: "Treatment improves QCE activation",
        eligibility: {},
        variants: [
          { key: "control", allocationBps: 5_000 },
          { key: "treatment", allocationBps: 5_000 },
        ],
        salt: `salt-${suffix}`,
        metrics: { primary: "relationship.qce_activation.v1", controlVariant: "control" },
        status: "running",
      },
    });
    experimentId = experiment.id;
    await prisma.experimentAssignment.createMany({
      data: subjects.map((subjectId, index) => ({
        experimentId,
        experimentVersion: 1,
        subjectType: index === 5 ? "anonymous" : "user",
        subjectId,
        assignmentVersion: `${experimentId}:v1`,
        variant: index < 2 ? "control" : "treatment",
        eligibilitySnapshot: {},
      })),
    });
    await prisma.experimentExposureFact.createMany({
      data: subjects.map((subjectId, index) => ({
        exposureId: `${suffix}-exposure-${index}`,
        sourceService: "analysis-test",
        sourceEventId: `${suffix}-exposure-${index}`,
        experimentId,
        experimentVersion: 1,
        assignmentVersion: `${experimentId}:v1`,
        subjectType: index === 5 ? "anonymous" : "user",
        subjectId,
        variant: index < 2 ? "control" : "treatment",
        eligible: true,
        environment: "production",
        dataClass: "customer",
        trustClass: "typed_client",
        occurredAt: index === 4 ? immatureAt : matureAt,
      })),
    });
    const outcomeUsers = [subjects[0], subjects[2], subjects[3]];
    await prisma.chatExchangeFact.createMany({
      data: outcomeUsers.flatMap((userId, userIndex) => Array.from({ length: 5 }, (_, exchangeIndex) => ({
        exchangeId: `${suffix}-exchange-${userIndex}-${exchangeIndex}`,
        sourceService: "analysis-test",
        sourceEventId: `${suffix}-exchange-${userIndex}-${exchangeIndex}`,
        userMessageId: `${suffix}-user-message-${userIndex}-${exchangeIndex}`,
        assistantMessageId: `${suffix}-assistant-${userIndex}-${exchangeIndex}`,
        selectedAssistantMessageId: `${suffix}-assistant-${userIndex}-${exchangeIndex}`,
        assistantAttemptNo: 1,
        sessionId: `${suffix}-session-${userIndex}`,
        engagementSessionId: `${suffix}-engagement-${userIndex}`,
        userId,
        characterId: `${suffix}-character`,
        characterContentVersionId: `${suffix}-content`,
        environment: "production",
        dataClass: "customer",
        trustClass: "canonical",
        eligible: true,
        occurredAt: new Date(matureAt.getTime() + (exchangeIndex + 1) * 60_000),
        productDay: new Date("2026-07-11T00:00:00.000Z"),
        sourceUpdatedAt: new Date(matureAt.getTime() + (exchangeIndex + 1) * 60_000),
        validFrom: matureAt,
      }))),
    });
  });

  afterAll(async () => {
    await prisma.chatExchangeFact.deleteMany({ where: { sourceService: "analysis-test", sourceEventId: { startsWith: suffix } } });
    await prisma.experimentExposureFact.deleteMany({ where: { sourceService: "analysis-test", sourceEventId: { startsWith: suffix } } });
    await prisma.experimentAssignment.deleteMany({ where: { experimentId } });
    await prisma.experimentDefinition.deleteMany({ where: { id: experimentId } });
    await prisma.user.deleteMany({ where: { id: { in: [adminId, analystId] } } });
    await prisma.$disconnect();
  });

  it("uses only mature exposed user cohorts and reports absolute lift against control", async () => {
    const analysis = await analyzeExperiment(prisma, experimentId, asOf);
    expect(analysis).toMatchObject({
      maturity: "mature",
      qualityState: "directional",
      decisionUse: "directional_only",
      primaryMetric: "relationship.qce_activation.v1",
      controlVariant: "control",
    });
    expect(analysis.arms.map((arm) => ({
      variant: arm.variant,
      assignedSubjects: arm.assignedSubjects,
      exposedSubjects: arm.exposedSubjects,
      matureSubjects: arm.matureSubjects,
      outcomeSubjects: arm.outcomeSubjects,
      rate: arm.rate,
      absoluteLiftVsControl: arm.absoluteLiftVsControl,
    }))).toEqual([
      {
        variant: "control",
        assignedSubjects: 2,
        exposedSubjects: 2,
        matureSubjects: 2,
        outcomeSubjects: 1,
        rate: 0.5,
        absoluteLiftVsControl: 0,
      },
      {
        variant: "treatment",
        assignedSubjects: 4,
        exposedSubjects: 4,
        matureSubjects: 2,
        outcomeSubjects: 2,
        rate: 1,
        absoluteLiftVsControl: 0.5,
      },
    ]);
    expect(analysis).toMatchObject({ significance: "unavailable", guardrailState: "blocked", minimumMaturePerArm: 100 });
    expect(analysis.qualityEvidence).toContain(
      "primary metric certification: blocked; requires the exact immutable registry snapshot and seven fresh evidenced quality gates",
    );
    expect(analysis.guardrails).toEqual([
      expect.objectContaining({
        metricKey: "guardrail.support_contact_rate.v1",
        state: "blocked",
      }),
    ]);
  });

  it("exposes the analysis only to experiment managers", async () => {
    const request = (actorId: string, role: string) => new Request(
      `http://localhost/api/v2/admin/experiments/${experimentId}/analysis?asOf=${encodeURIComponent(asOf.toISOString())}`,
      { headers: { "x-idream-user-id": actorId, "x-idream-role": role } },
    );
    const forbidden = await analysisRoute(request(analystId, "analyst"), { params: Promise.resolve({ id: experimentId }) });
    expect(forbidden.status).toBe(403);
    const allowed = await analysisRoute(request(adminId, "admin"), { params: Promise.resolve({ id: experimentId }) });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({
      ok: true,
      data: { experimentId, qualityState: "directional" },
    });
  });

  it("excludes fixture outcomes from production experiment decisions", async () => {
    await prisma.chatExchangeFact.updateMany({
      where: { sourceService: "analysis-test", userId: { in: [subjects[2], subjects[3]] } },
      data: { dataClass: "fixture", trustClass: "synthetic" },
    });
    const analysis = await analyzeExperiment(prisma, experimentId, asOf);
    expect(analysis.arms.find((arm) => arm.variant === "treatment")).toMatchObject({ outcomeSubjects: 0, rate: 0 });
  });

  it("fails closed before any exposed cohort has matured", async () => {
    const analysis = await analyzeExperiment(prisma, experimentId, new Date("2026-07-12T00:00:00.000Z"));
    expect(analysis).toMatchObject({
      maturity: "immature",
      qualityState: "invalid",
      decisionUse: "blocked",
    });
    expect(analysis.arms.every((arm) => arm.rate === null && arm.absoluteLiftVsControl === null)).toBe(true);
  });

  it("allows decision use only with certified mature guardrails and fails closed on support-outcome gaps/regression", async () => {
    const experiment = await prisma.experimentDefinition.create({
      data: {
        key: `guardrail-${suffix}`,
        version: 1,
        hypothesis: "Treatment improves QCE without increasing support burden",
        eligibility: {},
        variants: [{ key: "control", allocationBps: 5_000 }, { key: "treatment", allocationBps: 5_000 }],
        salt: `guardrail-salt-${suffix}`,
        metrics: {
          primary: "relationship.qce_activation.v1",
          controlVariant: "control",
          minimumMaturePerArm: 20,
          guardrails: [{ metricKey: "guardrail.support_contact_rate.v1", maxAbsoluteRegression: 0.02 }],
        },
        status: "running",
      },
    });
    const subjectIds = Array.from({ length: 40 }, (_, index) => `${suffix}-guardrail-user-${index}`);
    const definitionKeys = ["relationship.qce_activation.v1", "guardrail.support_contact_rate.v1"];
    const checkKeys = [
      "metrics.server_outcome_completeness",
      "metrics.duplicate_effect",
      "metrics.impossible_state",
      "metrics.fixture_internal_leakage",
      "metrics.authoritative_join_coverage",
      "metrics.event_lag_p95",
      "metrics.eligible_fact_presence",
    ];
    const supportRequestId = `${suffix}-guardrail-support`;
    try {
      await prisma.user.createMany({ data: subjectIds.map((id) => ({ id, email: `${id}@example.test`, role: "user" })) });
      await prisma.experimentAssignment.createMany({ data: subjectIds.map((subjectId, index) => ({
        experimentId: experiment.id,
        experimentVersion: 1,
        subjectType: "user",
        subjectId,
        assignmentVersion: `${experiment.id}:v1`,
        variant: index < 20 ? "control" : "treatment",
        eligibilitySnapshot: {},
      })) });
      await prisma.experimentExposureFact.createMany({ data: subjectIds.map((subjectId, index) => ({
        exposureId: `${suffix}-guardrail-exposure-${index}`,
        sourceService: "guardrail-test",
        sourceEventId: `${suffix}-guardrail-exposure-${index}`,
        experimentId: experiment.id,
        experimentVersion: 1,
        assignmentVersion: `${experiment.id}:v1`,
        subjectType: "user",
        subjectId,
        variant: index < 20 ? "control" : "treatment",
        eligible: true,
        environment: "production",
        dataClass: "customer",
        trustClass: "typed_client",
        occurredAt: matureAt,
      })) });
      for (const key of definitionKeys) {
        const definition = ADMIN_METRIC_REGISTRY.find((candidate) => candidate.key === key);
        if (!definition) throw new Error(`Missing test metric definition ${key}`);
        await prisma.metricDefinitionSnapshot.create({ data: {
          key,
          version: definition.version,
          definition: JSON.parse(JSON.stringify(definition)),
          queryHash: definition.queryHash,
          qualityState: "certified",
          effectiveAt: new Date(definition.effectiveAt),
          lastValidatedAt: new Date(asOf.getTime() - 60_000),
          validationEvidence: { fixture: suffix, result: "passed" },
        } });
      }
      await prisma.dataQualityCheck.createMany({ data: checkKeys.map((checkKey) => ({
        checkKey,
        status: "passed",
        metricKeys: definitionKeys,
        observed: { value: 0 },
        threshold: { expression: "passed" },
        evidence: { fixture: suffix, result: "passed" },
        windowStart: matureAt,
        windowEnd: asOf,
        checkedAt: new Date(asOf.getTime() - 60_000),
      })) });

      await expect(analyzeExperiment(prisma, experiment.id, asOf)).resolves.toMatchObject({
        qualityState: "certified",
        decisionUse: "eligible",
        guardrailState: "passed",
        guardrails: [expect.objectContaining({ metricKey: "guardrail.support_contact_rate.v1", observedRegression: 0, state: "passed" })],
      });

      await prisma.supportRequest.create({ data: {
        id: supportRequestId,
        ticketId: `${suffix}-GUARDRAIL`,
        userId: subjectIds[20],
        category: "bug",
        subject: "Guardrail support request",
        description: "A canonical support outcome is required for experiment analysis.",
        createdAt: new Date(matureAt.getTime() + 60 * 60 * 1_000),
      } });
      await expect(analyzeExperiment(prisma, experiment.id, asOf)).resolves.toMatchObject({
        qualityState: "invalid",
        decisionUse: "blocked",
        guardrailState: "blocked",
      });

      await prisma.analyticsEvent.create({ data: {
        id: `${suffix}-guardrail-support-event`,
        userId: subjectIds[20],
        name: "support.request.submitted.v2",
        props: { supportRequestId, userId: subjectIds[20], category: "bug" },
        sourceService: "main",
        sourceEventId: `support_request:${supportRequestId}`,
        payloadHash: `${suffix}-guardrail-support-hash`,
        schemaVersion: 2,
        occurredAt: new Date(matureAt.getTime() + 60 * 60 * 1_000),
        environment: "production",
        dataClass: "customer",
        trustClass: "canonical",
        actor: { userId: subjectIds[20], isInternal: false },
        context: {},
      } });
      await expect(analyzeExperiment(prisma, experiment.id, asOf)).resolves.toMatchObject({
        qualityState: "certified",
        decisionUse: "blocked",
        guardrailState: "failed",
        guardrails: [expect.objectContaining({ observedRegression: 0.05, state: "failed" })],
      });
    } finally {
      await prisma.analyticsEvent.deleteMany({ where: { id: `${suffix}-guardrail-support-event` } });
      await prisma.supportRequest.deleteMany({ where: { id: supportRequestId } });
      await prisma.dataQualityCheck.deleteMany({ where: { evidence: { path: ["fixture"], equals: suffix } } });
      await prisma.metricDefinitionSnapshot.deleteMany({ where: { key: { in: definitionKeys } } });
      await prisma.experimentExposureFact.deleteMany({ where: { experimentId: experiment.id } });
      await prisma.experimentAssignment.deleteMany({ where: { experimentId: experiment.id } });
      await prisma.experimentDefinition.delete({ where: { id: experiment.id } });
      await prisma.user.deleteMany({ where: { id: { in: subjectIds } } });
    }
  });
});
