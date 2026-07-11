import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { canonicalSha256 } from "../shared/canonical-json";
import { toInputJson } from "../shared/prisma-json";

const INCIDENT_SIGNATURE_VERSION = "generation-error-v1";
const OPEN_INCIDENT_STATUSES = ["detected", "triaged", "mitigating", "monitoring"] as const;
const DEFAULT_JOIN_GAP_MS = 24 * 60 * 60 * 1_000;

type Db = PrismaClient | Prisma.TransactionClient;
type JsonRecord = Record<string, unknown>;

export interface FailedAttemptSource {
  readonly id: string;
  readonly requestId: string;
  readonly provider: string | null;
  readonly profileKey: string | null;
  readonly workflowKey: string | null;
  readonly errorClass: string | null;
  readonly errorSignature: string | null;
  readonly retryability: string | null;
  readonly status: string;
  readonly finishedAt: Date | null;
  readonly createdAt: Date;
}

function asRecord(value: Prisma.JsonValue | null): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function stableSignature(attempt: FailedAttemptSource) {
  if (
    !["failed", "unknown"].includes(attempt.status) ||
    !attempt.provider ||
    !attempt.profileKey ||
    !attempt.workflowKey ||
    !attempt.errorClass ||
    !attempt.errorSignature
  ) {
    return null;
  }
  const components = {
    provider: attempt.provider,
    profileKey: attempt.profileKey,
    workflowKey: attempt.workflowKey,
    errorClass: attempt.errorClass,
    normalizedError: attempt.errorSignature,
  };
  return {
    signature: canonicalSha256(components),
    components,
  };
}

async function refreshIncidentImpact(db: Db, incidentId: string) {
  const occurrences = await db.opsIncidentOccurrence.findMany({
    where: { incidentId },
    select: { requestId: true, attemptId: true },
  });
  const requestIds = [...new Set(occurrences.flatMap((row) => (row.requestId ? [row.requestId] : [])))];
  const attemptIds = [...new Set(occurrences.flatMap((row) => (row.attemptId ? [row.attemptId] : [])))];
  const [jobs, transports, ledger] = await Promise.all([
    requestIds.length
      ? db.generationJob.findMany({ where: { id: { in: requestIds } }, select: { userId: true } })
      : [],
    attemptIds.length
      ? db.generationTransportExecution.findMany({
          where: { attemptId: { in: attemptIds } },
          select: { costMicros: true },
        })
      : [],
    requestIds.length
      ? db.dreamcoinLedger.findMany({
          where: { sourceId: { in: requestIds }, reason: "refund", delta: { gt: 0 } },
          select: { delta: true },
        })
      : [],
  ]);
  const failedCostMicros = transports.reduce(
    (sum, row) => sum + Number(row.costMicros ?? BigInt(0)),
    0,
  );
  const impact = {
    affectedRequests: requestIds.length,
    affectedUsers: new Set(jobs.map((job) => job.userId)).size,
    failedCostMicros,
    refundMicros: 0,
    refundDreamcoins: ledger.reduce((sum, entry) => sum + entry.delta, 0),
  };
  await db.opsIncident.update({ where: { id: incidentId }, data: { impact } });
  return impact;
}

export async function correlateFailedGenerationAttempt(
  attemptId: string,
  options: { readonly joinGapMs?: number } = {},
) {
  return prisma.$transaction(async (tx) => {
    const existingOccurrence = await tx.opsIncidentOccurrence.findUnique({
      where: { occurrenceKey: `generation-attempt:${attemptId}` },
    });
    if (existingOccurrence) {
      return tx.opsIncident.findUniqueOrThrow({ where: { id: existingOccurrence.incidentId } });
    }
    const attempt = await tx.generationAttempt.findUnique({ where: { id: attemptId } });
    if (!attempt) throw Errors.notFound("Generation attempt not found", { attemptId });
    const derived = stableSignature(attempt);
    if (!derived) {
      throw Errors.badRequest("Generation attempt lacks sufficient stable signature evidence", {
        attemptId,
      });
    }
    const observedAt = attempt.finishedAt ?? attempt.createdAt;
    const joinGapMs = options.joinGapMs ?? DEFAULT_JOIN_GAP_MS;
    const cutoff = new Date(observedAt.getTime() - joinGapMs);
    let incident = await tx.opsIncident.findFirst({
      where: {
        signature: derived.signature,
        signatureVersion: INCIDENT_SIGNATURE_VERSION,
        status: { in: [...OPEN_INCIDENT_STATUSES] },
        lastSeen: { gte: cutoff },
      },
      orderBy: [{ lastSeen: "desc" }, { id: "asc" }],
    });
    if (!incident) {
      const correlationBucket = Math.floor(observedAt.getTime() / joinGapMs);
      const activeCorrelationKey = `${INCIDENT_SIGNATURE_VERSION}:${derived.signature}:${correlationBucket}`;
      incident = await tx.opsIncident.upsert({
        where: { activeCorrelationKey },
        create: {
          signature: derived.signature,
          signatureVersion: INCIDENT_SIGNATURE_VERSION,
          activeCorrelationKey,
          status: "detected",
          severity: "medium",
          firstSeen: observedAt,
          lastSeen: observedAt,
          impact: {
            affectedRequests: 0,
            affectedUsers: 0,
            failedCostMicros: 0,
            refundMicros: 0,
          },
          mitigation: {
            signatureComponents: derived.components,
            recommendedActions: ["retry_eligible", "pause_route"],
          },
        },
        update: {},
      });
    } else {
      incident = await tx.opsIncident.update({
        where: { id: incident.id },
        data: {
          firstSeen: observedAt < incident.firstSeen ? observedAt : incident.firstSeen,
          lastSeen: observedAt > incident.lastSeen ? observedAt : incident.lastSeen,
          version: { increment: 1 },
        },
      });
    }
    await tx.opsIncidentOccurrence.create({
      data: {
        incidentId: incident.id,
        requestId: attempt.requestId,
        attemptId: attempt.id,
        occurrenceKey: `generation-attempt:${attempt.id}`,
        observedAt,
      },
    });
    await tx.adminAuditLog.create({
      data: {
        actorId: "system",
        actorRole: "system",
        action: "incident.occurrence.correlated",
        targetType: "ops_incident",
        targetId: incident.id,
        reason: "Stable generation error signature correlation",
        after: toInputJson({
          occurrenceKey: `generation-attempt:${attempt.id}`,
          requestId: attempt.requestId,
          attemptId: attempt.id,
          signatureVersion: INCIDENT_SIGNATURE_VERSION,
        }),
        requestId: `incident-correlation:${attempt.id}`,
      },
    });
    const impact = await refreshIncidentImpact(tx, incident.id);
    return tx.opsIncident.findUniqueOrThrow({ where: { id: incident.id } }).then((row) => ({
      ...row,
      impact,
    }));
  });
}

export async function backfillGenerationIncidents(input: {
  readonly dryRun: boolean;
  readonly cursor?: string;
  readonly batchSize?: number;
}) {
  const rows = await prisma.generationAttempt.findMany({
    where: {
      status: { in: ["failed", "unknown"] },
      ...(input.cursor ? { id: { gt: input.cursor } } : {}),
    },
    orderBy: { id: "asc" },
    take: Math.min(500, Math.max(1, input.batchSize ?? 100)),
  });
  const before = await prisma.opsIncidentOccurrence.count();
  const report = {
    dryRun: input.dryRun,
    scanned: rows.length,
    eligible: 0,
    applied: 0,
    unavailable: [] as Array<{ attemptId: string; reason: string }>,
    mismatches: [] as Array<{ attemptId: string; reason: string }>,
    nextCursor: rows.at(-1)?.id ?? null,
    beforeOccurrences: before,
    afterOccurrences: before,
  };
  for (const row of rows) {
    if (!stableSignature(row)) {
      report.unavailable.push({ attemptId: row.id, reason: "insufficient_stable_signature" });
      continue;
    }
    report.eligible += 1;
    if (input.dryRun) continue;
    try {
      await correlateFailedGenerationAttempt(row.id);
      report.applied += 1;
    } catch (error) {
      report.mismatches.push({
        attemptId: row.id,
        reason: error instanceof Error ? error.message : "unknown_error",
      });
    }
  }
  report.afterOccurrences = await prisma.opsIncidentOccurrence.count();
  return report;
}

function eligibleOccurrenceIds(
  action: string,
  occurrences: ReadonlyArray<{
    id: string;
    attempt: FailedAttemptSource | null;
    hasCapturedSpend: boolean;
    hasRefund: boolean;
  }>,
) {
  if (action === "refund") {
    return occurrences
      .filter((row) => row.hasCapturedSpend && !row.hasRefund)
      .map((row) => row.id)
      .sort();
  }
  if (action !== "retry_eligible") return occurrences.map((row) => row.id).sort();
  return occurrences
    .filter(
      (row) =>
        row.attempt &&
        ["failed", "unknown"].includes(row.attempt.status) &&
        ["retryable", "auto_retry", "operator_retry"].includes(row.attempt.retryability ?? ""),
    )
    .map((row) => row.id)
    .sort();
}

async function occurrenceSnapshot(incidentId: string) {
  const occurrences = await prisma.opsIncidentOccurrence.findMany({
    where: { incidentId },
    orderBy: [{ observedAt: "asc" }, { id: "asc" }],
  });
  const attemptIds = occurrences.flatMap((row) => (row.attemptId ? [row.attemptId] : []));
  const requestIds = occurrences.flatMap((row) => (row.requestId ? [row.requestId] : []));
  const [attempts, ledger] = await Promise.all([
    attemptIds.length
      ? prisma.generationAttempt.findMany({ where: { id: { in: attemptIds } } })
      : [],
    requestIds.length
      ? prisma.dreamcoinLedger.findMany({
          where: { sourceId: { in: requestIds }, reason: { in: ["generation_spend", "refund"] } },
          select: { sourceId: true, reason: true, delta: true },
        })
      : [],
  ]);
  const attemptsById = new Map(attempts.map((attempt) => [attempt.id, attempt]));
  return occurrences.map((row) => ({
    id: row.id,
    attempt: row.attemptId ? attemptsById.get(row.attemptId) ?? null : null,
    hasCapturedSpend: ledger.some(
      (entry) => entry.sourceId === row.requestId && entry.reason === "generation_spend" && entry.delta < 0,
    ),
    hasRefund: ledger.some(
      (entry) => entry.sourceId === row.requestId && entry.reason === "refund" && entry.delta > 0,
    ),
  }));
}

export async function previewIncidentActionPlan(input: {
  readonly incidentId: string;
  readonly action: "retry_eligible" | "refund" | "pause_route" | "rollback";
  readonly actorId: string;
  readonly targetVersion?: string;
  readonly ttlMs?: number;
}) {
  const incident = await prisma.opsIncident.findUnique({ where: { id: input.incidentId } });
  if (!incident) throw Errors.notFound("Incident not found", { incidentId: input.incidentId });
  if (![...OPEN_INCIDENT_STATUSES].includes(incident.status as (typeof OPEN_INCIDENT_STATUSES)[number])) {
    throw Errors.conflict("Terminal incidents cannot create action plans");
  }
  if (input.action === "rollback" && !input.targetVersion) {
    throw Errors.badRequest("Rollback preview requires an immutable targetVersion");
  }
  const snapshot = await occurrenceSnapshot(input.incidentId);
  const eligibleIds = eligibleOccurrenceIds(input.action, snapshot);
  const allIds = snapshot.map((row) => row.id).sort();
  const skippedIds = allIds.filter((id) => !eligibleIds.includes(id));
  if (eligibleIds.length === 0) {
    throw Errors.badRequest("Incident action has no eligible occurrences", { action: input.action });
  }
  const occurrenceSetHash = canonicalSha256({ action: input.action, eligibleIds, skippedIds });
  return prisma.$transaction(async (tx) => {
    const plan = await tx.incidentActionPlan.create({
      data: {
        incidentId: incident.id,
        incidentVersion: incident.version,
        action: input.action,
        eligibleIdsHash: occurrenceSetHash,
        eligibleIds,
        skippedIds,
        impactSnapshot: toInputJson(incident.impact),
        targetVersion: input.targetVersion,
        expiresAt: new Date(Date.now() + Math.max(1_000, input.ttlMs ?? 15 * 60 * 1_000)),
        createdById: input.actorId,
      },
    });
    await tx.adminAuditLog.create({
      data: {
        actorId: input.actorId,
        actorRole: "operator",
        action: "incident.action_plan.previewed",
        targetType: "ops_incident",
        targetId: incident.id,
        reason: `Frozen ${input.action} eligibility preview`,
        after: toInputJson({
          actionPlanId: plan.id,
          incidentVersion: incident.version,
          eligibleCount: eligibleIds.length,
          skippedCount: skippedIds.length,
          occurrenceSetHash,
          expiresAt: plan.expiresAt,
        }),
        requestId: `incident-action-preview:${plan.id}`,
      },
    });
    return plan;
  });
}

export async function executeIncidentActionPlan(input: {
  readonly incidentId: string;
  readonly actionPlanId: string;
  readonly expectedVersion: number;
  readonly actor: { readonly id: string; readonly role: string };
  readonly confirmation: string;
  readonly idempotencyKey: string;
  readonly requestId?: string;
}) {
  const plan = await prisma.incidentActionPlan.findUnique({ where: { id: input.actionPlanId } });
  if (!plan || plan.incidentId !== input.incidentId) throw Errors.notFound("Incident action plan not found");
  const expectedConfirmation = `${input.incidentId}:${plan.id}:${plan.action}`;
  if (input.confirmation !== expectedConfirmation) {
    throw Errors.badRequest("Confirmation did not match frozen incident action plan", {
      expected: expectedConfirmation,
    });
  }
  const incident = await prisma.opsIncident.findUniqueOrThrow({ where: { id: input.incidentId } });
  if (plan.expiresAt.getTime() <= Date.now()) throw Errors.conflict("Incident action plan expired");
  if (incident.version !== input.expectedVersion || plan.incidentVersion !== incident.version) {
    throw Errors.conflict("Incident changed after action-plan preview", {
      expectedVersion: input.expectedVersion,
      currentVersion: incident.version,
    });
  }
  const snapshot = await occurrenceSnapshot(input.incidentId);
  const eligibleIds = eligibleOccurrenceIds(plan.action, snapshot);
  const skippedIds = snapshot.map((row) => row.id).filter((id) => !eligibleIds.includes(id)).sort();
  const currentHash = canonicalSha256({ action: plan.action, eligibleIds, skippedIds });
  if (currentHash !== plan.eligibleIdsHash) throw Errors.conflict("Incident occurrence set changed; preview again");

  const scope = `incident-action:${input.actor.id}`;
  const requestId = input.requestId ?? randomUUID();
  const requestHash = canonicalSha256({
    incidentId: input.incidentId,
    actionPlanId: plan.id,
    expectedVersion: input.expectedVersion,
    confirmation: input.confirmation,
  });
  const prior = await prisma.controlPlaneCommand.findUnique({
    where: { scope_idempotencyKey: { scope, idempotencyKey: input.idempotencyKey } },
  });
  if (prior) {
    if (prior.requestHash !== requestHash) throw Errors.conflict("Idempotency key is bound to another action plan");
    return prior;
  }
  try {
    return await prisma.$transaction(async (tx) => {
      const command = await tx.controlPlaneCommand.create({
        data: {
          scope,
          idempotencyKey: input.idempotencyKey,
          commandType: "incident.action_plan.execute",
          targetType: "incident_action_plan",
          targetId: plan.id,
          actorId: input.actor.id,
          requestId,
          requestHash,
          requestPayload: toInputJson({
            incidentId: input.incidentId,
            actionPlanId: plan.id,
            expectedVersion: input.expectedVersion,
            confirmation: input.confirmation,
          }),
          expectedVersion: input.expectedVersion,
          retryMode: "idempotent",
          status: "succeeded",
          attemptCount: 1,
          result: toInputJson({ action: plan.action, eligibleIds, skippedIds }),
          finishedAt: new Date(),
        },
      });
      await tx.controlPlaneCommandAttempt.create({
        data: { commandId: command.id, attemptNo: 1, status: "succeeded", finishedAt: new Date() },
      });
      const fanoutTargets = ["retry_eligible", "refund"].includes(plan.action)
        ? eligibleIds.map((occurrenceId) => ({ occurrenceId, eligibleOccurrenceIds: [occurrenceId] }))
        : [{ occurrenceId: null, eligibleOccurrenceIds: eligibleIds }];
      for (const target of fanoutTargets) {
        await tx.mainOutboxEvent.create({
          data: {
            eventType: `incident.action.${plan.action}.requested.v2`,
            aggregateType: "ops_incident",
            aggregateId: incident.id,
            payload: toInputJson({
              incidentId: incident.id,
              actionPlanId: plan.id,
              occurrenceId: target.occurrenceId,
              eligibleOccurrenceIds: target.eligibleOccurrenceIds,
              targetVersion: plan.targetVersion,
              commandId: command.id,
            }),
          },
        });
      }
      const mitigation = {
        ...asRecord(incident.mitigation),
        activeActionPlan: {
          id: plan.id,
          action: plan.action,
          eligibleCount: eligibleIds.length,
          skippedCount: skippedIds.length,
          executedAt: new Date().toISOString(),
          commandId: command.id,
        },
      };
      await tx.opsIncident.update({
        where: { id: incident.id, version: incident.version },
        data: { status: "mitigating", mitigation, version: { increment: 1 } },
      });
      await tx.adminAuditLog.create({
        data: {
          actorId: input.actor.id,
          actorRole: input.actor.role,
          action: "incident.action_plan.executed",
          targetType: "ops_incident",
          targetId: incident.id,
          reason: `Executed frozen ${plan.action} plan`,
          before: toInputJson({ status: incident.status, version: incident.version }),
          after: toInputJson({ status: "mitigating", version: incident.version + 1, actionPlanId: plan.id }),
          requestId,
        },
      });
      return command;
      },
    );
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const raced = await prisma.controlPlaneCommand.findUnique({
        where: { scope_idempotencyKey: { scope, idempotencyKey: input.idempotencyKey } },
      });
      if (raced?.requestHash === requestHash) return raced;
    }
    throw error;
  }
}
