import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { recordGenerationAttemptEvent } from "@/server/ai/generation-attempt-events";
import { dispatchGenerationIncidentCorrelation } from "./service";

describe("Generation failure to Incident production seam", () => {
  const suffix = randomUUID();
  const userId = `incident-dispatch-user-${suffix}`;
  const completeJobId = `incident-dispatch-job-${suffix}`;
  const incompleteJobId = `incident-dispatch-incomplete-job-${suffix}`;
  const completeAttemptId = `incident-dispatch-attempt-${suffix}`;
  const incompleteAttemptId = `incident-dispatch-incomplete-attempt-${suffix}`;

  beforeAll(async () => {
    await prisma.user.create({
      data: { id: userId, email: `${userId}@customer.example`, role: "user", status: "active" },
    });
    await prisma.generationJob.createMany({
      data: [
        { id: completeJobId, userId, mode: "image", controls: {}, presetIds: [], status: "failed" },
        { id: incompleteJobId, userId, mode: "image", controls: {}, presetIds: [], status: "failed" },
      ],
    });
    await prisma.generationAttempt.createMany({
      data: [
        {
          id: completeAttemptId,
          requestId: completeJobId,
          attemptNo: 1,
          provider: "comfyui",
          profileKey: "portrait-v3",
          workflowKey: "image-v2",
          status: "running",
        },
        {
          id: incompleteAttemptId,
          requestId: incompleteJobId,
          attemptNo: 1,
          provider: "comfyui",
          status: "running",
        },
      ],
    });
  });

  afterAll(async () => {
    const occurrences = await prisma.opsIncidentOccurrence.findMany({
      where: { attemptId: { in: [completeAttemptId, incompleteAttemptId] } },
      select: { incidentId: true },
    });
    const incidentIds = [...new Set(occurrences.map((row) => row.incidentId))];
    await prisma.adminAuditLog.deleteMany({
      where: { targetId: { in: [...incidentIds, completeAttemptId, incompleteAttemptId] } },
    });
    await prisma.mainOutboxEvent.deleteMany({
      where: { aggregateId: { in: [completeAttemptId, incompleteAttemptId] } },
    });
    await prisma.opsIncidentOccurrence.deleteMany({
      where: { attemptId: { in: [completeAttemptId, incompleteAttemptId] } },
    });
    await prisma.opsIncident.deleteMany({ where: { id: { in: incidentIds } } });
    await prisma.generationAttemptEvent.deleteMany({
      where: { attemptId: { in: [completeAttemptId, incompleteAttemptId] } },
    });
    await prisma.generationAttempt.deleteMany({
      where: { id: { in: [completeAttemptId, incompleteAttemptId] } },
    });
    await prisma.generationJob.deleteMany({
      where: { id: { in: [completeJobId, incompleteJobId] } },
    });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("durably emits and consumes correlation work for a stable failed Attempt", async () => {
    await prisma.$transaction((tx) => recordGenerationAttemptEvent(tx, {
      eventId: `${completeAttemptId}:failed`,
      attemptId: completeAttemptId,
      eventType: "generation.attempt.failed.v1",
      outcome: "failed",
      occurredAt: new Date("2026-07-11T12:00:00.000Z"),
      payload: { error: "gateway timeout" },
      errorClass: "gateway_timeout",
      errorCode: "provider_timeout",
      errorSignature: "normalized_gateway_timeout",
      retryability: "operator_retry",
    }));

    const outboxId = `generation_incident_correlation_${completeAttemptId}`;
    expect(await prisma.mainOutboxEvent.findUniqueOrThrow({ where: { id: outboxId } })).toMatchObject({
      status: "pending",
      eventType: "generation.incident.correlate.v2",
    });
    expect(await prisma.opsIncidentOccurrence.count({ where: { attemptId: completeAttemptId } })).toBe(0);

    await expect(dispatchGenerationIncidentCorrelation(prisma, { outboxIds: [outboxId] })).resolves.toMatchObject({
      correlated: 1,
      unavailable: 0,
      failed: 0,
    });
    const occurrence = await prisma.opsIncidentOccurrence.findUniqueOrThrow({
      where: { occurrenceKey: `generation-attempt:${completeAttemptId}` },
    });
    expect(await prisma.opsIncident.findUniqueOrThrow({ where: { id: occurrence.incidentId } })).toMatchObject({
      status: "detected",
      verificationState: "pending",
    });
    expect(await prisma.mainOutboxEvent.findUniqueOrThrow({ where: { id: outboxId } })).toMatchObject({
      status: "delivered",
      attempts: 1,
    });
    await expect(dispatchGenerationIncidentCorrelation(prisma, { outboxIds: [outboxId] })).resolves.toMatchObject({ examined: 0 });
  });

  it("records unavailable evidence once instead of inventing or endlessly retrying an Incident", async () => {
    await prisma.$transaction((tx) => recordGenerationAttemptEvent(tx, {
      eventId: `${incompleteAttemptId}:failed`,
      attemptId: incompleteAttemptId,
      eventType: "generation.attempt.failed.v1",
      outcome: "failed",
      occurredAt: new Date("2026-07-11T12:01:00.000Z"),
      payload: { error: "gateway timeout without route context" },
      errorClass: "gateway_timeout",
      errorCode: "provider_timeout",
      errorSignature: "normalized_gateway_timeout",
      retryability: "operator_retry",
    }));

    await expect(dispatchGenerationIncidentCorrelation(prisma, {
      outboxIds: [`generation_incident_correlation_${incompleteAttemptId}`],
    })).resolves.toMatchObject({
      correlated: 0,
      unavailable: 1,
      failed: 0,
    });
    expect(await prisma.opsIncidentOccurrence.count({ where: { attemptId: incompleteAttemptId } })).toBe(0);
    expect(await prisma.adminAuditLog.findFirst({
      where: { action: "incident.correlation.unavailable", targetId: incompleteAttemptId },
    })).toMatchObject({ actorId: "system", actorRole: "system" });
    expect(await prisma.mainOutboxEvent.findUniqueOrThrow({
      where: { id: `generation_incident_correlation_${incompleteAttemptId}` },
    })).toMatchObject({ status: "delivered", attempts: 1 });
  });
});
