import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { GET as getIncident } from "@/app/api/v2/admin/incidents/[id]/route";
import { recordGenerationAttemptEvent } from "@/server/ai/generation-attempt-events";
import { prisma } from "@/server/lib/db";
import { postDreamcoinEntry } from "@/server/modules/billing/ledger";
import { reconcileUnknownGenerationRequest } from "../jobs/unknown-reconciliation";
import { executeIncidentActionPlanCommand } from "./action-executor";
import { eligibleOccurrenceIds, occurrenceSnapshot } from "./eligibility";
import { correlateFailedGenerationAttempt, executeIncidentActionPlan, previewIncidentActionPlan } from "./service";

const suffix = randomUUID();
const requestId = `incident-unknown-request-${suffix}`;
const customerId = `incident-unknown-customer-${suffix}`;
const actor = { id: `incident-unknown-admin-${suffix}`, role: "admin" };
let incidentId: string | undefined;

afterAll(async () => {
  const attempts = await prisma.generationAttempt.findMany({ where: { requestId }, select: { id: true } });
  const attemptIds = attempts.map((attempt) => attempt.id);
  const commands = await prisma.controlPlaneCommand.findMany({ where: { actorId: actor.id }, select: { id: true } });
  await prisma.controlPlaneCommandAttempt.deleteMany({ where: { commandId: { in: commands.map((command) => command.id) } } });
  await prisma.controlPlaneCommand.deleteMany({ where: { actorId: actor.id } });
  await prisma.adminAuditLog.deleteMany({ where: { actorId: actor.id } });
  await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: { in: [requestId, ...attemptIds, ...(incidentId ? [incidentId] : [])] } } });
  if (incidentId) {
    await prisma.incidentActionPlan.deleteMany({ where: { incidentId } });
    await prisma.opsIncidentOccurrence.deleteMany({ where: { incidentId } });
    await prisma.opsIncident.delete({ where: { id: incidentId } });
  }
  await prisma.generationSettlementLink.deleteMany({ where: { requestId } });
  await prisma.dreamcoinLedger.deleteMany({ where: { userId: customerId } });
  await prisma.generationJobEvent.deleteMany({ where: { jobId: requestId } });
  await prisma.generationAttemptEvent.deleteMany({ where: { attemptId: { in: attemptIds } } });
  await prisma.generationAttempt.deleteMany({ where: { requestId } });
  await prisma.generationJob.deleteMany({ where: { id: requestId } });
  await prisma.user.deleteMany({ where: { id: { in: [customerId, actor.id] } } });
  await prisma.$disconnect();
});

async function incidentDetail(id: string) {
  const response = await getIncident(new Request(`http://localhost/api/v2/admin/incidents/${id}`, {
    headers: { "x-idream-user-id": actor.id, "x-idream-role": actor.role },
  }), { params: Promise.resolve({ id }) });
  expect(response.status).toBe(200);
  return (await response.json()).data;
}

describe("Incident retry authority for an exhausted source with no provider terminal", () => {
  it("requires Jobs reconciliation before recommending or staging a new Attempt, then permits one confirmed retry", async () => {
    await prisma.user.createMany({ data: [
      { id: customerId, email: `${customerId}@example.test`, role: "user", status: "active" },
      { id: actor.id, email: `${actor.id}@example.test`, role: actor.role, status: "active" },
    ] });
    await prisma.generationJob.create({ data: {
      id: requestId, userId: customerId, mode: "image", controls: {}, presetIds: [],
      provider: "mock", model: "mock-image", status: "queued", costDreamcoins: 5,
    } });
    const attempt = await prisma.generationAttempt.create({ data: {
      requestId, attemptNo: 1, provider: "mock", profileKey: `exhausted-${suffix}`,
      workflowKey: "mock-image", workflowVersion: 1, status: "queued",
    } });
    await prisma.$transaction(async (tx) => {
      await postDreamcoinEntry(tx, { kind: "signup_bonus", userId: customerId, amount: 20, sourceId: `${requestId}-bonus`, idempotencyKey: `${requestId}:bonus` });
      await postDreamcoinEntry(tx, { kind: "generation_spend", userId: customerId, amount: 5, sourceId: requestId, idempotencyKey: `${requestId}:spend` });
      await recordGenerationAttemptEvent(tx, {
        eventId: `${attempt.id}:source-exhausted-outcome-unknown`, attemptId: attempt.id,
        eventType: "generation.attempt.unknown.v1", outcome: "unknown", occurredAt: new Date(),
        payload: { requestId, reason: "source_exhausted_without_terminal_record" },
        errorClass: "generation_source_exhausted", errorCode: "generation_source_exhausted",
        errorSignature: `generation_source_exhausted:${suffix}`, retryability: "operator_retry",
      });
    });
    const incident = await correlateFailedGenerationAttempt(attempt.id);
    incidentId = incident.id;

    expect(eligibleOccurrenceIds("retry_eligible", await occurrenceSnapshot(prisma, incident.id))).toEqual([]);
    expect((await incidentDetail(incident.id)).incident.recommendedActions).not.toContain("retry_eligible");
    await expect(previewIncidentActionPlan({ incidentId: incident.id, action: "retry_eligible", actorId: actor.id }))
      .rejects.toThrow("Review the affected request in Jobs");
    expect(await prisma.incidentActionPlan.count({ where: { incidentId: incident.id } })).toBe(0);
    expect(await prisma.dreamcoinLedger.count({ where: { sourceId: requestId, reason: "refund" } })).toBe(0);
    expect(await prisma.generationTransportExecution.count({ where: { attemptId: attempt.id } })).toBe(0);

    const reconciliation = {
      requestId, actor, idempotencyKey: `${requestId}:confirm-failed`, traceId: `${requestId}:review`,
      command: {
        resolution: "confirm_failed" as const, entityVersion: 1,
        reason: "Worker and provider logs confirm that no output was produced.",
        providerEvidenceRefs: [`attempt-event:${attempt.id}:unknown`], confirmation: `${requestId}:confirm_failed`,
      },
    };
    const settled = await reconcileUnknownGenerationRequest(reconciliation);
    expect(settled).toMatchObject({ requestStatus: "failed", attemptStatus: "unknown", refundAmount: 5 });
    expect(await reconcileUnknownGenerationRequest(reconciliation)).toEqual(settled);
    expect(await prisma.dreamcoinLedger.count({ where: { sourceId: requestId, reason: "refund", delta: 5 } })).toBe(1);
    expect((await incidentDetail(incident.id)).incident.recommendedActions).toContain("retry_eligible");

    const plan = await previewIncidentActionPlan({ incidentId: incident.id, action: "retry_eligible", actorId: actor.id });
    expect(plan.eligibleOccurrenceIds).toHaveLength(1);
    const command = await executeIncidentActionPlan({
      incidentId: incident.id, actionPlanId: plan.id, expectedVersion: plan.incidentVersion,
      actor, confirmation: `${incident.id}:${plan.id}:retry_eligible`, idempotencyKey: `${requestId}:retry`,
    });
    expect(await executeIncidentActionPlanCommand(prisma, { commandId: command.id, workerId: `worker-${suffix}` }))
      .toMatchObject({ status: "verifying" });
    expect(await executeIncidentActionPlanCommand(prisma, { commandId: command.id, workerId: `worker-${suffix}-replay` }))
      .toMatchObject({ status: "verifying" });
    expect(await prisma.generationAttempt.findUniqueOrThrow({ where: { id: attempt.id } }))
      .toMatchObject({ status: "unknown", retryability: "operator_retry", terminalRecordRef: null });
    expect(await prisma.generationAttempt.findFirstOrThrow({ where: { requestId, attemptNo: 2 } }))
      .toMatchObject({ status: "queued", sourceCommandId: command.id });
    expect(await prisma.generationAttempt.count({ where: { requestId } })).toBe(2);
    expect(await prisma.mainOutboxEvent.count({ where: { aggregateId: requestId, eventType: "incident.retry.dispatch.v2" } })).toBe(1);
    expect(eligibleOccurrenceIds("retry_eligible", await occurrenceSnapshot(prisma, incident.id))).toEqual([]);
  });
});
