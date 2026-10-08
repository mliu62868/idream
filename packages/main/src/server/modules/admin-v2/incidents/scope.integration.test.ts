import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { GET as incidentRoute } from "@/app/api/v2/admin/incidents/[id]/route";
import { GET as activityRoute, POST as createActivityRoute } from "@/app/api/v2/admin/collaboration/[targetType]/[targetId]/activity/route";
import { PUT as watchRoute } from "@/app/api/v2/admin/collaboration/[targetType]/[targetId]/watch/route";
import { adminV2Route } from "@/server/test/admin-v2-route-client";
import { getIncidentDetail, listIncidents } from "./query";

describe("support customer-linked Incident scope", () => {
  const suffix = randomUUID();
  const supportId = `incident-scope-support-${suffix}`;
  const customerId = `incident-scope-customer-${suffix}`;
  const jobId = `incident-scope-job-${suffix}`;
  const incidentId = `incident-scope-linked-${suffix}`;
  const hiddenIncidentId = `incident-scope-hidden-${suffix}`;
  const caseId = `incident-scope-case-${suffix}`;

  beforeAll(async () => {
    await prisma.user.createMany({ data: [
      { id: supportId, email: `${supportId}@example.test`, role: "support" },
      { id: customerId, email: `${customerId}@example.test`, role: "user" },
    ] });
    await prisma.generationJob.create({ data: {
      id: jobId,
      userId: customerId,
      mode: "image",
      controls: {},
      presetIds: [],
      status: "failed",
      errorCode: "linked_failure",
    } });
    await prisma.adminCase.create({ data: {
      id: caseId,
      type: "support_request",
      targetType: "user",
      targetId: customerId,
      caseKey: `linked:${suffix}`,
      activeKey: `support_request:user:${customerId}:linked:${suffix}`,
      status: "in_progress",
      priority: "high",
    } });
    await prisma.opsIncident.createMany({ data: [
      { id: incidentId, signature: `linked-${suffix}`, signatureVersion: "v1", status: "triaged", severity: "high", firstSeen: new Date(), lastSeen: new Date(), impact: {}, mitigation: {} },
      { id: hiddenIncidentId, signature: `hidden-${suffix}`, signatureVersion: "v1", status: "triaged", severity: "high", firstSeen: new Date(), lastSeen: new Date(), impact: {}, mitigation: {} },
    ] });
    await prisma.opsIncidentOccurrence.create({ data: {
      incidentId,
      requestId: jobId,
      occurrenceKey: `linked:${suffix}`,
      observedAt: new Date(),
    } });
  });

  afterAll(async () => {
    await prisma.adminCollaborationActivity.deleteMany({ where: { targetId: { in: [incidentId, hiddenIncidentId] } } });
    await prisma.operationalWorkPreference.deleteMany({ where: { sourceId: { in: [incidentId, hiddenIncidentId] } } });
    await prisma.opsIncidentOccurrence.deleteMany({ where: { incidentId } });
    await prisma.opsIncident.deleteMany({ where: { id: { in: [incidentId, hiddenIncidentId] } } });
    await prisma.adminCase.deleteMany({ where: { id: caseId } });
    await prisma.generationJob.deleteMany({ where: { id: jobId } });
    await prisma.user.deleteMany({ where: { id: { in: [supportId, customerId] } } });
    await prisma.$disconnect();
  });

  const request = (search: string) => new Request(`http://localhost/api/v2/admin/incidents?search=${search}`, {
    headers: { "x-idream-user-id": supportId, "x-idream-role": "support" },
  });
  const collaborationInput = (targetId = incidentId) => ({
    path: `collaboration/incident/${targetId}/activity`,
    params: { targetType: "incident", targetId },
    userId: supportId,
    role: "support",
  });
  const watchInput = (targetId = incidentId) => ({
    ...collaborationInput(targetId),
    path: `collaboration/incident/${targetId}/watch`,
    method: "PUT" as const,
    body: { watching: true },
  });

  it("allows a customer-linked Incident and rejects an unrelated unassigned Incident", async () => {
    const response = await listIncidents(request(suffix));
    const body = await response.json();
    expect(body.data.items.map((item: { id: string }) => item.id)).toEqual([incidentId]);
    await expect(getIncidentDetail(request(suffix), incidentId)).resolves.toMatchObject({ status: 200 });
    await expect(getIncidentDetail(request(suffix), hiddenIncidentId)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("allows the same linked Incident's collaboration read as its detail read", async () => {
    const detail = await adminV2Route(incidentRoute, {
      path: `incidents/${incidentId}`, params: { id: incidentId }, userId: supportId, role: "support",
    });
    expect(detail.status).toBe(200);
    const activity = await adminV2Route(activityRoute, collaborationInput());
    expect(activity.status, JSON.stringify(activity.error)).toBe(200);
    expect(activity.data).toMatchObject({ items: [], watching: false, watcherIds: [] });
  });

  it("allows personal Watch and Unwatch without granting Incident management", async () => {
    const input = { ...watchInput(), idempotencyKey: `incident-scope-watch-${suffix}` };
    const watched = await adminV2Route(watchRoute, input);
    expect(watched.status, JSON.stringify(watched.error)).toBe(200);
    expect(watched.data).toEqual({ watching: true, duplicate: false });
    const replay = await adminV2Route(watchRoute, input);
    expect(replay.status).toBe(200);
    expect(replay.data).toEqual({ watching: true, duplicate: true });
    expect(await prisma.adminCollaborationActivity.count({ where: { targetId: incidentId, actorId: supportId } })).toBe(1);
    const activity = await adminV2Route(activityRoute, collaborationInput());
    expect(activity.status).toBe(200);
    expect(activity.data).toMatchObject({ watching: true, watcherIds: [supportId] });
    const stopped = await adminV2Route(watchRoute, { ...watchInput(), body: { watching: false } });
    expect(stopped.status).toBe(200);
    expect(stopped.data).toEqual({ watching: false, duplicate: false });
    expect(await prisma.operationalWorkPreference.findMany({ where: { actorId: supportId, sourceId: incidentId } }))
      .toEqual([expect.objectContaining({ sourceType: "ops_incident", watching: false, version: 2 })]);
    expect(await prisma.opsIncident.findUniqueOrThrow({ where: { id: incidentId } }))
      .toMatchObject({ ownerId: null, status: "triaged", version: 1 });
  });

  it("keeps unrelated and missing Incident collaboration outside read and Watch access", async () => {
    for (const [targetId, status, code] of [
      [hiddenIncidentId, 403, "forbidden"],
      [`missing-${suffix}`, 404, "not_found"],
    ] as const) {
      for (const response of [
        await adminV2Route(activityRoute, collaborationInput(targetId)),
        await adminV2Route(watchRoute, watchInput(targetId)),
      ]) {
        expect(response).toMatchObject({ status, ok: false, error: { code } });
      }
      expect(await prisma.operationalWorkPreference.count({ where: { actorId: supportId, sourceId: targetId } })).toBe(0);
      expect(await prisma.adminCollaborationActivity.count({ where: { targetId, actorId: supportId } })).toBe(0);
    }
  });

  it("does not turn linked Incident read scope into comment or handoff write permission", async () => {
    const activitiesBefore = await prisma.adminCollaborationActivity.count({ where: { targetId: incidentId } });
    for (const body of [
      { kind: "comment", body: "Customer-linked recovery context" },
      { kind: "handoff", body: "Transfer recovery ownership", expectedVersion: 1, metadata: { handoffToActorId: supportId } },
    ]) {
      const response = await adminV2Route(createActivityRoute, { ...collaborationInput(), method: "POST", body });
      expect(response).toMatchObject({ status: 403, ok: false, error: { code: "forbidden" } });
    }
    expect(await prisma.adminCollaborationActivity.count({ where: { targetId: incidentId } })).toBe(activitiesBefore);
    expect(await prisma.opsIncident.findUniqueOrThrow({ where: { id: incidentId } }))
      .toMatchObject({ ownerId: null, status: "triaged", version: 1 });
  });
});
