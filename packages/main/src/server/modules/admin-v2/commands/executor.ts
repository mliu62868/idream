import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { claimControlPlaneCommand } from "../shared/control-plane-command";
import { transitionControlPlaneCommandAttempt } from "../shared/control-plane-command-attempt";
import { transitionControlPlaneCommand } from "../shared/control-plane-command-transition";
import { toInputJson } from "../shared/prisma-json";
import { MAIN_TO_CHAT_EVENTS } from "@idream/shared/contracts";
import { recordMainToChatEvent } from "@/processes/chat-outbox";
import { executeCreativeRetryCommand } from "../creative/retry-executor";
import { executeIncidentActionPlanCommand } from "../incidents/action-executor";
import { transitionIncident } from "../incidents/transition";
import { transitionCase } from "../cases/transition";
import {
  isAdminCaseTransitionAllowed,
  isIncidentTransitionAllowed,
} from "../shared/state-transition-authority";

const WORKER_ID = "admin-v2-inline-executor";

async function failCommand(commandId: string, attemptNo: number, error: unknown) {
  const payload = {
    code: "domain_invariant_failed",
    message: error instanceof Error ? error.message : "Command execution failed",
  };
  await prisma.$transaction(async (tx) => {
    await transitionControlPlaneCommand(tx, {
      commandId,
      to: "failed",
      expected: { from: ["running", "verifying"], leaseOwner: WORKER_ID },
      data: {
        error: toInputJson(payload),
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        finishedAt: new Date(),
      },
    });
    await transitionControlPlaneCommandAttempt(tx, {
      commandId,
      attemptNo,
      to: "failed",
      data: { error: toInputJson(payload), finishedAt: new Date() },
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
      if (!isIncidentTransitionAllowed(incident.status, "resolved") || !["passed", "overridden"].includes(incident.verificationState)) {
        throw Errors.conflict("Incident recovery verification is not complete");
      }
      const updated = await transitionIncident(tx, {
        incidentId: incident.id,
        to: "resolved",
        expected: { from: "monitoring", version: incident.version },
        data: {
          activeCorrelationKey: null,
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
      const command = await transitionControlPlaneCommand(tx, {
        commandId: claimed.id,
        to: "succeeded",
        expected: { from: "running", leaseOwner: WORKER_ID, attemptCount: claimed.attemptCount },
        data: {
          result: toInputJson(result),
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          finishedAt: new Date(),
        },
      });
      await transitionControlPlaneCommandAttempt(tx, {
        commandId: claimed.id,
        attemptNo: claimed.attemptCount,
        to: "succeeded",
        data: { finishedAt: new Date() },
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
        !isAdminCaseTransitionAllowed(adminCase.status, "closed") ||
        adminCase.resolution === null ||
        !["passed", "overridden"].includes(adminCase.verificationState)
      ) {
        throw Errors.conflict("Case decision and downstream verification are incomplete");
      }
      const updated = await transitionCase(tx, {
        caseId: adminCase.id,
        to: "closed",
        expected: { from: "resolved", version: adminCase.version },
        data: { activeKey: null },
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
      const command = await transitionControlPlaneCommand(tx, {
        commandId: claimed.id,
        to: "succeeded",
        expected: { from: "running", leaseOwner: WORKER_ID, attemptCount: claimed.attemptCount },
        data: {
          result: toInputJson(result),
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          finishedAt: new Date(),
        },
      });
      await transitionControlPlaneCommandAttempt(tx, {
        commandId: claimed.id,
        attemptNo: claimed.attemptCount,
        to: "succeeded",
        data: { finishedAt: new Date() },
      });
      return command;
    });
  } catch (error) {
    await failCommand(claimed.id, claimed.attemptCount, error);
    throw error;
  }
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requiredString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || !value) {
    throw Errors.badRequest(`Migration command payload is missing ${key}`);
  }
  return value;
}

function nullableString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  if (value === null) return null;
  if (typeof value !== "string" || !value) {
    throw Errors.badRequest(`Migration command payload has invalid ${key}`);
  }
  return value;
}

async function executeMigrateSessionRelease(commandId: string) {
  const claimed = await claimControlPlaneCommand(prisma, {
    commandId,
    workerId: WORKER_ID,
    leaseMs: 30_000,
  });
  if (!claimed) return prisma.controlPlaneCommand.findUniqueOrThrow({ where: { id: commandId } });
  try {
    return await prisma.$transaction(async (tx) => {
      const payload = jsonObject(claimed.requestPayload);
      const characterId = requiredString(payload, "characterId");
      const toCharacterContentVersionId = requiredString(payload, "toCharacterContentVersionId");
      const toCharacterReleaseId = requiredString(payload, "toCharacterReleaseId");
      const fromCharacterContentVersionId = nullableString(payload, "fromCharacterContentVersionId");
      const fromCharacterReleaseId = nullableString(payload, "fromCharacterReleaseId");
      const reason = jsonObject(payload.reason);
      const compatibilityQa = jsonObject(payload.compatibilityQa);
      if (compatibilityQa.status !== "passed") {
        throw Errors.conflict("Compatibility QA is no longer passing");
      }
      // Interactive transactions own one pg connection; keep authority reads
      // sequential so the adapter never multiplexes a busy client.
      const release = await tx.characterRelease.findUnique({ where: { id: toCharacterReleaseId } });
      const content = await tx.characterContentVersion.findUnique({
        where: { id: toCharacterContentVersionId },
      });
      if (
        !release ||
        !content ||
        content.characterId !== characterId ||
        release.characterContentVersionId !== content.id ||
        release.version !== claimed.expectedVersion
      ) {
        throw Errors.conflict("Target Release changed before session migration dispatch");
      }
      const eventId = `session-release-migration:${claimed.id}`;
      const eventPayload = {
        commandId: claimed.id,
        sessionId: claimed.targetId,
        characterId,
        fromCharacterContentVersionId,
        fromCharacterReleaseId,
        toCharacterContentVersionId,
        toCharacterReleaseId,
        reason: typeof reason.summary === "string" ? reason.summary : "compatibility migration",
        compatibilityQa,
        requestedById: claimed.actorId,
      };
      await recordMainToChatEvent({
        eventId,
        eventType: MAIN_TO_CHAT_EVENTS.sessionReleaseMigrationRequested,
        schemaVersion: 2,
        aggregateType: "chat_session",
        aggregateId: claimed.targetId,
        payload: eventPayload,
      }, tx);
      return transitionControlPlaneCommand(tx, {
        commandId: claimed.id,
        to: "verifying",
        expected: { from: "running", leaseOwner: WORKER_ID, attemptCount: claimed.attemptCount },
        data: {
          result: toInputJson({
            sessionId: claimed.targetId,
            dispatchEventId: eventId,
            verificationState: "verifying",
          }),
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: new Date(),
        },
      });
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
  if (command.commandType === "creative.run.retry_failed") {
    return executeCreativeRetryCommand(prisma, { commandId: command.id, workerId: WORKER_ID });
  }
  if (command.commandType === "incident.action_plan.execute") {
    return executeIncidentActionPlanCommand(prisma, {
      commandId: command.id,
      workerId: WORKER_ID,
    });
  }
  if (command.commandType === "incident.resolve") return executeResolveIncident(command.id);
  if (command.commandType === "case.close") return executeCloseCase(command.id);
  if (command.commandType === "chat.session_release.migrate") {
    return executeMigrateSessionRelease(command.id);
  }
  throw Errors.badRequest("No executor is registered for command", { commandType: command.commandType });
}
