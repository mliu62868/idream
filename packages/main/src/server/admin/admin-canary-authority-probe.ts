import { prisma } from "@/server/lib/db";
import type {
  AdminCanaryAuthorityProbeResult,
  AdminCanaryAuthorityVerifier,
} from "./admin-canary-runner";

type AuthorityProbeDatabase = Pick<
  typeof prisma,
  "controlPlaneCommand" | "adminAuditLog" | "mainOutboxEvent"
>;

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export async function verifyAdminCanaryAuthority(
  input: Parameters<AdminCanaryAuthorityVerifier>[0],
  db: AuthorityProbeDatabase = prisma,
): Promise<AdminCanaryAuthorityProbeResult> {
  const checks = [];
  for (const expected of input.commands) {
    const command = await db.controlPlaneCommand.findUnique({
      where: { id: expected.commandId },
      select: {
        id: true,
        commandType: true,
        targetType: true,
        targetId: true,
        requestId: true,
        retryMode: true,
        status: true,
        createdAt: true,
      },
    });
    const audit = command
      ? await db.adminAuditLog.findFirst({
          where: {
            action: "case.closed",
            targetType: "admin_case",
            targetId: expected.caseId,
            requestId: expected.requestId,
            createdAt: { gte: command.createdAt },
          },
          select: { id: true },
        })
      : null;
    const outboxCandidates = command
      ? await db.mainOutboxEvent.findMany({
          where: {
            eventType: "admin.case.closed.v2",
            aggregateType: "admin_case",
            aggregateId: expected.caseId,
            createdAt: { gte: command.createdAt },
          },
          select: { id: true, payload: true },
        })
      : [];
    const outbox = outboxCandidates.find((candidate) =>
      record(candidate.payload).commandId === expected.commandId
    ) ?? null;
    const passed = command?.commandType === "case.close"
      && command.targetType === "admin_case"
      && command.targetId === expected.caseId
      && command.requestId === expected.requestId
      && command.retryMode === "idempotent"
      && command.status === "succeeded"
      && audit !== null
      && outbox !== null;
    checks.push({
      iteration: expected.iteration,
      commandId: expected.commandId,
      commandStatus: command?.status ?? null,
      auditRecordId: audit?.id ?? null,
      outboxEventId: outbox?.id ?? null,
      outcome: passed ? "pass" as const : "fail" as const,
    });
  }
  return {
    status: checks.length === input.commands.length && checks.every((check) => check.outcome === "pass")
      ? "pass"
      : "fail",
    checks,
  };
}

