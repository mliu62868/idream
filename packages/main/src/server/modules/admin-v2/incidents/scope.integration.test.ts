import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
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

  it("allows a customer-linked Incident and rejects an unrelated unassigned Incident", async () => {
    const response = await listIncidents(request(suffix));
    const body = await response.json();
    expect(body.data.items.map((item: { id: string }) => item.id)).toEqual([incidentId]);
    await expect(getIncidentDetail(request(suffix), incidentId)).resolves.toMatchObject({ status: 200 });
    await expect(getIncidentDetail(request(suffix), hiddenIncidentId)).rejects.toMatchObject({ code: "forbidden" });
  });
});
