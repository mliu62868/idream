import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { claimControlPlaneCommand } from "../shared/control-plane-command";
import { toInputJson } from "../shared/prisma-json";

const WORKER_ID = "admin-v2-inline-executor";

async function failCommand(commandId: string, attemptNo: number, error: unknown) {
  const payload = {
    code: "domain_invariant_failed",
    message: error instanceof Error ? error.message : "Command execution failed",
  };
  await prisma.$transaction(async (tx) => {
    await tx.controlPlaneCommand.updateMany({
      where: { id: commandId, status: { in: ["running", "verifying"] }, leaseOwner: WORKER_ID },
      data: {
        status: "failed",
        error: toInputJson(payload),
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        finishedAt: new Date(),
      },
    });
    await tx.controlPlaneCommandAttempt.updateMany({
      where: { commandId, attemptNo, status: "running" },
      data: { status: "failed", error: toInputJson(payload), finishedAt: new Date() },
    });
  });
}

async function executeResolveIncident(commandId: string) {
  const claimed = await claimControlPlaneCommand(prisma, {
    commandId,
    workerId: WORKER_ID,
    leaseMs: 30_000,
  });
  if (!claimed) return prisma.controlPlaneCommand.findUniqueOrThrow({ where: { id: commandId } });
  try {
    return await prisma.$transaction(async (tx) => {
      const incident = await tx.opsIncident.findUnique({ where: { id: claimed.targetId } });
      if (!incident) throw Errors.notFound("Incident not found during command execution");
      if (incident.version !== claimed.expectedVersion) throw Errors.conflict("Incident changed before resolve execution");
      if (incident.status !== "monitoring" || !["passed", "overridden"].includes(incident.verificationState)) {
        throw Errors.conflict("Incident recovery verification is not complete");
      }
      const updated = await tx.opsIncident.update({
        where: { id: incident.id, version: incident.version },
        data: {
          status: "resolved",
          activeCorrelationKey: null,
          version: { increment: 1 },
        },
      });
      await tx.adminAuditLog.create({
        data: {
          actorId: claimed.actorId,
          actorRole: "command_executor",
          action: "incident.resolved",
          targetType: "ops_incident",
          targetId: incident.id,
          reason: "Recovery verification passed and resolve command executed",
          before: toInputJson({ status: incident.status, version: incident.version }),
          after: toInputJson({ status: updated.status, version: updated.version, verificationState: updated.verificationState }),
          requestId: claimed.requestId,
        },
      });
      await tx.mainOutboxEvent.create({
        data: {
          eventType: "ops.incident.resolved.v2",
          aggregateType: "ops_incident",
          aggregateId: incident.id,
          payload: toInputJson({ incidentId: incident.id, version: updated.version, commandId: claimed.id }),
        },
      });
      const result = { incidentId: incident.id, status: updated.status, version: updated.version, verificationState: updated.verificationState };
      const command = await tx.controlPlaneCommand.update({
        where: { id: claimed.id },
        data: {
          status: "succeeded",
          result: toInputJson(result),
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          finishedAt: new Date(),
        },
      });
      await tx.controlPlaneCommandAttempt.update({
        where: { commandId_attemptNo: { commandId: claimed.id, attemptNo: claimed.attemptCount } },
        data: { status: "succeeded", finishedAt: new Date() },
      });
      return command;
    });
  } catch (error) {
    await failCommand(claimed.id, claimed.attemptCount, error);
    throw error;
  }
}

async function executeCloseCase(commandId: string) {
  const claimed = await claimControlPlaneCommand(prisma, {
    commandId,
    workerId: WORKER_ID,
    leaseMs: 30_000,
  });
  if (!claimed) return prisma.controlPlaneCommand.findUniqueOrThrow({ where: { id: commandId } });
  try {
    return await prisma.$transaction(async (tx) => {
      const adminCase = await tx.adminCase.findUnique({ where: { id: claimed.targetId } });
      if (!adminCase) throw Errors.notFound("Case not found during command execution");
      if (adminCase.version !== claimed.expectedVersion) throw Errors.conflict("Case changed before close execution");
      if (
        adminCase.status !== "resolved" ||
        adminCase.resolution === null ||
        !["passed", "overridden"].includes(adminCase.verificationState)
      ) {
        throw Errors.conflict("Case decision and downstream verification are incomplete");
      }
      const updated = await tx.adminCase.update({
        where: { id: adminCase.id, version: adminCase.version },
        data: { status: "closed", activeKey: null, version: { increment: 1 } },
      });
      await tx.adminAuditLog.create({
        data: {
          actorId: claimed.actorId,
          actorRole: "command_executor",
          action: "case.closed",
          targetType: "admin_case",
          targetId: adminCase.id,
          reason: "Verified resolution command executed",
          before: toInputJson({ status: adminCase.status, version: adminCase.version }),
          after: toInputJson({ status: updated.status, version: updated.version, verificationState: updated.verificationState }),
          requestId: claimed.requestId,
        },
      });
      await tx.mainOutboxEvent.create({
        data: {
          eventType: "admin.case.closed.v2",
          aggregateType: "admin_case",
          aggregateId: adminCase.id,
          payload: toInputJson({ caseId: adminCase.id, version: updated.version, commandId: claimed.id }),
        },
      });
      const result = { caseId: adminCase.id, status: updated.status, version: updated.version, verificationState: updated.verificationState };
      const command = await tx.controlPlaneCommand.update({
        where: { id: claimed.id },
        data: {
          status: "succeeded",
          result: toInputJson(result),
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          finishedAt: new Date(),
        },
      });
      await tx.controlPlaneCommandAttempt.update({
        where: { commandId_attemptNo: { commandId: claimed.id, attemptNo: claimed.attemptCount } },
        data: { status: "succeeded", finishedAt: new Date() },
      });
      return command;
    });
  } catch (error) {
    await failCommand(claimed.id, claimed.attemptCount, error);
    throw error;
  }
}

export async function executeAcceptedAdminCommand(commandId: string) {
  const command = await prisma.controlPlaneCommand.findUnique({ where: { id: commandId } });
  if (!command) throw Errors.notFound("Control-plane command not found");
  if (["succeeded", "failed", "cancelled"].includes(command.status)) return command;
  if (command.commandType === "incident.resolve") return executeResolveIncident(command.id);
  if (command.commandType === "case.close") return executeCloseCase(command.id);
  throw Errors.badRequest("No executor is registered for command", { commandType: command.commandType });
}

