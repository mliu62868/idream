import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { POST as assignmentRoute } from "@/app/api/internal/experiments/[key]/assignment/route";
import { POST as exposureRoute } from "@/app/api/internal/experiments/exposure/route";
import {
  assignExperiment,
  recordExperimentExposure,
} from "./runtime";

describe("experiment assignment and exposure authority", () => {
  const suffix = randomUUID();
  const key = `experiment-${suffix}`;
  let experimentId = "";
  const exposureIds = [`exposure-${suffix}-1`, `exposure-${suffix}-2`];

  beforeAll(async () => {
    const definition = await prisma.experimentDefinition.create({
      data: {
        key,
        version: 1,
        hypothesis: "A visible treatment improves qualified engagement",
        eligibility: { country: ["US"], accountState: "active" },
        variants: [
          { key: "control", allocationBps: 5_000 },
          { key: "treatment", allocationBps: 5_000 },
        ],
        salt: `salt-${suffix}`,
        metrics: { primary: "relationship.qce_rate.v1" },
        status: "running",
      },
    });
    experimentId = definition.id;
  });

  afterAll(async () => {
    const events = await prisma.analyticsEvent.findMany({
      where: { sourceService: "main-experiment-runtime", sourceEventId: { contains: suffix } },
      select: { id: true },
    });
    await prisma.metricProjectionReceipt.deleteMany({
      where: { sourceService: "main-experiment-runtime", sourceEventId: { contains: suffix } },
    });
    await prisma.experimentExposureFact.deleteMany({ where: { exposureId: { contains: suffix } } });
    await prisma.mainOutboxEvent.deleteMany({
      where: { aggregateId: { in: events.map((event) => event.id) } },
    });
    await prisma.analyticsEvent.deleteMany({
      where: { sourceService: "main-experiment-runtime", sourceEventId: { contains: suffix } },
    });
    await prisma.inboundEventReceipt.deleteMany({
      where: { sourceService: "main-experiment-runtime", sourceEventId: { contains: suffix } },
    });
    await prisma.experimentAssignment.deleteMany({ where: { experimentId } });
    await prisma.experimentDefinition.deleteMany({ where: { id: experimentId } });
    await prisma.$disconnect();
  });

  it("persists one deterministic assignment and never turns an ineligible subject into a zero-valued arm", async () => {
    const input = {
      subjectType: "user" as const,
      subjectId: `user-${suffix}`,
      eligibilitySnapshot: { country: "US", accountState: "active" },
      version: 1,
    };
    const first = await assignExperiment(prisma, key, input);
    const replay = await assignExperiment(prisma, key, input);
    expect(replay).toEqual(first);
    expect(first).toMatchObject({ status: "assigned", experimentId, experimentVersion: 1 });
    expect(["control", "treatment"]).toContain(first.variant);
    expect(await prisma.experimentAssignment.count({ where: { experimentId, subjectId: input.subjectId } })).toBe(1);

    const ineligible = await assignExperiment(prisma, key, {
      ...input,
      subjectId: `ineligible-${suffix}`,
      eligibilitySnapshot: { country: "CA", accountState: "active" },
    });
    expect(ineligible).toMatchObject({ status: "ineligible", assignmentId: null, variant: null });
    expect(await prisma.experimentAssignment.count({ where: { experimentId, subjectId: `ineligible-${suffix}` } })).toBe(0);
  });

  it("records a real exposure as a typed canonical fact and replays without duplicate effects", async () => {
    const assignment = await assignExperiment(prisma, key, {
      subjectType: "anonymous",
      subjectId: `anon-${suffix}`,
      eligibilitySnapshot: { country: "US", accountState: "active" },
      version: 1,
    });
    const input = {
      exposureId: exposureIds[0],
      assignmentId: assignment.assignmentId as string,
      surface: "explore.hero",
      occurredAt: "2026-07-11T12:00:00.000Z",
    };
    await expect(recordExperimentExposure(prisma, input, { environment: "production" }))
      .resolves.toMatchObject({ status: "recorded", variant: assignment.variant });
    await expect(recordExperimentExposure(prisma, input, { environment: "production" }))
      .resolves.toMatchObject({ status: "duplicate" });
    expect(await prisma.experimentExposureFact.findUnique({ where: { exposureId: input.exposureId } }))
      .toMatchObject({
        experimentId,
        assignmentVersion: assignment.assignmentVersion,
        subjectType: "anonymous",
        subjectId: `anon-${suffix}`,
        variant: assignment.variant,
        trustClass: "typed_client",
        eligible: true,
      });
    expect(await prisma.experimentExposureFact.count({ where: { exposureId: input.exposureId } })).toBe(1);
  });

  it("rejects payload-changing exposure ID reuse and protects the internal HTTP boundary", async () => {
    const first = await assignExperiment(prisma, key, {
      subjectType: "user",
      subjectId: `collision-a-${suffix}`,
      eligibilitySnapshot: { country: "US", accountState: "active" },
    });
    const second = await assignExperiment(prisma, key, {
      subjectType: "user",
      subjectId: `collision-b-${suffix}`,
      eligibilitySnapshot: { country: "US", accountState: "active" },
    });
    const occurredAt = "2026-07-11T12:30:00.000Z";
    await recordExperimentExposure(prisma, {
      exposureId: exposureIds[1],
      assignmentId: first.assignmentId as string,
      surface: "character.card",
      occurredAt,
    }, { environment: "production" });
    await expect(recordExperimentExposure(prisma, {
      exposureId: exposureIds[1],
      assignmentId: second.assignmentId as string,
      surface: "character.card",
      occurredAt,
    }, { environment: "production" })).rejects.toMatchObject({ code: "event_conflict", status: 409 });

    const unauthorized = await assignmentRoute(new Request(`http://localhost/api/internal/experiments/${key}/assignment`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subjectType: "user", subjectId: "u", eligibilitySnapshot: {} }),
    }), { params: Promise.resolve({ key }) });
    expect(unauthorized.status).toBe(401);

    const assignmentResponse = await assignmentRoute(new Request(`http://localhost/api/internal/experiments/${key}/assignment`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": env.INTERNAL_TOKEN },
      body: JSON.stringify({
        subjectType: "user",
        subjectId: `route-${suffix}`,
        eligibilitySnapshot: { country: "US", accountState: "active", serverChecked: true },
      }),
    }), { params: Promise.resolve({ key }) });
    expect(assignmentResponse.status).toBe(200);
    const assignmentJson = await assignmentResponse.json() as { data: { assignmentId: string } };

    const exposureResponse = await exposureRoute(new Request("http://localhost/api/internal/experiments/exposure", {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": env.INTERNAL_TOKEN },
      body: JSON.stringify({
        exposureId: `route-${suffix}`,
        assignmentId: assignmentJson.data.assignmentId,
        surface: "route.test",
        occurredAt,
      }),
    }));
    expect(exposureResponse.status).toBe(200);
  });
});
