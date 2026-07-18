import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as attachIncident } from "@/app/api/v2/admin/creative/runs/[id]/commands/attach-incident/route";
import { prisma } from "@/server/lib/db";
import { createUser } from "@/server/test/helpers";
import { getCreativeRunDetail } from "./workflow";

describe("Creative Run Incident attachment", () => {
  const suffix = randomUUID();
  const actorId = `creative-incident-${suffix}-admin`;
  const runId = `creative-incident-${suffix}-run`;
  const itemId = `creative-incident-${suffix}-item`;
  const requestId = `creative-incident-${suffix}-request`;
  const attemptId = `creative-incident-${suffix}-attempt`;
  const incidentId = `creative-incident-${suffix}-incident`;

  beforeAll(async () => {
    await createUser({ id: actorId, role: "admin", dataClass: "internal" });
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
    await prisma.controlPlaneCommand.deleteMany({ where: { actorId, commandType: "creative.run.attach_incident" } });
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

  it("requires a key, rolls back failed receipt persistence, and replays the exact attachment", async () => {
    const reason = "Correlate this Run with the active provider timeout Incident";
    const key = `creative-incident-${suffix}`;
    const request = (options?: { readonly key?: string; readonly reason?: string }) => new Request(
      `http://localhost/api/v2/admin/creative/runs/${runId}/commands/attach-incident`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-idream-user-id": actorId,
          "x-idream-role": "admin",
          "x-request-id": randomUUID(),
          ...(options?.key ? { "idempotency-key": options.key } : {}),
        },
        body: JSON.stringify({
          entityVersion: 1,
          incidentId,
          reason: options?.reason ?? reason,
        }),
      },
    );

    const missingKey = await attachIncident(request(), { params: Promise.resolve({ id: runId }) });
    expect(missingKey.status).toBe(400);
    await expect(prisma.opsIncidentOccurrence.count({ where: { incidentId } })).resolves.toBe(0);

    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION fail_creative_mutation_receipt() RETURNS trigger AS $$
      BEGIN
        IF NEW."commandType" = 'creative.run.attach_incident' AND NEW."targetId" = '${runId}' THEN
          RAISE EXCEPTION 'injected creative receipt failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_creative_mutation_receipt_trigger
      BEFORE INSERT ON "control_plane_commands"
      FOR EACH ROW EXECUTE FUNCTION fail_creative_mutation_receipt();
    `);
    try {
      await expect(attachIncident(request({ key: `rollback-${key}` }), {
        params: Promise.resolve({ id: runId }),
      })).rejects.toThrow("injected creative receipt failure");
    } finally {
      await prisma.$executeRawUnsafe(`
        DROP TRIGGER IF EXISTS fail_creative_mutation_receipt_trigger ON "control_plane_commands";
        DROP FUNCTION IF EXISTS fail_creative_mutation_receipt();
      `);
    }
    await expect(prisma.contentProductionBatch.findUniqueOrThrow({ where: { id: runId } }))
      .resolves.toMatchObject({ version: 1 });
    await expect(prisma.opsIncident.findUniqueOrThrow({ where: { id: incidentId } }))
      .resolves.toMatchObject({ version: 1 });
    await expect(prisma.opsIncidentOccurrence.count({ where: { incidentId } })).resolves.toBe(0);
    await expect(prisma.adminAuditLog.count({
      where: { actorId, action: "creative.run.incident_attached", targetId: runId },
    })).resolves.toBe(0);
    await expect(prisma.mainOutboxEvent.count({
      where: { eventType: "creative.run.incident_attached.v2", aggregateId: runId },
    })).resolves.toBe(0);

    const first = await attachIncident(request({ key }), { params: Promise.resolve({ id: runId }) });
    const firstBody = await first.json();
    expect(first.status).toBe(200);
    expect(firstBody.data).toMatchObject({
      runId,
      incidentId,
      relatedAttemptIds: [attemptId],
      runVersion: 2,
      incidentVersion: 2,
    });
    const replay = await attachIncident(request({ key }), { params: Promise.resolve({ id: runId }) });
    expect(await replay.json()).toEqual(firstBody);
    const collision = await attachIncident(request({
      key,
      reason: "Changed attachment reason must conflict with the original receipt",
    }), { params: Promise.resolve({ id: runId }) });
    expect(collision.status).toBe(409);
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
    expect(await prisma.mainOutboxEvent.count({
      where: { eventType: "creative.run.incident_attached.v2", aggregateId: runId },
    })).toBe(1);
    expect(await prisma.controlPlaneCommand.count({
      where: { actorId, commandType: "creative.run.attach_incident", targetId: runId },
    })).toBe(1);
  });
});
