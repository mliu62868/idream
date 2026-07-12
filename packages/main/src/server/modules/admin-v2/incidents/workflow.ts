import { incidentRecoveryChecksSchema, type IncidentRecoveryVerificationRequest } from "@idream/shared/admin";
import { Prisma, type OpsIncident } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { canonicalSha256 } from "../shared/canonical-json";
import { toInputJson } from "../shared/prisma-json";

type Actor = { readonly id: string; readonly role: string };
type Db = Prisma.TransactionClient;

const RECOVERY_WINDOW_MS = 15 * 60 * 1_000;
const REQUIRED_SUCCESS_RATE = 0.95;
const ACTIVE_REQUEST_STATES = new Set(["queued", "moderating_input", "running", "moderating_output", "processing"]);
const ACTIVE_ATTEMPT_STATES = new Set(["queued", "running", "processing"]);
const TERMINAL_ATTEMPT_STATES = new Set(["succeeded", "failed", "cancelled", "unknown"]);

function record(value: Prisma.JsonValue | null) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function strings(value: Prisma.JsonValue): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function latestDate(values: ReadonlyArray<Date | null | undefined>, fallback: Date) {
  return values.reduce<Date>((latest, value) => value && value > latest ? value : latest, fallback);
}

async function deriveIncidentRecoveryChecks(
  tx: Db,
  incident: OpsIncident,
  now: Date,
) {
  const occurrences = await tx.opsIncidentOccurrence.findMany({
    where: { incidentId: incident.id },
    orderBy: [{ observedAt: "asc" }, { id: "asc" }],
  });
  const requestIds = [...new Set(occurrences.flatMap((row) => row.requestId ? [row.requestId] : []))];
  const mitigation = record(incident.mitigation);
  const signature = record((mitigation.signatureComponents ?? null) as Prisma.JsonValue | null);
  const provider = stringValue(signature.provider);
  const profileKey = stringValue(signature.profileKey);
  const workflowKey = stringValue(signature.workflowKey);
  const errorClass = stringValue(signature.errorClass);
  const normalizedError = stringValue(signature.normalizedError);

  const [jobs, requestAttempts, plans, ledger] = await Promise.all([
    requestIds.length > 0
      ? tx.generationJob.findMany({ where: { id: { in: requestIds } } })
      : [],
    requestIds.length > 0
      ? tx.generationAttempt.findMany({
          where: { requestId: { in: requestIds } },
          orderBy: [{ requestId: "asc" }, { attemptNo: "desc" }],
        })
      : [],
    tx.incidentActionPlan.findMany({ where: { incidentId: incident.id } }),
    requestIds.length > 0
      ? tx.dreamcoinLedger.findMany({
          where: { sourceId: { in: requestIds }, reason: { in: ["generation_spend", "refund"] } },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        })
      : [],
  ]);
  const commands = plans.length > 0
    ? await tx.controlPlaneCommand.findMany({
        where: {
          commandType: "incident.action_plan.execute",
          targetId: { in: plans.map((plan) => plan.id) },
        },
      })
    : [];
  const succeededCommandIds = new Set(commands.filter((command) => command.status === "succeeded").map((command) => command.id));
  const successfulPlans = plans.filter((plan) =>
    commands.some((command) => command.targetId === plan.id && succeededCommandIds.has(command.id))
  );
  const latestMitigationAt = latestDate(
    commands.filter((command) => command.status === "succeeded").map((command) => command.finishedAt ?? command.updatedAt),
    incident.lastSeen,
  );
  const recoveryWindowStart = latestMitigationAt > incident.lastSeen ? latestMitigationAt : incident.lastSeen;
  const windowMature = now.getTime() - recoveryWindowStart.getTime() >= RECOVERY_WINDOW_MS;

  const routeEvidenceAvailable = Boolean(provider && profileKey && workflowKey);
  const routeAttempts = routeEvidenceAvailable
    ? await tx.generationAttempt.findMany({
        where: {
          provider,
          profileKey,
          workflowKey,
          OR: [
            { finishedAt: { gt: incident.lastSeen, lte: now } },
            { finishedAt: null, createdAt: { gt: incident.lastSeen, lte: now } },
          ],
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      })
    : [];
  const terminalRouteAttempts = routeAttempts.filter((attempt) => TERMINAL_ATTEMPT_STATES.has(attempt.status));
  const successfulRouteAttempts = terminalRouteAttempts.filter((attempt) => attempt.status === "succeeded");
  const successRate = terminalRouteAttempts.length > 0
    ? successfulRouteAttempts.length / terminalRouteAttempts.length
    : null;
  const successRateRecovered = routeEvidenceAvailable && windowMature && routeAttempts.length > 0
    && terminalRouteAttempts.length === routeAttempts.length
    && successRate !== null && successRate >= REQUIRED_SUCCESS_RATE;
  const recurringSignatureAttempts = routeAttempts.filter((attempt) =>
    ["failed", "unknown"].includes(attempt.status)
      && attempt.errorClass === errorClass
      && attempt.errorSignature === normalizedError
  );
  const signatureGrowthStopped = routeEvidenceAvailable && Boolean(errorClass && normalizedError)
    && windowMature && recurringSignatureAttempts.length === 0;

  const latestAttemptByRequest = new Map<string, (typeof requestAttempts)[number]>();
  for (const attempt of requestAttempts) {
    if (!latestAttemptByRequest.has(attempt.requestId)) latestAttemptByRequest.set(attempt.requestId, attempt);
  }
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  const activeJobIds = jobs.filter((job) => ACTIVE_REQUEST_STATES.has(job.status)).map((job) => job.id);
  const activeAttemptIds = [...latestAttemptByRequest.values()]
    .filter((attempt) => ACTIVE_ATTEMPT_STATES.has(attempt.status))
    .map((attempt) => attempt.id);
  const backlogRecovering = requestIds.length > 0 && jobs.length === requestIds.length
    && activeJobIds.length === 0 && activeAttemptIds.length === 0;

  const ledgerByRequest = new Map(requestIds.map((requestId) => {
    const entries = ledger.filter((entry) => entry.sourceId === requestId);
    const captured = -entries
      .filter((entry) => entry.reason === "generation_spend" && entry.delta < 0)
      .reduce((sum, entry) => sum + entry.delta, 0);
    const refunded = entries
      .filter((entry) => entry.reason === "refund" && entry.delta > 0)
      .reduce((sum, entry) => sum + entry.delta, 0);
    return [requestId, { captured, refunded, entryIds: entries.map((entry) => entry.id) }] as const;
  }));
  const requestRecovered = (requestId: string) => {
    const job = jobsById.get(requestId);
    const latestAttempt = latestAttemptByRequest.get(requestId);
    return Boolean(
      latestAttempt?.status === "succeeded"
      && job
      && job.status === "completed"
      && job.outputCount > 0
      && job.deliveredOutputCount >= job.outputCount,
    );
  };
  const requestFullyRefunded = (requestId: string) => {
    const settlement = ledgerByRequest.get(requestId);
    return Boolean(settlement && settlement.captured > 0 && settlement.refunded === settlement.captured);
  };
  const completedOccurrenceIds = new Set(successfulPlans
    .filter((plan) => ["retry_eligible", "refund"].includes(plan.action))
    .flatMap((plan) => strings(plan.eligibleIds)));
  const incompleteOccurrenceIds = occurrences.filter((occurrence) => {
    if (!occurrence.requestId) return true;
    return !completedOccurrenceIds.has(occurrence.id)
      && !requestRecovered(occurrence.requestId)
      && !requestFullyRefunded(occurrence.requestId);
  }).map((occurrence) => occurrence.id);
  const failedRequestPlanComplete = occurrences.length > 0 && incompleteOccurrenceIds.length === 0;

  const unsettledRequestIds = requestIds.filter((requestId) => {
    const settlement = ledgerByRequest.get(requestId) ?? { captured: 0, refunded: 0 };
    if (settlement.refunded > settlement.captured) return true;
    return requestRecovered(requestId)
      ? false
      : settlement.refunded !== settlement.captured;
  });
  const settlementReconciled = requestIds.length > 0 && unsettledRequestIds.length === 0;

  const checks = incidentRecoveryChecksSchema.parse({
    successRateRecovered: {
      passed: successRateRecovered,
      summary: successRateRecovered
        ? "The matching route sustained the required successful terminal outcome rate."
        : "The matching route lacks a mature, sufficiently successful terminal outcome window.",
      observed: {
        routeEvidenceAvailable,
        windowMature,
        recoveryWindowStart: recoveryWindowStart.toISOString(),
        recoveryWindowMinutes: RECOVERY_WINDOW_MS / 60_000,
        sampleSize: routeAttempts.length,
        terminalSampleSize: terminalRouteAttempts.length,
        succeeded: successfulRouteAttempts.length,
        successRate,
        requiredSuccessRate: REQUIRED_SUCCESS_RATE,
      },
    },
    signatureGrowthStopped: {
      passed: signatureGrowthStopped,
      summary: signatureGrowthStopped
        ? "The original normalized error signature did not recur during the mature window."
        : "The original signature recurred or the quiet window is not yet authoritative.",
      observed: {
        routeEvidenceAvailable,
        signatureEvidenceAvailable: Boolean(errorClass && normalizedError),
        windowMature,
        recurringFailureCount: recurringSignatureAttempts.length,
        recurringAttemptIds: recurringSignatureAttempts.map((attempt) => attempt.id),
      },
    },
    backlogRecovering: {
      passed: backlogRecovering,
      summary: backlogRecovering
        ? "No affected Generation Request or latest Attempt remains active."
        : "Affected work is missing or remains queued/running.",
      observed: { affectedRequestCount: requestIds.length, loadedRequestCount: jobs.length, activeJobIds, activeAttemptIds },
    },
    failedRequestPlanComplete: {
      passed: failedRequestPlanComplete,
      summary: failedRequestPlanComplete
        ? "Every occurrence has a completed retry/refund plan or a verified terminal result."
        : "At least one failed occurrence lacks a completed terminal plan.",
      observed: {
        occurrenceCount: occurrences.length,
        completedPlanIds: successfulPlans.map((plan) => plan.id),
        incompleteOccurrenceIds,
      },
    },
    settlementReconciled: {
      passed: settlementReconciled,
      summary: settlementReconciled
        ? "Captured spend and refunds reconcile for every affected request."
        : "At least one affected request has unreconciled or excessive refund value.",
      observed: {
        affectedRequestCount: requestIds.length,
        unsettledRequestIds,
        settlements: Object.fromEntries([...ledgerByRequest.entries()].map(([requestId, value]) => [requestId, {
          captured: value.captured,
          refunded: value.refunded,
          recovered: requestRecovered(requestId),
        }])),
      },
    },
  });
  const authoritySnapshot = {
    incidentId: incident.id,
    incidentVersion: incident.version,
    checkedAt: now.toISOString(),
    occurrenceIds: occurrences.map((row) => row.id),
    routeAttemptIds: routeAttempts.map((row) => row.id),
    commandIds: commands.map((row) => row.id),
    ledgerEntryIds: ledger.map((row) => row.id),
    checks,
  };
  return {
    checks,
    authorityRef: `authority:incident-recovery:${canonicalSha256(authoritySnapshot)}`,
  };
}

type TriageIncidentInput = {
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
};

export async function triageIncidentInTransaction(
  tx: Prisma.TransactionClient,
  input: TriageIncidentInput,
) {
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
}

export async function triageIncident(input: TriageIncidentInput) {
  return prisma.$transaction((tx) => triageIncidentInTransaction(tx, input));
}

export async function verifyIncidentRecovery(input: {
  readonly incidentId: string;
  readonly actor: Actor;
  readonly expectedVersion: number;
  readonly mode: IncidentRecoveryVerificationRequest["mode"];
  readonly evidenceRefs: readonly string[];
  readonly overrideReason?: string;
  readonly requestId: string;
  readonly now?: Date;
}, db?: Prisma.TransactionClient) {
  if (input.mode === "override" && !input.overrideReason?.trim()) {
    throw Errors.badRequest("Recovery verification override requires a reason");
  }
  if (input.mode === "override" && input.evidenceRefs.length === 0) {
    throw Errors.badRequest("Recovery verification override requires evidence");
  }
  const execute = async (tx: Prisma.TransactionClient) => {
    await tx.$queryRaw`SELECT id FROM "ops_incidents" WHERE id = ${input.incidentId} FOR UPDATE`;
    const current = await tx.opsIncident.findUnique({ where: { id: input.incidentId } });
    if (!current) throw Errors.notFound("Incident not found");
    if (current.version !== input.expectedVersion) throw Errors.conflict("Incident version changed");
    if (!["mitigating", "monitoring"].includes(current.status)) {
      throw Errors.conflict("Incident must be mitigating or monitoring before recovery verification");
    }
    const now = input.now ?? new Date();
    const derived = input.mode === "derive"
      ? await deriveIncidentRecoveryChecks(tx, current, now)
      : null;
    const state = input.mode === "override"
      ? "overridden" as const
      : Object.values(derived!.checks).every((check) => check.passed)
        ? "passed" as const
        : "failed" as const;
    const evidenceRefs = input.mode === "derive"
      ? [derived!.authorityRef, ...input.evidenceRefs]
      : [...input.evidenceRefs];
    const mitigation = {
      ...record(current.mitigation),
      verification: {
        state,
        checkedAt: now.toISOString(),
        evidenceRefs,
        checks: derived?.checks ?? null,
        overrideReason: input.overrideReason ?? null,
      },
    };
    const updated = await tx.opsIncident.update({
      where: { id: current.id, version: current.version },
      data: {
        status: "monitoring",
        verificationState: state,
        mitigation: toInputJson(mitigation),
        version: { increment: 1 },
      },
    });
    await tx.adminAuditLog.create({
      data: {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: state === "overridden"
          ? "incident.recovery.overridden"
          : state === "passed"
            ? "incident.recovery.verified"
            : "incident.recovery.failed",
        targetType: "ops_incident",
        targetId: current.id,
        reason: input.overrideReason ?? `Authority-derived recovery verification ${state}`,
        before: toInputJson({ status: current.status, verificationState: current.verificationState, version: current.version }),
        after: toInputJson({
          status: updated.status,
          verificationState: updated.verificationState,
          version: updated.version,
          evidenceRefs,
          checks: derived?.checks ?? null,
        }),
        requestId: input.requestId,
      },
    });
    await tx.mainOutboxEvent.create({
      data: {
        eventType: `ops.incident.recovery_${state}.v2`,
        aggregateType: "ops_incident",
        aggregateId: current.id,
        payload: toInputJson({ incidentId: current.id, state, evidenceRefs, version: updated.version }),
      },
    });
    return {
      incidentId: updated.id,
      status: updated.status,
      verificationState: updated.verificationState,
      version: updated.version,
    };
  };
  return db
    ? execute(db)
    : prisma.$transaction(execute, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
