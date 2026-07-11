import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
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
    expect(analysis.arms).toEqual([
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

  it("fails closed before any exposed cohort has matured", async () => {
    const analysis = await analyzeExperiment(prisma, experimentId, new Date("2026-07-12T00:00:00.000Z"));
    expect(analysis).toMatchObject({
      maturity: "immature",
      qualityState: "invalid",
      decisionUse: "blocked",
    });
    expect(analysis.arms.every((arm) => arm.rate === null && arm.absoluteLiftVsControl === null)).toBe(true);
  });
});
