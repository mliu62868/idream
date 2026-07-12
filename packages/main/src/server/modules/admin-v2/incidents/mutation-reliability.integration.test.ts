import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PATCH as triageIncidentRoute } from "@/app/api/v2/admin/incidents/[id]/route";
import { POST as closeIncidentRoute } from "@/app/api/v2/admin/incidents/[id]/commands/close/route";
import { prisma } from "@/server/lib/db";

describe("Incident mutation reliability", () => {
  const suffix = randomUUID();
  const actorId = `incident-reliability-admin-${suffix}`;
  const incidentId = `incident-reliability-${suffix}`;
  const context = { params: Promise.resolve({ id: incidentId }) };
  const headers = { "content-type": "application/json", "x-idream-user-id": actorId, "x-idream-role": "admin" };

  beforeAll(async () => {
    await prisma.user.create({ data: { id: actorId, email: `${actorId}@example.test`, role: "admin", status: "active" } });
    await prisma.opsIncident.create({ data: {
      id: incidentId,
      signature: `reliability-${suffix}`,
      signatureVersion: "v1",
      activeCorrelationKey: `reliability-${suffix}`,
      status: "detected",
      severity: "medium",
      firstSeen: new Date(),
      lastSeen: new Date(),
      impact: {},
      mitigation: {},
    } });
  });

  afterAll(async () => {
    await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: incidentId } });
    await prisma.adminAuditLog.deleteMany({ where: { targetId: incidentId } });
    await prisma.controlPlaneCommand.deleteMany({ where: { targetId: incidentId } });
    await prisma.opsIncident.deleteMany({ where: { id: incidentId } });
    await prisma.user.deleteMany({ where: { id: actorId } });
    await prisma.$disconnect();
  });

  it("requires matching If-Match before Incident triage", async () => {
    const response = await triageIncidentRoute(new Request(`http://localhost/api/v2/admin/incidents/${incidentId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ entityVersion: 1, ownerId: actorId, reason: "Take incident" }),
    }), context);
    expect(response.status).toBe(400);
    await expect(prisma.opsIncident.findUniqueOrThrow({ where: { id: incidentId } })).resolves.toMatchObject({ ownerId: null, version: 1 });
  });

  it("requires Idempotency-Key before Incident close", async () => {
    const response = await closeIncidentRoute(new Request(`http://localhost/api/v2/admin/incidents/${incidentId}/commands/close`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        entityVersion: 1,
        summary: "Complete postmortem summary",
        rootCause: "route failure",
        contributingFactors: [],
        correctiveActions: ["Add route guard"],
        evidenceRefs: ["evidence:one"],
        reason: "Close incident",
        confirmation: `${incidentId}:close`,
      }),
    }), context);
    expect(response.status).toBe(400);
  });
});
