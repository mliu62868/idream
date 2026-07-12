import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { closeIncidentWithPostmortem, mergeIncidents, splitIncidentOccurrences } from "./service";

describe("Incident correlation correction and close lifecycle", () => {
  const suffix = randomUUID();
  const actor = { id: `incident-lifecycle-actor-${suffix}`, role: "ops" } as const;
  const incidentA = `incident-lifecycle-a-${suffix}`;
  const incidentB = `incident-lifecycle-b-${suffix}`;
  const occurrenceIds = [`incident-lifecycle-occ-1-${suffix}`, `incident-lifecycle-occ-2-${suffix}`, `incident-lifecycle-occ-3-${suffix}`];
  let splitIncidentId = "";

  beforeAll(async () => {
    const base = { signature: `signature-${suffix}`, signatureVersion: "generation-error-v1", status: "triaged", severity: "medium", firstSeen: new Date("2026-07-11T10:00:00Z"), lastSeen: new Date("2026-07-11T10:10:00Z"), impact: {}, mitigation: {} };
    await prisma.opsIncident.create({ data: { id: incidentA, ...base, activeCorrelationKey: `active-a-${suffix}` } });
    await prisma.opsIncident.create({ data: { id: incidentB, ...base, activeCorrelationKey: `active-b-${suffix}` } });
    await prisma.opsIncidentOccurrence.createMany({ data: [
      { id: occurrenceIds[0], incidentId: incidentA, requestId: `request-1-${suffix}`, occurrenceKey: `occurrence-1-${suffix}`, observedAt: new Date("2026-07-11T10:00:00Z") },
      { id: occurrenceIds[1], incidentId: incidentA, requestId: `request-2-${suffix}`, occurrenceKey: `occurrence-2-${suffix}`, observedAt: new Date("2026-07-11T10:05:00Z") },
      { id: occurrenceIds[2], incidentId: incidentB, requestId: `request-3-${suffix}`, occurrenceKey: `occurrence-3-${suffix}`, observedAt: new Date("2026-07-11T10:10:00Z") },
    ] });
  });

  afterAll(async () => {
    const incidentIds = [incidentA, incidentB, splitIncidentId].filter(Boolean);
    await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: { in: incidentIds } } });
    await prisma.adminAuditLog.deleteMany({ where: { actorId: actor.id } });
    await prisma.incidentPostmortem.deleteMany({ where: { incidentId: { in: incidentIds } } });
    await prisma.opsIncidentOccurrenceAssignment.deleteMany({ where: { occurrenceId: { in: occurrenceIds } } });
    await prisma.opsIncidentOccurrence.deleteMany({ where: { id: { in: occurrenceIds } } });
    await prisma.opsIncident.deleteMany({ where: { id: { in: incidentIds } } });
    await prisma.$disconnect();
  });

  it("preserves assignment history across split and merge, then requires a postmortem to close", async () => {
    const split = await splitIncidentOccurrences({ incidentId: incidentA, expectedVersion: 1, occurrenceIds: [occurrenceIds[1]], actor, reason: "Different provider failure mode", requestId: `split-${suffix}` });
    splitIncidentId = split.createdIncidentId;
    await expect(prisma.opsIncidentOccurrence.findUnique({ where: { id: occurrenceIds[1] } })).resolves.toMatchObject({ incidentId: splitIncidentId });
    await expect(prisma.opsIncidentOccurrenceAssignment.findMany({ where: { occurrenceId: occurrenceIds[1] } })).resolves.toEqual([expect.objectContaining({ fromIncidentId: incidentA, toIncidentId: splitIncidentId, action: "split" })]);

    const merged = await mergeIncidents({ targetIncidentId: incidentB, expectedVersion: 1, sources: [{ incidentId: splitIncidentId, version: 1 }], actor, reason: "Independent review found the same operational incident", requestId: `merge-${suffix}` });
    expect(merged).toMatchObject({ targetIncidentId: incidentB, mergedIncidentIds: [splitIncidentId], movedOccurrenceCount: 1 });
    await expect(prisma.opsIncident.findUnique({ where: { id: splitIncidentId } })).resolves.toMatchObject({ status: "merged", activeCorrelationKey: null, version: 2 });
    await expect(prisma.opsIncidentOccurrenceAssignment.findMany({ where: { occurrenceId: occurrenceIds[1] }, orderBy: { createdAt: "asc" } })).resolves.toEqual([
      expect.objectContaining({ action: "split", fromIncidentId: incidentA, toIncidentId: splitIncidentId }),
      expect.objectContaining({ action: "merge", fromIncidentId: splitIncidentId, toIncidentId: incidentB }),
    ]);

    const resolved = await prisma.opsIncident.update({ where: { id: incidentB }, data: { status: "resolved", verificationState: "passed", version: { increment: 1 } } });
    const closed = await closeIncidentWithPostmortem({ incidentId: incidentB, expectedVersion: resolved.version, actor, summary: "Recovered the generation route and reconciled every affected request.", rootCause: "Provider route regression", contributingFactors: ["Capacity alert lag"], correctiveActions: ["Add route canary"], evidenceRefs: [`monitor://${suffix}`], reason: "Postmortem reviewed", requestId: `close-${suffix}` });
    expect(closed).toMatchObject({ incidentId: incidentB, status: "closed", verificationState: "passed" });
    await expect(prisma.opsIncident.findUniqueOrThrow({ where: { id: incidentB } })).resolves.toMatchObject({ status: "closed", activeCorrelationKey: null });
    await expect(prisma.incidentPostmortem.findUnique({ where: { incidentId: incidentB } })).resolves.toMatchObject({ rootCause: "Provider route regression", createdById: actor.id });
  });
});
