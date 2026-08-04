import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as activityRoute } from "@/app/api/v2/admin/collaboration/[targetType]/[targetId]/activity/route";
import { resolvePermissions } from "@/server/admin/permissions";
import { prisma } from "@/server/lib/db";
import { buildTodayProjection } from "@/server/modules/admin-v2/today/query";
import { adminCaseActiveKey } from "@/server/modules/admin-v2/cases/service";

describe("collaboration handoff authority transfer", () => {
  const suffix = randomUUID();
  const previousOwnerId = `handoff-previous-${suffix}`;
  const nextOwnerId = `handoff-next-${suffix}`;
  const projectId = `handoff-project-${suffix}`;
  const releaseId = `handoff-release-${suffix}`;
  const creativeRunId = `handoff-creative-${suffix}`;
  const incidentId = `handoff-incident-${suffix}`;
  const caseId = `handoff-case-${suffix}`;
  const now = new Date("2026-07-12T12:00:00.000Z");
  const targetIds = [projectId, creativeRunId, incidentId, caseId];
  const expectedTodayIds = [releaseId, creativeRunId, incidentId, caseId];
  const targets = [
    { targetType: "character_project", targetId: projectId },
    { targetType: "creative_run", targetId: creativeRunId },
    { targetType: "incident", targetId: incidentId },
    { targetType: "case", targetId: caseId },
  ] as const;

  const headers = (key: string) => ({
    "content-type": "application/json",
    "idempotency-key": key,
    "x-idream-user-id": previousOwnerId,
    "x-idream-role": "admin",
  });

  function handoffRequest(
    target: (typeof targets)[number],
    key: string,
    expectedVersion = 1,
    body = `Transfer ${target.targetType} ownership`,
  ) {
    return activityRoute(
      new Request(`http://localhost/api/v2/admin/collaboration/${target.targetType}/${target.targetId}/activity`, {
        method: "POST",
        headers: headers(key),
        body: JSON.stringify({
          kind: "handoff",
          expectedVersion,
          body,
          mentionedIds: [],
          metadata: { handoffToActorId: nextOwnerId },
        }),
      }),
      { params: Promise.resolve(target) },
    );
  }

  beforeAll(async () => {
    await prisma.user.createMany({
      data: [
        { id: previousOwnerId, email: `${previousOwnerId}@example.test`, role: "admin", status: "active" },
        { id: nextOwnerId, email: `${nextOwnerId}@example.test`, role: "admin", status: "active" },
      ],
    });
    await prisma.characterProject.create({
      data: {
        id: projectId,
        characterId: `handoff-character-${suffix}`,
        ownerId: previousOwnerId,
        phase: "production",
        audience: {},
        successCriteria: [],
        plannedLaunchAt: now,
      },
    });
    await prisma.characterRelease.create({
      data: {
        id: releaseId,
        projectId,
        revisionId: `handoff-revision-${suffix}`,
        characterContentVersionId: `handoff-content-${suffix}`,
        generationProvenance: {},
        releasePlacementManifest: {},
        snapshotHash: `handoff-snapshot-${suffix}`,
        status: "draft",
      },
    });
    await prisma.contentProductionBatch.create({
      data: {
        id: creativeRunId,
        title: "Handoff creative run",
        purpose: "feed",
        presetIds: [],
        ownerId: previousOwnerId,
        dueAt: now,
        createdById: previousOwnerId,
      },
    });
    await prisma.opsIncident.create({
      data: {
        id: incidentId,
        signature: `handoff-${suffix}`,
        signatureVersion: "v1",
        status: "triaged",
        severity: "high",
        ownerId: previousOwnerId,
        firstSeen: now,
        lastSeen: now,
        slaDueAt: now,
        impact: {},
        mitigation: {},
      },
    });
    await prisma.adminCase.create({
      data: {
        id: caseId,
        type: "support_request",
        targetType: "user",
        targetId: `handoff-customer-${suffix}`,
        caseKey: `handoff-${suffix}`,
        activeKey: adminCaseActiveKey(
          "support_request",
          "user",
          `handoff-customer-${suffix}`,
          `handoff-${suffix}`,
        ),
        status: "in_progress",
        ownerId: previousOwnerId,
        slaDueAt: now,
      },
    });
  });

  afterAll(async () => {
    await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: { in: targetIds } } });
    await prisma.adminAuditLog.deleteMany({ where: { targetId: { in: targetIds } } });
    await prisma.adminCollaborationActivity.deleteMany({ where: { targetId: { in: targetIds } } });
    await prisma.operationalWorkPreference.deleteMany({ where: { sourceId: { in: targetIds } } });
    await prisma.characterRelease.delete({ where: { id: releaseId } });
    await prisma.characterProject.delete({ where: { id: projectId } });
    await prisma.contentProductionBatch.delete({ where: { id: creativeRunId } });
    await prisma.opsIncident.delete({ where: { id: incidentId } });
    await prisma.adminCase.delete({ where: { id: caseId } });
    await prisma.user.deleteMany({ where: { id: { in: [previousOwnerId, nextOwnerId] } } });
    await prisma.$disconnect();
  });

  it("atomically transfers every domain owner once and moves Today Mine to the new owner", async () => {
    const before = await buildTodayProjection({
      actor: { id: previousOwnerId, role: "admin" },
      permissions: resolvePermissions("admin"),
      now,
    });
    expect(before.myShift.items.filter((item) => expectedTodayIds.includes(item.sourceId)).map((item) => item.sourceId).sort())
      .toEqual([...expectedTodayIds].sort());

    for (const target of targets) {
      const key = `handoff-${target.targetType}-${suffix}`;
      const responses = await Promise.all([
        handoffRequest(target, key),
        handoffRequest(target, key),
      ]);
      expect(responses.map((response) => response.status).sort()).toEqual([200, 201]);
      const payloads = await Promise.all(responses.map((response) => response.json()));
      expect(payloads.map((payload) => payload.data.duplicate).sort()).toEqual([false, true]);
      expect(payloads).toEqual(expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({ authority: { ownerId: nextOwnerId, version: 2 } }),
        }),
      ]));
    }

    await expect(prisma.characterProject.findUniqueOrThrow({ where: { id: projectId } })).resolves.toMatchObject({ ownerId: nextOwnerId, version: 2 });
    await expect(prisma.contentProductionBatch.findUniqueOrThrow({ where: { id: creativeRunId } })).resolves.toMatchObject({ ownerId: nextOwnerId, version: 2 });
    await expect(prisma.opsIncident.findUniqueOrThrow({ where: { id: incidentId } })).resolves.toMatchObject({ ownerId: nextOwnerId, version: 2 });
    await expect(prisma.adminCase.findUniqueOrThrow({ where: { id: caseId } })).resolves.toMatchObject({ ownerId: nextOwnerId, version: 2 });
    await expect(prisma.adminCollaborationActivity.count({ where: { targetId: { in: targetIds }, kind: "handoff" } })).resolves.toBe(4);
    await expect(prisma.adminCollaborationActivity.count({ where: { targetId: { in: targetIds }, mentionedIds: { has: nextOwnerId } } })).resolves.toBe(4);
    await expect(prisma.adminAuditLog.count({ where: { targetId: { in: targetIds }, action: "collaboration.handoff" } })).resolves.toBe(4);
    await expect(prisma.mainOutboxEvent.count({ where: { aggregateId: { in: targetIds }, eventType: "admin.collaboration.handoff.v2" } })).resolves.toBe(4);

    for (const target of targets) {
      const stale = await handoffRequest(target, `stale-${target.targetType}-${suffix}`, 1);
      expect(stale.status).toBe(409);
    }
    const collision = await handoffRequest(targets[0], `handoff-character_project-${suffix}`, 1, "Different payload");
    expect(collision.status).toBe(409);
    await expect(prisma.adminCollaborationActivity.count({ where: { targetId: { in: targetIds }, kind: "handoff" } })).resolves.toBe(4);
    await expect(prisma.adminAuditLog.count({ where: { targetId: { in: targetIds }, action: "collaboration.handoff" } })).resolves.toBe(4);
    await expect(prisma.mainOutboxEvent.count({ where: { aggregateId: { in: targetIds }, eventType: "admin.collaboration.handoff.v2" } })).resolves.toBe(4);

    const [previousOwnerToday, nextOwnerToday] = await Promise.all([
      buildTodayProjection({
        actor: { id: previousOwnerId, role: "admin" },
        permissions: resolvePermissions("admin"),
        now,
      }),
      buildTodayProjection({
        actor: { id: nextOwnerId, role: "admin" },
        permissions: resolvePermissions("admin"),
        now,
      }),
    ]);
    expect(previousOwnerToday.myShift.items.some((item) => expectedTodayIds.includes(item.sourceId))).toBe(false);
    expect(nextOwnerToday.myShift.items.filter((item) => expectedTodayIds.includes(item.sourceId)).map((item) => item.sourceId).sort())
      .toEqual([...expectedTodayIds].sort());
  });
});
