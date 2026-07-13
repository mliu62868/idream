import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { canonicalSha256 } from "../shared/canonical-json";
import { toInputJson } from "../shared/prisma-json";
import { isIncidentTransitionAllowed } from "../shared/state-transition-authority";

const INCIDENT_SIGNATURE_VERSION = "generation-error-v1";
const INCIDENT_CORRELATION_POLICY_VERSION = "generation-correlation-v1";
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

export function transformGenerationIncidentBackfill(attempt: FailedAttemptSource) {
  const derived = stableSignature(attempt);
  if (!derived) {
    return {
      classification: "unavailable" as const,
      action: "preserve_without_incident" as const,
      before: {
        status: attempt.status,
        provider: attempt.provider,
        profileKey: attempt.profileKey,
        workflowKey: attempt.workflowKey,
        errorClass: attempt.errorClass,
        errorSignature: attempt.errorSignature,
      },
      after: { occurrenceKey: null, signature: null },
      mismatches: [{
        code: "insufficient_stable_signature",
        detail: "Generation Attempt cannot be correlated without provider/profile/workflow/error signature evidence.",
      }],
    };
  }
  return {
    classification: "eligible" as const,
    action: "correlate_generation_incident" as const,
    before: {
      status: attempt.status,
      provider: attempt.provider,
      profileKey: attempt.profileKey,
      workflowKey: attempt.workflowKey,
      errorClass: attempt.errorClass,
      errorSignature: attempt.errorSignature,
    },
    after: {
      occurrenceKey: `generation-attempt:${attempt.id}`,
      signature: derived.signature,
      signatureVersion: INCIDENT_SIGNATURE_VERSION,
    },
    mismatches: [] as Array<{ code: string; detail: string }>,
  };
}

export async function applyGenerationIncidentBackfill(db: PrismaClient, attemptId: string) {
  return correlateFailedGenerationAttempt(attemptId, { db });
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
  options: { readonly joinGapMs?: number; readonly policyVersion?: string; readonly db?: PrismaClient } = {},
) {
  const database = options.db ?? prisma;
  const result = await database.$transaction(async (tx) => {
    const existingOccurrence = await tx.opsIncidentOccurrence.findUnique({
      where: { occurrenceKey: `generation-attempt:${attemptId}` },
    });
    if (existingOccurrence) {
      return {
        incident: await tx.opsIncident.findUniqueOrThrow({ where: { id: existingOccurrence.incidentId } }),
        observedAt: existingOccurrence.observedAt,
        recorded: false as const,
      };
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
    const policyVersion = options.policyVersion ?? INCIDENT_CORRELATION_POLICY_VERSION;
    const cutoff = new Date(observedAt.getTime() - joinGapMs);
    await tx.$queryRaw(Prisma.sql`
      SELECT 1::int AS locked
      FROM pg_advisory_xact_lock(
        hashtextextended(${`${INCIDENT_SIGNATURE_VERSION}:${derived.signature}`}, 0)
      )
    `);
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
            correlationPolicy: { version: policyVersion, joinGapMs },
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
          correlationPolicyVersion: policyVersion,
          joinGapMs,
        }),
        requestId: `incident-correlation:${attempt.id}`,
      },
    });
    const impact = await refreshIncidentImpact(tx, incident.id);
    const updated = await tx.opsIncident.findUniqueOrThrow({ where: { id: incident.id } });
    return { incident: { ...updated, impact }, observedAt, recorded: true as const };
  });
  return result.incident;
}

export async function dispatchGenerationIncidentCorrelation(
  db: PrismaClient,
  input: { readonly limit?: number; readonly outboxIds?: readonly string[] } = {},
) {
  const rows = await db.mainOutboxEvent.findMany({
    where: {
      eventType: "generation.incident.correlate.v2",
      status: { in: ["pending", "dispatched"] },
      nextRunAt: { lte: new Date() },
      ...(input.outboxIds ? { id: { in: [...input.outboxIds] } } : {}),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: Math.min(100, Math.max(1, input.limit ?? 25)),
  });
  let correlated = 0;
  let unavailable = 0;
  let failed = 0;
  for (const row of rows) {
    const payload = asRecord(row.payload);
    const attemptId = typeof payload.attemptId === "string" ? payload.attemptId : null;
    try {
      if (!attemptId) throw new Error("Incident correlation outbox payload is invalid");
      const attempt = await db.generationAttempt.findUnique({ where: { id: attemptId } });
      if (!attempt) throw new Error("Generation Attempt for Incident correlation is missing");
      if (!stableSignature(attempt)) {
        await db.$transaction(async (tx) => {
          await tx.mainOutboxEvent.update({
            where: { id: row.id },
            data: {
              status: "delivered",
              attempts: { increment: 1 },
              deliveredAt: new Date(),
              lastError: toInputJson({ code: "insufficient_stable_signature", attemptId }),
            },
          });
          await tx.adminAuditLog.create({
            data: {
              actorId: "system",
              actorRole: "system",
              action: "incident.correlation.unavailable",
              targetType: "generation_attempt",
              targetId: attemptId,
              reason: "Failed Attempt lacks stable provider/profile/workflow/error signature evidence",
              after: toInputJson({ attemptId, outcome: attempt.status }),
              requestId: `incident-correlation-unavailable:${attemptId}`,
            },
          });
        });
        unavailable += 1;
        continue;
      }
      await correlateFailedGenerationAttempt(attemptId, { db });
      await db.mainOutboxEvent.update({
        where: { id: row.id },
        data: {
          status: "delivered",
          attempts: { increment: 1 },
          deliveredAt: new Date(),
          lastError: Prisma.DbNull,
        },
      });
      correlated += 1;
    } catch (error) {
      await db.mainOutboxEvent.update({
        where: { id: row.id },
        data: {
          status: "pending",
          attempts: { increment: 1 },
          nextRunAt: new Date(Date.now() + 30_000),
          lastError: toInputJson({
            message: error instanceof Error ? error.message : "Incident correlation failed",
          }),
        },
      });
      failed += 1;
    }
  }
  return { examined: rows.length, correlated, unavailable, failed };
}

function eligibleOccurrenceIds(
  action: string,
  occurrences: ReadonlyArray<{
    id: string;
    attempt: FailedAttemptSource | null;
    capturedSpend: number;
    refunded: number;
  }>,
) {
  if (action === "refund") {
    return occurrences
      .filter((row) => row.capturedSpend > row.refunded)
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

async function occurrenceSnapshot(db: Db, incidentId: string) {
  const occurrences = await db.opsIncidentOccurrence.findMany({
    where: { incidentId },
    orderBy: [{ observedAt: "asc" }, { id: "asc" }],
  });
  const attemptIds = occurrences.flatMap((row) => (row.attemptId ? [row.attemptId] : []));
  const requestIds = occurrences.flatMap((row) => (row.requestId ? [row.requestId] : []));
  const [attempts, ledger] = await Promise.all([
    attemptIds.length
      ? db.generationAttempt.findMany({ where: { id: { in: attemptIds } } })
      : [],
    requestIds.length
      ? db.dreamcoinLedger.findMany({
          where: { sourceId: { in: requestIds }, reason: { in: ["generation_spend", "refund"] } },
          select: { sourceId: true, reason: true, delta: true },
        })
      : [],
  ]);
  const attemptsById = new Map(attempts.map((attempt) => [attempt.id, attempt]));
  return occurrences.map((row) => ({
    id: row.id,
    attempt: row.attemptId ? attemptsById.get(row.attemptId) ?? null : null,
    capturedSpend: -ledger.filter((entry) => entry.sourceId === row.requestId && entry.reason === "generation_spend" && entry.delta < 0).reduce((sum, entry) => sum + entry.delta, 0),
    refunded: ledger.filter((entry) => entry.sourceId === row.requestId && entry.reason === "refund" && entry.delta > 0).reduce((sum, entry) => sum + entry.delta, 0),
  }));
}

export async function previewIncidentActionPlan(input: {
  readonly incidentId: string;
  readonly action: "retry_eligible" | "refund" | "pause_route" | "rollback";
  readonly actorId: string;
  readonly requestId?: string;
  readonly targetVersion?: string;
  readonly ttlMs?: number;
}, db?: Prisma.TransactionClient) {
  const execute = async (tx: Prisma.TransactionClient) => {
    const incident = await tx.opsIncident.findUnique({ where: { id: input.incidentId } });
    if (!incident) throw Errors.notFound("Incident not found", { incidentId: input.incidentId });
    if (![...OPEN_INCIDENT_STATUSES].includes(incident.status as (typeof OPEN_INCIDENT_STATUSES)[number])) {
      throw Errors.conflict("Terminal incidents cannot create action plans");
    }
    if (input.action === "rollback" && !input.targetVersion) {
      throw Errors.badRequest("Rollback preview requires an immutable targetVersion");
    }
    const snapshot = await occurrenceSnapshot(tx, input.incidentId);
    const eligibleIds = eligibleOccurrenceIds(input.action, snapshot);
    const allIds = snapshot.map((row) => row.id).sort();
    const skippedIds = allIds.filter((id) => !eligibleIds.includes(id));
    if (eligibleIds.length === 0) {
      throw Errors.badRequest("Incident action has no eligible occurrences", { action: input.action });
    }
    const occurrenceSetHash = canonicalSha256({ action: input.action, eligibleIds, skippedIds });
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
        requestId: input.requestId ?? `incident-action-preview:${plan.id}`,
      },
    });
    await tx.mainOutboxEvent.create({
      data: {
        eventType: "ops.incident.action_plan.previewed.v2",
        aggregateType: "ops_incident",
        aggregateId: incident.id,
        payload: toInputJson({
          incidentId: incident.id,
          actionPlanId: plan.id,
          action: plan.action,
          incidentVersion: plan.incidentVersion,
          occurrenceSetHash,
        }),
      },
    });
    return plan;
  };
  return db ? execute(db) : prisma.$transaction(execute);
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
  if (!isIncidentTransitionAllowed(incident.status, "mitigating")) {
    throw Errors.conflict("Incident cannot enter mitigation from its present state", { status: incident.status });
  }
  const snapshot = await occurrenceSnapshot(prisma, input.incidentId);
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
          status: "accepted",
          attemptCount: 0,
          result: toInputJson({ action: plan.action, eligibleIds, skippedIds, executionState: "accepted" }),
        },
      });
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
          action: "incident.action_plan.accepted",
          targetType: "ops_incident",
          targetId: incident.id,
          reason: `Accepted frozen ${plan.action} plan for durable execution`,
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

export async function splitIncidentOccurrences(input: {
  readonly incidentId: string;
  readonly expectedVersion: number;
  readonly occurrenceIds: readonly string[];
  readonly actor: { readonly id: string; readonly role: string };
  readonly reason: string;
  readonly requestId: string;
}, db?: Prisma.TransactionClient) {
  const selectedIds = [...new Set(input.occurrenceIds)].sort();
  if (selectedIds.length === 0) throw Errors.badRequest("Select at least one Incident occurrence to split");
  const execute = async (tx: Prisma.TransactionClient) => {
    const source = await tx.opsIncident.findUnique({ where: { id: input.incidentId } });
    if (!source) throw Errors.notFound("Incident not found");
    if (source.version !== input.expectedVersion) throw Errors.conflict("Incident changed before split");
    if (![...OPEN_INCIDENT_STATUSES].includes(source.status as (typeof OPEN_INCIDENT_STATUSES)[number])) throw Errors.conflict("Only active Incidents can be split");
    const allOccurrences = await tx.opsIncidentOccurrence.findMany({ where: { incidentId: source.id }, orderBy: [{ observedAt: "asc" }, { id: "asc" }] });
    const selected = allOccurrences.filter((row) => selectedIds.includes(row.id));
    if (selected.length !== selectedIds.length) throw Errors.conflict("One or more selected occurrences no longer belong to the Incident");
    if (selected.length === allOccurrences.length) throw Errors.badRequest("Split must leave at least one occurrence on the source Incident");
    const splitSignature = canonicalSha256({ sourceSignature: source.signature, occurrenceIds: selectedIds, correctionVersion: "manual-split-v1" });
    const createdId = randomUUID();
    const created = await tx.opsIncident.create({ data: {
      id: createdId,
      signature: splitSignature,
      signatureVersion: `${source.signatureVersion}+manual-split-v1`,
      activeCorrelationKey: `manual-split:${createdId}`,
      status: "triaged",
      severity: source.severity,
      ownerId: source.ownerId,
      firstSeen: selected[0].observedAt,
      lastSeen: selected.at(-1)!.observedAt,
      slaDueAt: source.slaDueAt,
      impact: {},
      mitigation: toInputJson({ ...asRecord(source.mitigation), splitFromIncidentId: source.id, splitReason: input.reason }),
      suspectedCause: source.suspectedCause,
      confidence: source.confidence,
    } });
    const moved = await tx.opsIncidentOccurrence.updateMany({ where: { id: { in: selectedIds }, incidentId: source.id }, data: { incidentId: created.id } });
    if (moved.count !== selectedIds.length) throw Errors.conflict("Incident occurrence set changed during split");
    await tx.opsIncidentOccurrenceAssignment.createMany({ data: selected.map((row) => ({ occurrenceId: row.id, fromIncidentId: source.id, toIncidentId: created.id, action: "split", actorId: input.actor.id, reason: input.reason })) });
    const remaining = allOccurrences.filter((row) => !selectedIds.includes(row.id));
    await tx.opsIncident.update({ where: { id: source.id }, data: { firstSeen: remaining[0].observedAt, lastSeen: remaining.at(-1)!.observedAt, version: { increment: 1 } } });
    await refreshIncidentImpact(tx, source.id);
    await refreshIncidentImpact(tx, created.id);
    await tx.adminAuditLog.create({ data: { actorId: input.actor.id, actorRole: input.actor.role, action: "incident.split", targetType: "ops_incident", targetId: source.id, reason: input.reason, before: toInputJson({ version: source.version, occurrenceCount: allOccurrences.length }), after: toInputJson({ version: source.version + 1, createdIncidentId: created.id, movedOccurrenceIds: selectedIds }), requestId: input.requestId } });
    await tx.mainOutboxEvent.create({ data: { eventType: "ops.incident.split.v2", aggregateType: "ops_incident", aggregateId: source.id, payload: toInputJson({ sourceIncidentId: source.id, createdIncidentId: created.id, movedOccurrenceIds: selectedIds }) } });
    return { sourceIncidentId: source.id, createdIncidentId: created.id, movedOccurrenceIds: selectedIds };
  };
  return db ? execute(db) : prisma.$transaction(execute);
}

export async function mergeIncidents(input: {
  readonly targetIncidentId: string;
  readonly expectedVersion: number;
  readonly sources: readonly { readonly incidentId: string; readonly version: number }[];
  readonly actor: { readonly id: string; readonly role: string };
  readonly reason: string;
  readonly requestId: string;
}, db?: Prisma.TransactionClient) {
  const sourceVersions = new Map(input.sources.map((source) => [source.incidentId, source.version]));
  const sourceIds = [...sourceVersions.keys()].filter((id) => id !== input.targetIncidentId).sort();
  if (sourceIds.length === 0) throw Errors.badRequest("Select at least one different Incident to merge");
  const execute = async (tx: Prisma.TransactionClient) => {
    const rows = await tx.opsIncident.findMany({ where: { id: { in: [input.targetIncidentId, ...sourceIds] } } });
    const target = rows.find((row) => row.id === input.targetIncidentId);
    if (!target) throw Errors.notFound("Merge target Incident not found");
    if (target.version !== input.expectedVersion) throw Errors.conflict("Merge target changed before execution");
    if (![...OPEN_INCIDENT_STATUSES].includes(target.status as (typeof OPEN_INCIDENT_STATUSES)[number])) throw Errors.conflict("Merge target must be an active Incident");
    const sources = sourceIds.map((id) => rows.find((row) => row.id === id));
    if (sources.some((row) => !row)) throw Errors.notFound("One or more merge source Incidents were not found");
    for (const source of sources) {
      if (source!.version !== sourceVersions.get(source!.id)) throw Errors.conflict("A merge source changed before execution", { incidentId: source!.id });
      if (!isIncidentTransitionAllowed(source!.status, "merged")) throw Errors.conflict("Incident cannot be merged from its present state", { incidentId: source!.id, status: source!.status });
    }
    const occurrences = await tx.opsIncidentOccurrence.findMany({ where: { incidentId: { in: sourceIds } } });
    for (const source of sources) {
      const sourceOccurrences = occurrences.filter((row) => row.incidentId === source!.id);
      await tx.opsIncidentOccurrence.updateMany({ where: { incidentId: source!.id }, data: { incidentId: target.id } });
      if (sourceOccurrences.length > 0) await tx.opsIncidentOccurrenceAssignment.createMany({ data: sourceOccurrences.map((row) => ({ occurrenceId: row.id, fromIncidentId: source!.id, toIncidentId: target.id, action: "merge", actorId: input.actor.id, reason: input.reason })) });
      await tx.opsIncident.update({ where: { id: source!.id }, data: { status: "merged", activeCorrelationKey: null, mitigation: toInputJson({ ...asRecord(source!.mitigation), mergedIntoIncidentId: target.id, mergeReason: input.reason }), version: { increment: 1 } } });
    }
    const firstSeen = sources.reduce((value, row) => row!.firstSeen < value ? row!.firstSeen : value, target.firstSeen);
    const lastSeen = sources.reduce((value, row) => row!.lastSeen > value ? row!.lastSeen : value, target.lastSeen);
    await tx.opsIncident.update({ where: { id: target.id }, data: { firstSeen, lastSeen, version: { increment: 1 } } });
    await refreshIncidentImpact(tx, target.id);
    await tx.adminAuditLog.create({ data: { actorId: input.actor.id, actorRole: input.actor.role, action: "incident.merged", targetType: "ops_incident", targetId: target.id, reason: input.reason, before: toInputJson({ version: target.version }), after: toInputJson({ version: target.version + 1, sourceIncidentIds: sourceIds, movedOccurrenceCount: occurrences.length }), requestId: input.requestId } });
    await tx.mainOutboxEvent.create({ data: { eventType: "ops.incident.merged.v2", aggregateType: "ops_incident", aggregateId: target.id, payload: toInputJson({ targetIncidentId: target.id, sourceIncidentIds: sourceIds, movedOccurrenceIds: occurrences.map((row) => row.id) }) } });
    return { targetIncidentId: target.id, mergedIncidentIds: sourceIds, movedOccurrenceCount: occurrences.length };
  };
  return db ? execute(db) : prisma.$transaction(execute);
}

export async function closeIncidentWithPostmortem(input: {
  readonly incidentId: string;
  readonly expectedVersion: number;
  readonly actor: { readonly id: string; readonly role: string };
  readonly summary: string;
  readonly rootCause: string;
  readonly contributingFactors: readonly string[];
  readonly correctiveActions: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly reason: string;
  readonly requestId: string;
}, db?: Prisma.TransactionClient) {
  const execute = async (tx: Prisma.TransactionClient) => {
    const incident = await tx.opsIncident.findUnique({ where: { id: input.incidentId } });
    if (!incident) throw Errors.notFound("Incident not found");
    if (incident.version !== input.expectedVersion) throw Errors.conflict("Incident changed before close");
    if (!isIncidentTransitionAllowed(incident.status, "closed")) throw Errors.conflict("Incident must be resolved before postmortem close");
    if (!["passed", "overridden"].includes(incident.verificationState)) throw Errors.conflict("Recovery verification is required before close");
    const postmortem = await tx.incidentPostmortem.create({ data: { incidentId: incident.id, summary: input.summary, rootCause: input.rootCause, contributingFactors: [...input.contributingFactors], correctiveActions: [...input.correctiveActions], evidenceRefs: [...input.evidenceRefs], createdById: input.actor.id } });
    const closed = await tx.opsIncident.update({ where: { id: incident.id }, data: { status: "closed", activeCorrelationKey: null, version: { increment: 1 }, mitigation: toInputJson({ ...asRecord(incident.mitigation), postmortemId: postmortem.id }) } });
    await tx.adminAuditLog.create({ data: { actorId: input.actor.id, actorRole: input.actor.role, action: "incident.closed_with_postmortem", targetType: "ops_incident", targetId: incident.id, reason: input.reason, before: toInputJson({ status: incident.status, version: incident.version }), after: toInputJson({ status: closed.status, version: closed.version, postmortemId: postmortem.id, evidenceRefs: input.evidenceRefs }), requestId: input.requestId } });
    await tx.mainOutboxEvent.create({ data: { eventType: "ops.incident.closed.v2", aggregateType: "ops_incident", aggregateId: incident.id, payload: toInputJson({ incidentId: incident.id, postmortemId: postmortem.id, version: closed.version }) } });
    return {
      incidentId: closed.id,
      postmortemId: postmortem.id,
      status: "closed" as const,
      verificationState: closed.verificationState,
      version: closed.version,
    };
  };
  return db ? execute(db) : prisma.$transaction(execute);
}
