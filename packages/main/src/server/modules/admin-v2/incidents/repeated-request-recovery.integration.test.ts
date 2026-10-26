import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { adminV2 } from "@/server/test/admin-v2-http";
import { createUser, expectOk } from "@/server/test/helpers";
import { executeIncidentActionPlanCommand } from "./action-executor";
import { correlateFailedGenerationAttempt } from "./service";
import { canonicalSha256 } from "../shared/canonical-json";

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
    const previewKey = `${P}preview`;
    const preview = await adminV2("POST", `incidents/${incidentId}/action-plans/preview`, {
      userId: actorId, role: "admin", idempotencyKey: previewKey, body: { action: "retry_eligible" },
    });
    expectOk(preview);
    const previewCommand = await prisma.controlPlaneCommand.findFirstOrThrow({
      where: { actorId, idempotencyKey: previewKey },
      select: { id: true },
    });
    const plan = preview.data;
    expect(plan.eligibleOccurrenceIds).toHaveLength(3);
    const confirmation = `${incidentId}:${plan.id}:retry_eligible`;
    const path = `incidents/${incidentId}/action-plans/${plan.id}/execute`;
    const admission = {
      userId: actorId, role: "admin", idempotencyKey: `${P}action-plan`,
      body: { entityVersion: plan.incidentVersion, confirmation },
    };
    const accepted = await adminV2("POST", path, admission);
    expectOk(accepted);
    expect(accepted.status).toBe(200);
    expect(await prisma.controlPlaneCommand.findUniqueOrThrow({ where: { id: accepted.data.commandId } })).toMatchObject({
      scope: `incident-action:${actorId}`,
      commandType: "incident.action_plan.execute",
      retryMode: "idempotent",
      requestHash: canonicalSha256({
        incidentId, actionPlanId: plan.id, expectedVersion: plan.incidentVersion, confirmation,
      }),
    });
    await expect(executeIncidentActionPlanCommand(prisma, { commandId: accepted.data.commandId, workerId: `${P}worker` }))
      .resolves.toMatchObject({ status: "verifying" });
    const attempts = await prisma.generationAttempt.findMany({ where: { sourceCommandId: accepted.data.commandId }, orderBy: { requestId: "asc" } });
    expect(attempts.map((row) => row.requestId)).toEqual(requestIds);
    expect(attempts.map((row) => row.attemptNo)).toEqual([3, 2]);
    expect(await prisma.mainOutboxEvent.count({ where: { aggregateId: { in: requestIds }, eventType: "incident.retry.dispatch.v2" } })).toBe(2);
    expect(await prisma.opsIncidentOccurrence.count({ where: { incidentId } })).toBe(3);
    // Admission must replay the historical domain receipt after mitigation changes
    // the Incident version and consumes the frozen eligibility, not prepare new work.
    const replayedAdmission = await adminV2("POST", path, {
      ...admission, headers: { "x-request-id": `${P}replayed-http-request` },
    });
    expectOk(replayedAdmission);
    expect(replayedAdmission.data).toEqual(accepted.data);
    // The earlier preview owns an atomic receipt too. Assert the complete identity
    // set so replay cannot add another preview or another execution command.
    expect(await prisma.controlPlaneCommand.findMany({
      where: { actorId },
      select: { id: true, commandType: true, targetId: true },
      orderBy: { commandType: "asc" },
    })).toEqual([
      { id: accepted.data.commandId, commandType: "incident.action_plan.execute", targetId: plan.id },
      { id: previewCommand.id, commandType: "incident.action_plan.preview", targetId: incidentId },
    ]);
    await expect(executeIncidentActionPlanCommand(prisma, { commandId: accepted.data.commandId, workerId: `${P}replay` }))
      .resolves.toMatchObject({ status: "verifying" });
    expect(await prisma.generationAttempt.count({ where: { sourceCommandId: accepted.data.commandId } })).toBe(2);
  });
});
