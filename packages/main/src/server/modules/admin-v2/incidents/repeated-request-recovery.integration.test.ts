import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { adminV2 } from "@/server/test/admin-v2-http";
import { createUser, expectOk } from "@/server/test/helpers";
import { executeIncidentActionPlanCommand } from "./action-executor";
import { correlateFailedGenerationAttempt } from "./service";

const P = "zt-incident-repeat-request-";
const actorId = `${P}admin`;
const requestIds = [`${P}first`, `${P}second`];
const customerIds = requestIds.map((id) => `${id}-customer`);
let incidentId: string;

beforeAll(async () => {
  await createUser({ id: actorId, role: "admin", dataClass: "internal" });
  for (const id of customerIds) await createUser({ id, dataClass: "customer" });
  await prisma.generationJob.createMany({ data: requestIds.map((id, index) => ({
    id, userId: customerIds[index], mode: "image", controls: {}, presetIds: [],
    provider: "mock", model: "mock-image", status: "failed",
  })) });
  const failures = [
    { id: `${P}attempt-1`, requestId: requestIds[0], attemptNo: 1 },
    { id: `${P}attempt-2`, requestId: requestIds[0], attemptNo: 2 },
    { id: `${P}attempt-3`, requestId: requestIds[1], attemptNo: 1 },
  ];
  for (const failure of failures) {
    await prisma.generationAttempt.create({ data: {
      ...failure, provider: "mock", profileKey: `${P}profile`, workflowKey: "mock-image", workflowVersion: 1,
      status: "failed", retryability: "operator_retry", errorClass: "provider_error", errorSignature: P,
      finishedAt: new Date(),
    } });
    incidentId = (await correlateFailedGenerationAttempt(failure.id)).id;
  }
});

afterAll(async () => {
  const commands = await prisma.controlPlaneCommand.findMany({ where: { actorId }, select: { id: true } });
  const attempts = await prisma.generationAttempt.findMany({ where: { requestId: { in: requestIds } }, select: { id: true } });
  await prisma.controlPlaneCommandAttempt.deleteMany({ where: { commandId: { in: commands.map((row) => row.id) } } });
  await prisma.controlPlaneCommand.deleteMany({ where: { actorId } });
  await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: { in: [...requestIds, ...attempts.map((row) => row.id), ...(incidentId ? [incidentId] : [])] } } });
  await prisma.adminAuditLog.deleteMany({ where: { OR: [{ actorId }, { targetId: incidentId }] } });
  if (incidentId) {
    await prisma.incidentActionPlan.deleteMany({ where: { incidentId } });
    await prisma.opsIncidentOccurrence.deleteMany({ where: { incidentId } });
    await prisma.opsIncident.deleteMany({ where: { id: incidentId } });
  }
  await prisma.generationAttemptEvent.deleteMany({ where: { attemptId: { in: attempts.map((row) => row.id) } } });
  await prisma.generationJobEvent.deleteMany({ where: { jobId: { in: requestIds } } });
  await prisma.generationAttempt.deleteMany({ where: { requestId: { in: requestIds } } });
  await prisma.generationJob.deleteMany({ where: { id: { in: requestIds } } });
  await prisma.user.deleteMany({ where: { id: { in: [actorId, ...customerIds] } } });
});

describe("Incident recovery after repeated failures of the same request", () => {
  it("preserves every occurrence while dispatching one retry per original request", async () => {
    const preview = await adminV2("POST", `incidents/${incidentId}/action-plans/preview`, {
      userId: actorId, role: "admin", body: { action: "retry_eligible" },
    });
    expectOk(preview);
    const plan = preview.data;
    expect(plan.eligibleOccurrenceIds).toHaveLength(3);
    const accepted = await adminV2("POST", `incidents/${incidentId}/action-plans/${plan.id}/execute`, {
      userId: actorId, role: "admin", body: { entityVersion: plan.incidentVersion, confirmation: `${incidentId}:${plan.id}:retry_eligible` },
    });
    expectOk(accepted);
    await expect(executeIncidentActionPlanCommand(prisma, { commandId: accepted.data.commandId, workerId: `${P}worker` }))
      .resolves.toMatchObject({ status: "verifying" });
    const attempts = await prisma.generationAttempt.findMany({ where: { sourceCommandId: accepted.data.commandId }, orderBy: { requestId: "asc" } });
    expect(attempts.map((row) => row.requestId)).toEqual(requestIds);
    expect(attempts.map((row) => row.attemptNo)).toEqual([3, 2]);
    expect(await prisma.mainOutboxEvent.count({ where: { aggregateId: { in: requestIds }, eventType: "incident.retry.dispatch.v2" } })).toBe(2);
    expect(await prisma.opsIncidentOccurrence.count({ where: { incidentId } })).toBe(3);
    await expect(executeIncidentActionPlanCommand(prisma, { commandId: accepted.data.commandId, workerId: `${P}replay` }))
      .resolves.toMatchObject({ status: "verifying" });
    expect(await prisma.generationAttempt.count({ where: { sourceCommandId: accepted.data.commandId } })).toBe(2);
  });
});
