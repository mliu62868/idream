import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { toInputJson } from "../shared/prisma-json";

type Actor = { readonly id: string; readonly role: string };

function record(value: Prisma.JsonValue | null) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function triageIncident(input: {
  readonly incidentId: string;
  readonly actor: Actor;
  readonly expectedVersion: number;
  readonly ownerId: string | null;
  readonly severity?: "critical" | "high" | "medium" | "low";
  readonly slaDueAt?: Date;
  readonly suspectedCause?: string;
  readonly confidence?: number;
  readonly runbookUrl?: string;
  readonly rollbackTarget?: string;
  readonly reason: string;
  readonly requestId: string;
}) {
  return prisma.$transaction(async (tx) => {
    const current = await tx.opsIncident.findUnique({ where: { id: input.incidentId } });
    if (!current) throw Errors.notFound("Incident not found");
    if (current.version !== input.expectedVersion) throw Errors.conflict("Incident version changed");
    if (["resolved", "closed", "duplicate", "merged"].includes(current.status)) {
      throw Errors.conflict("Terminal Incident cannot be triaged");
    }
    if (input.ownerId) {
      const owner = await tx.user.findUnique({ where: { id: input.ownerId }, select: { role: true, status: true } });
      if (!owner || owner.status !== "active" || owner.role === "user") {
        throw Errors.badRequest("Incident owner must be an active operator");
      }
    }
    const mitigation = {
      ...record(current.mitigation),
      ...(input.runbookUrl ? { runbookUrl: input.runbookUrl } : {}),
      ...(input.rollbackTarget ? { rollbackTarget: input.rollbackTarget } : {}),
    };
    const updated = await tx.opsIncident.update({
      where: { id: current.id, version: current.version },
      data: {
        status: current.status === "detected" ? "triaged" : current.status,
        ownerId: input.ownerId,
        severity: input.severity,
        slaDueAt: input.slaDueAt,
        suspectedCause: input.suspectedCause,
        confidence: input.confidence,
        mitigation,
        version: { increment: 1 },
      },
    });
    await tx.adminAuditLog.create({
      data: {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: "incident.triaged",
        targetType: "ops_incident",
        targetId: current.id,
        reason: input.reason,
        before: toInputJson({ status: current.status, ownerId: current.ownerId, severity: current.severity, version: current.version }),
        after: toInputJson({ status: updated.status, ownerId: updated.ownerId, severity: updated.severity, version: updated.version }),
        requestId: input.requestId,
      },
    });
    await tx.mainOutboxEvent.create({
      data: {
        eventType: "ops.incident.triaged.v2",
        aggregateType: "ops_incident",
        aggregateId: current.id,
        payload: toInputJson({ incidentId: current.id, ownerId: updated.ownerId, severity: updated.severity, version: updated.version }),
      },
    });
    return updated;
  });
}

export async function verifyIncidentRecovery(input: {
  readonly incidentId: string;
  readonly actor: Actor;
  readonly expectedVersion: number;
  readonly state: "passed" | "failed" | "overridden";
  readonly evidenceRefs: readonly string[];
  readonly checks: {
    readonly successRateRecovered: boolean;
    readonly signatureGrowthStopped: boolean;
    readonly backlogRecovering: boolean;
    readonly failedRequestPlanComplete: boolean;
    readonly settlementReconciled: boolean;
  };
  readonly overrideReason?: string;
  readonly requestId: string;
}) {
  if (input.evidenceRefs.length === 0) throw Errors.badRequest("Recovery verification requires evidence");
  const allChecksPassed = Object.values(input.checks).every(Boolean);
  if (input.state === "passed" && !allChecksPassed) {
    throw Errors.conflict("Recovery verification cannot pass while required checks fail");
  }
  if (input.state === "overridden" && !input.overrideReason?.trim()) {
    throw Errors.badRequest("Recovery verification override requires a reason");
  }
  return prisma.$transaction(async (tx) => {
    const current = await tx.opsIncident.findUnique({ where: { id: input.incidentId } });
    if (!current) throw Errors.notFound("Incident not found");
    if (current.version !== input.expectedVersion) throw Errors.conflict("Incident version changed");
    if (!["mitigating", "monitoring"].includes(current.status)) {
      throw Errors.conflict("Incident must be mitigating or monitoring before recovery verification");
    }
    const mitigation = {
      ...record(current.mitigation),
      verification: {
        state: input.state,
        checkedAt: new Date().toISOString(),
        evidenceRefs: [...input.evidenceRefs],
        checks: input.checks,
        overrideReason: input.overrideReason ?? null,
      },
    };
    const updated = await tx.opsIncident.update({
      where: { id: current.id, version: current.version },
      data: {
        status: "monitoring",
        verificationState: input.state,
        mitigation,
        version: { increment: 1 },
      },
    });
    await tx.adminAuditLog.create({
      data: {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: input.state === "overridden" ? "incident.recovery.overridden" : "incident.recovery.verified",
        targetType: "ops_incident",
        targetId: current.id,
        reason: input.overrideReason ?? `Recovery verification ${input.state}`,
        before: toInputJson({ status: current.status, verificationState: current.verificationState, version: current.version }),
        after: toInputJson({ status: updated.status, verificationState: updated.verificationState, version: updated.version }),
        requestId: input.requestId,
      },
    });
    return updated;
  });
}
