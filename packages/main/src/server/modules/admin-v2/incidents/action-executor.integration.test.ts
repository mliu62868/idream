import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import {
  correlateFailedGenerationAttempt,
  executeIncidentActionPlan,
  previewIncidentActionPlan,
} from "./service";
import { executeIncidentActionPlanCommand } from "./action-executor";

describe("Incident action-plan durable executor", () => {
  const suffix = randomUUID();
  const actorId = `incident-action-admin-${suffix}`;
  const actor = { id: actorId, role: "admin" } as const;
  const userIds = ["refund", "pause", "rollback"].map((kind) => `incident-action-${kind}-user-${suffix}`);
  const jobIds = ["refund", "pause", "rollback"].map((kind) => `incident-action-${kind}-job-${suffix}`);
  const attemptIds = ["refund", "pause", "rollback"].map((kind) => `incident-action-${kind}-attempt-${suffix}`);
  const incidentIds: string[] = [];
  const commandIds: string[] = [];
  const refundProfileKey = `incident-refund-profile-${suffix}`;
  const pauseProfileKey = `incident-pause-profile-${suffix}`;
  const rollbackProfileKey = `incident-rollback-profile-${suffix}`;

  beforeAll(async () => {
    await prisma.user.createMany({
      data: [
        { id: actorId, email: `${actorId}@idream.internal`, role: "admin", status: "active" },
        ...userIds.map((id) => ({ id, email: `${id}@customer.local`, role: "user", status: "active" })),
      ],
    });
    await prisma.generationJob.createMany({
      data: jobIds.map((id, index) => ({
        id,
        userId: userIds[index],
        mode: "image",
        controls: {},
        presetIds: [],
        status: "failed",
      })),
    });
    await prisma.dreamcoinLedger.create({
      data: {
        userId: userIds[0],
        delta: -12,
        balanceAfter: 88,
        reason: "generation_spend",
        sourceId: jobIds[0],
        idempotencyKey: `incident-action-spend-${suffix}`,
      },
    });
    await prisma.generationAttempt.createMany({
      data: [
        { id: attemptIds[0], requestId: jobIds[0], attemptNo: 1, provider: "refund-provider", profileKey: refundProfileKey, workflowKey: "refund-workflow", status: "failed", errorClass: "provider_error", errorSignature: `refund-${suffix}`, retryability: "not_retryable", finishedAt: new Date() },
        { id: attemptIds[1], requestId: jobIds[1], attemptNo: 1, provider: "pause-provider", profileKey: pauseProfileKey, workflowKey: "pause-workflow", status: "failed", errorClass: "provider_error", errorSignature: `pause-${suffix}`, retryability: "operator_retry", finishedAt: new Date() },
        { id: attemptIds[2], requestId: jobIds[2], attemptNo: 1, provider: "rollback-provider", profileKey: rollbackProfileKey, workflowKey: "rollback-workflow", status: "failed", errorClass: "provider_error", errorSignature: `rollback-${suffix}`, retryability: "operator_retry", finishedAt: new Date() },
      ],
    });
    await prisma.generationProviderRoute.create({
      data: { id: `incident-action-route-${suffix}`, profileKey: pauseProfileKey, provider: "pause-provider", enabled: true },
    });
    await prisma.generationModelProfile.createMany({
      data: [
        { id: `incident-action-rollback-v1-${suffix}`, profileKey: rollbackProfileKey, label: "Rollback v1", pipelineModel: "rollback-v1", allowedOrientations: ["1:1"], version: 1, status: "archived", enabled: true, archivedAt: new Date() },
        { id: `incident-action-rollback-v2-${suffix}`, profileKey: rollbackProfileKey, label: "Rollback v2", pipelineModel: "rollback-v2", allowedOrientations: ["1:1"], version: 2, status: "active", enabled: true, publishedAt: new Date() },
      ],
    });
  });

  afterAll(async () => {
    await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: { in: incidentIds } } });
    await prisma.adminAuditLog.deleteMany({ where: { OR: [{ actorId }, { targetId: { in: incidentIds } }] } });
    await prisma.controlPlaneCommandAttempt.deleteMany({ where: { commandId: { in: commandIds } } });
    await prisma.controlPlaneCommand.deleteMany({ where: { id: { in: commandIds } } });
    await prisma.incidentActionPlan.deleteMany({ where: { incidentId: { in: incidentIds } } });
    await prisma.opsIncidentOccurrence.deleteMany({ where: { incidentId: { in: incidentIds } } });
    await prisma.opsIncident.deleteMany({ where: { id: { in: incidentIds } } });
    await prisma.generationAttempt.deleteMany({ where: { id: { in: attemptIds } } });
    await prisma.dreamcoinLedger.deleteMany({ where: { sourceId: { in: jobIds } } });
    await prisma.generationJob.deleteMany({ where: { id: { in: jobIds } } });
    await prisma.generationProviderRoute.deleteMany({ where: { profileKey: pauseProfileKey } });
    await prisma.generationModelProfile.deleteMany({ where: { profileKey: rollbackProfileKey } });
    await prisma.user.deleteMany({ where: { id: { in: [actorId, ...userIds] } } });
    await prisma.$disconnect();
  });

  async function execute(kind: "refund" | "pause_route" | "rollback", attemptId: string, targetVersion?: string) {
    const incident = await correlateFailedGenerationAttempt(attemptId);
    incidentIds.push(incident.id);
    const plan = await previewIncidentActionPlan({
      incidentId: incident.id,
      action: kind,
      actorId,
      targetVersion,
    });
    const command = await executeIncidentActionPlan({
      incidentId: incident.id,
      actionPlanId: plan.id,
      expectedVersion: incident.version,
      actor,
      confirmation: `${incident.id}:${plan.id}:${kind}`,
      idempotencyKey: `incident-action-${kind}-${suffix}`,
    });
    commandIds.push(command.id);
    expect(command.status).toBe("accepted");
    return executeIncidentActionPlanCommand(prisma, {
      commandId: command.id,
      workerId: `incident-action-worker-${kind}-${suffix}`,
    });
  }

  it("settles only the outstanding captured spend", async () => {
    await expect(execute("refund", attemptIds[0])).resolves.toMatchObject({ status: "succeeded" });
    await expect(prisma.dreamcoinLedger.findFirst({
      where: { sourceId: jobIds[0], reason: "refund" },
    })).resolves.toMatchObject({ delta: 12 });
    await expect(prisma.generationJob.findUnique({ where: { id: jobIds[0] } })).resolves.toMatchObject({ status: "refunded" });
  });

  it("pauses the exact provider route from the Incident signature", async () => {
    await expect(execute("pause_route", attemptIds[1])).resolves.toMatchObject({ status: "succeeded" });
    await expect(prisma.generationProviderRoute.findFirst({ where: { profileKey: pauseProfileKey } })).resolves.toMatchObject({ enabled: false });
  });

  it("rolls back to an existing immutable profile version", async () => {
    await expect(execute("rollback", attemptIds[2], "1")).resolves.toMatchObject({ status: "succeeded" });
    await expect(prisma.generationModelProfile.findFirst({ where: { profileKey: rollbackProfileKey, version: 1 } })).resolves.toMatchObject({ status: "active" });
    await expect(prisma.generationModelProfile.findFirst({ where: { profileKey: rollbackProfileKey, version: 2 } })).resolves.toMatchObject({ status: "archived" });
  });
});
