import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { createUser } from "@/server/test/helpers";
import { attachCreativeRunToIncident, getCreativeRunDetail } from "./workflow";

describe("Creative Run Incident attachment", () => {
  const suffix = randomUUID();
  const actorId = `creative-incident-${suffix}-admin`;
  const runId = `creative-incident-${suffix}-run`;
  const itemId = `creative-incident-${suffix}-item`;
  const requestId = `creative-incident-${suffix}-request`;
  const attemptId = `creative-incident-${suffix}-attempt`;
  const incidentId = `creative-incident-${suffix}-incident`;

  beforeAll(async () => {
    await createUser({ id: actorId, role: "admin" });
    await prisma.contentProductionBatch.create({
      data: {
        id: runId,
        title: "Failed Creative Run",
        purpose: "feed",
        targetType: "none",
        presetIds: [],
        count: 1,
        totalItems: 1,
        failedItems: 1,
        status: "reviewing",
        createdById: actorId,
        ownerId: actorId,
        items: { create: { id: itemId, itemIndex: 0, status: "failed", tags: [] } },
      },
    });
    await prisma.generationJob.create({
      data: {
        id: requestId,
        userId: actorId,
        mode: "image",
        controls: {},
        presetIds: [],
        status: "failed",
        sourceType: "content_production_item",
        sourceId: itemId,
      },
    });
    await prisma.contentProductionItem.update({ where: { id: itemId }, data: { jobId: requestId } });
    await prisma.generationAttempt.create({
      data: {
        id: attemptId,
        requestId,
        attemptNo: 1,
        status: "failed",
        errorSignature: "provider_timeout:v1",
        finishedAt: new Date(),
      },
    });
    await prisma.opsIncident.create({
      data: {
        id: incidentId,
        signature: "provider_timeout",
        signatureVersion: "v1",
        activeCorrelationKey: `provider_timeout:${suffix}`,
        status: "investigating",
        severity: "p1",
        firstSeen: new Date(),
        lastSeen: new Date(),
        impact: {},
        mitigation: {},
      },
    });
  });

  afterAll(async () => {
    await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: runId } });
    await prisma.adminAuditLog.deleteMany({ where: { actorId } });
    await prisma.opsIncidentOccurrence.deleteMany({ where: { incidentId } });
    await prisma.opsIncident.deleteMany({ where: { id: incidentId } });
    await prisma.generationAttempt.deleteMany({ where: { id: attemptId } });
    await prisma.contentProductionBatch.deleteMany({ where: { id: runId } });
    await prisma.generationJob.deleteMany({ where: { id: requestId } });
    await prisma.user.deleteMany({ where: { id: actorId } });
    await prisma.$disconnect();
  });

  it("attaches exact failed Attempts and exposes canonical Incident deep links", async () => {
    const result = await attachCreativeRunToIncident({
      runId,
      incidentId,
      actor: { id: actorId, role: "admin" },
      expectedVersion: 1,
      reason: "Correlate this Run with the active provider timeout Incident",
      requestId: randomUUID(),
    });
    expect(result).toMatchObject({
      runId,
      incidentId,
      relatedAttemptIds: [attemptId],
      runVersion: 2,
      incidentVersion: 2,
    });
    expect(await prisma.opsIncidentOccurrence.findFirst({ where: { incidentId, attemptId } })).toMatchObject({
      requestId,
    });
    expect(await getCreativeRunDetail({
      runId,
      actor: { id: actorId, role: "admin" },
    })).toMatchObject({ relatedIncidentIds: [incidentId], version: 2 });
    expect(await prisma.adminAuditLog.count({
      where: { actorId, action: "creative.run.incident_attached", targetId: runId },
    })).toBe(1);
  });
});
