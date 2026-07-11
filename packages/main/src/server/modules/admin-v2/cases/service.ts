import type { Appeal, ContentReport, Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { toInputJson } from "../shared/prisma-json";

type Db = PrismaClient | Prisma.TransactionClient;
type Actor = { readonly id: string; readonly role: string };

const ACTIVE_REPORT_STATUSES = ["open", "triaged", "reviewing"];

function reportCaseKey(report: Pick<ContentReport, "category">) {
  return `review:${report.category.trim().toLowerCase()}`;
}

function appealCaseKey(appeal: Pick<Appeal, "originalDecisionId" | "targetType" | "targetId">) {
  return `appeal:${appeal.originalDecisionId ?? `${appeal.targetType}:${appeal.targetId}`}`;
}

function activeKey(type: string, targetType: string, targetId: string, caseKey: string) {
  return `${type}:${targetType}:${targetId}:${caseKey}`;
}

function priorityForReport(priority: number) {
  if (priority <= 1) return "urgent";
  if (priority === 2) return "high";
  if (priority >= 4) return "low";
  return "normal";
}

function severityForPriority(priority: string) {
  if (priority === "urgent") return "critical";
  if (priority === "high") return "high";
  if (priority === "low") return "low";
  return "medium";
}

function priorityRank(priority: string) {
  return ["urgent", "high", "normal", "low"].indexOf(priority);
}

function assertCaseScope(adminCase: { type: string }, actor: Actor) {
  if (actor.role === "support" && !["support_request", "billing_dispute"].includes(adminCase.type)) {
    throw Errors.forbidden("Case subtype is outside the actor's permission scope", {
      scope: "support_case_subtypes",
      caseType: adminCase.type,
    });
  }
}

function slaFor(priority: string, createdAt: Date) {
  const hours = priority === "urgent" ? 1 : priority === "high" ? 4 : priority === "low" ? 72 : 24;
  return new Date(createdAt.getTime() + hours * 60 * 60 * 1_000);
}

function decodeBackfillCursor(cursor?: string) {
  if (!cursor) return { reportId: undefined, appealId: undefined };
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      reportId?: unknown;
      appealId?: unknown;
    };
    return {
      reportId: typeof parsed.reportId === "string" ? parsed.reportId : undefined,
      appealId: typeof parsed.appealId === "string" ? parsed.appealId : undefined,
    };
  } catch {
    return { reportId: cursor, appealId: cursor };
  }
}

function encodeBackfillCursor(cursor: { reportId?: string; appealId?: string }) {
  if (!cursor.reportId && !cursor.appealId) return null;
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export async function ensureReviewCaseForReport(db: Db, report: ContentReport) {
  const key = reportCaseKey(report);
  const keyActive = activeKey("content_report", report.targetType, report.targetId, key);
  const existing = await db.adminCase.findUnique({ where: { activeKey: keyActive } });
  let adminCase = existing;
  if (ACTIVE_REPORT_STATUSES.includes(report.status)) {
    const priority = priorityForReport(report.priority);
    adminCase = await db.adminCase.upsert({
      where: { activeKey: keyActive },
      create: {
        type: "content_report",
        targetType: report.targetType,
        targetId: report.targetId,
        caseKey: key,
        activeKey: keyActive,
        status: "new",
        priority,
        slaDueAt: slaFor(priority, report.createdAt),
        resolution: toInputJson({ severity: severityForPriority(priority) }),
      },
      update: {},
    });
    if (existing && priorityRank(priority) < priorityRank(existing.priority)) {
      adminCase = await db.adminCase.update({
        where: { id: existing.id, version: existing.version },
        data: {
          priority,
          slaDueAt:
            existing.slaDueAt && existing.slaDueAt < slaFor(priority, report.createdAt)
              ? existing.slaDueAt
              : slaFor(priority, report.createdAt),
          resolution: toInputJson({
            ...(existing.resolution as Record<string, unknown>),
            severity: severityForPriority(priority),
          }),
          version: { increment: 1 },
        },
      });
    }
  }
  if (!adminCase) return null;
  const priorEvidence = await db.caseEvidence.findUnique({
    where: {
      caseId_sourceType_sourceId: {
        caseId: adminCase.id,
        sourceType: "content_report",
        sourceId: report.id,
      },
    },
  });
  await db.caseEvidence.upsert({
    where: {
      caseId_sourceType_sourceId: {
        caseId: adminCase.id,
        sourceType: "content_report",
        sourceId: report.id,
      },
    },
    create: {
      caseId: adminCase.id,
      sourceType: "content_report",
      sourceId: report.id,
      snapshot: toInputJson({
        targetType: report.targetType,
        targetId: report.targetId,
        category: report.category,
        description: report.description,
        reporterId: report.reporterId,
        priority: report.priority,
        sourceStatus: report.status,
      }),
      occurredAt: report.createdAt,
    },
    update: {},
  });
  if (!priorEvidence) {
    await db.adminAuditLog.create({
      data: {
        actorId: report.reporterId ?? "system",
        actorRole: report.reporterId ? "customer" : "system",
        action: "case.evidence.added",
        targetType: "admin_case",
        targetId: adminCase.id,
        reason: "Immutable content report intake",
        after: toInputJson({ sourceType: "content_report", sourceId: report.id }),
        requestId: `case-evidence:content-report:${report.id}`,
      },
    });
  }
  return adminCase;
}

export async function ensureReviewCaseForAppeal(db: Db, appeal: Appeal) {
  const key = appealCaseKey(appeal);
  const keyActive = activeKey("appeal", appeal.targetType, appeal.targetId, key);
  let adminCase = await db.adminCase.findUnique({ where: { activeKey: keyActive } });
  if (appeal.status === "open") {
    adminCase = await db.adminCase.upsert({
      where: { activeKey: keyActive },
      create: {
        type: "appeal",
        targetType: appeal.targetType,
        targetId: appeal.targetId,
        caseKey: key,
        activeKey: keyActive,
        status: "new",
        priority: "high",
        slaDueAt: new Date(appeal.createdAt.getTime() + 48 * 60 * 60 * 1_000),
        resolution: toInputJson({
          severity: "high",
          parentDecisionId: appeal.originalDecisionId,
        }),
      },
      update: {},
    });
  }
  if (!adminCase) return null;
  const priorEvidence = await db.caseEvidence.findUnique({
    where: {
      caseId_sourceType_sourceId: {
        caseId: adminCase.id,
        sourceType: "appeal",
        sourceId: appeal.id,
      },
    },
  });
  await db.caseEvidence.upsert({
    where: {
      caseId_sourceType_sourceId: {
        caseId: adminCase.id,
        sourceType: "appeal",
        sourceId: appeal.id,
      },
    },
    create: {
      caseId: adminCase.id,
      sourceType: "appeal",
      sourceId: appeal.id,
      snapshot: toInputJson({
        targetType: appeal.targetType,
        targetId: appeal.targetId,
        appellantId: appeal.userId,
        originalDecisionId: appeal.originalDecisionId,
        appealText: appeal.appealText,
        sourceStatus: appeal.status,
      }),
      occurredAt: appeal.createdAt,
    },
    update: {},
  });
  if (!priorEvidence) {
    await db.adminAuditLog.create({
      data: {
        actorId: appeal.userId,
        actorRole: "customer",
        action: "case.evidence.added",
        targetType: "admin_case",
        targetId: adminCase.id,
        reason: "Immutable appeal intake",
        after: toInputJson({ sourceType: "appeal", sourceId: appeal.id }),
        requestId: `case-evidence:appeal:${appeal.id}`,
      },
    });
  }
  return adminCase;
}

export async function backfillReviewCases(input: {
  readonly dryRun: boolean;
  readonly cursor?: string;
  readonly batchSize?: number;
  readonly actor: Actor;
}) {
  const take = Math.min(500, Math.max(1, input.batchSize ?? 100));
  const cursor = decodeBackfillCursor(input.cursor);
  const [reports, appeals] = await Promise.all([
    prisma.contentReport.findMany({
      where: {
        ...(cursor.reportId ? { id: { gt: cursor.reportId } } : {}),
      },
      orderBy: { id: "asc" },
      take,
    }),
    prisma.appeal.findMany({
      where: {
        ...(cursor.appealId ? { id: { gt: cursor.appealId } } : {}),
      },
      orderBy: { id: "asc" },
      take,
    }),
  ]);
  const before = await prisma.adminCase.count({ where: { type: { in: ["content_report", "appeal"] } } });
  const sourceRows = [
    ...reports.map((row) => ({ type: "content_report" as const, row })),
    ...appeals.map((row) => ({ type: "appeal" as const, row })),
  ].sort((left, right) => left.row.id.localeCompare(right.row.id));
  let applied = 0;
  const mismatches: Array<{ sourceType: string; sourceId: string; reason: string }> = [];
  if (!input.dryRun) {
    for (const source of sourceRows) {
      try {
        await prisma.$transaction(async (tx) => {
          if (source.type === "content_report") {
            if (ACTIVE_REPORT_STATUSES.includes(source.row.status)) {
              await ensureReviewCaseForReport(tx, source.row);
            } else {
              await importTerminalReviewEvidence(tx, source.type, source.row, input.actor);
            }
          } else if (source.row.status === "open") {
            await ensureReviewCaseForAppeal(tx, source.row);
          } else {
            await importTerminalReviewEvidence(tx, source.type, source.row, input.actor);
          }
        });
        applied += 1;
      } catch (error) {
        mismatches.push({
          sourceType: source.type,
          sourceId: source.row.id,
          reason: error instanceof Error ? error.message : "unknown_error",
        });
      }
    }
  }
  return {
    dryRun: input.dryRun,
    scanned: sourceRows.length,
    eligible: sourceRows.length,
    applied,
    unavailable: [],
    mismatches,
    nextCursor:
      reports.length === take || appeals.length === take
        ? encodeBackfillCursor({
            reportId: reports.at(-1)?.id ?? cursor.reportId,
            appealId: appeals.at(-1)?.id ?? cursor.appealId,
          })
        : null,
    beforeCases: before,
    afterCases: await prisma.adminCase.count({ where: { type: { in: ["content_report", "appeal"] } } }),
  };
}

async function importTerminalReviewEvidence(
  db: Prisma.TransactionClient,
  sourceType: "content_report" | "appeal",
  source: ContentReport | Appeal,
  actor: Actor,
) {
  const prior = await db.caseEvidence.findFirst({
    where: { sourceType, sourceId: source.id },
  });
  if (prior) return prior;
  const type = sourceType;
  const targetType = source.targetType;
  const targetId = source.targetId;
  const sourceStatus = source.status;
  const report = sourceType === "content_report" ? (source as ContentReport) : null;
  const appeal = sourceType === "appeal" ? (source as Appeal) : null;
  const adminCase = await db.adminCase.create({
    data: {
      type,
      targetType,
      targetId,
      caseKey: `legacy:${sourceType}:${source.id}`,
      activeKey: null,
      status: "closed",
      priority: report ? priorityForReport(report.priority) : "high",
      slaDueAt: source.createdAt,
      verificationState: "overridden",
    },
  });
  const snapshot =
    report
      ? {
          targetType,
          targetId,
          category: report.category,
          description: report.description,
          reporterId: report.reporterId,
          sourceStatus,
        }
      : {
          targetType,
          targetId,
          appellantId: appeal?.userId,
          originalDecisionId: appeal?.originalDecisionId,
          appealText: appeal?.appealText,
          sourceStatus,
        };
  const evidence = await db.caseEvidence.create({
    data: {
      caseId: adminCase.id,
      sourceType,
      sourceId: source.id,
      snapshot: toInputJson(snapshot),
      occurredAt: source.createdAt,
    },
  });
  await db.adminCase.update({
    where: { id: adminCase.id },
    data: {
      resolution: toInputJson({
        summary: `Imported terminal ${sourceType} (${sourceStatus})`,
        decision: sourceStatus,
        evidenceRefs: [evidence.id],
        verification: {
          state: "overridden",
          evidenceRefs: [evidence.id],
          verifiedAt: new Date().toISOString(),
          overrideReason: "Legacy terminal source imported without replaying its historical downstream verification.",
        },
      }),
    },
  });
  await db.adminAuditLog.create({
    data: {
      actorId: actor.id,
      actorRole: actor.role,
      action: "case.legacy_terminal_imported",
      targetType: "admin_case",
      targetId: adminCase.id,
      reason: "Preserve terminal source as immutable Evidence without reopening",
      after: toInputJson({ sourceType, sourceId: source.id, sourceStatus, evidenceId: evidence.id }),
      requestId: `case-backfill:${sourceType}:${source.id}`,
    },
  });
  return evidence;
}

export async function assignReviewCase(input: {
  readonly caseId: string;
  readonly actor: Actor;
  readonly expectedVersion: number;
  readonly ownerId: string | null;
  readonly priority?: "urgent" | "high" | "normal" | "low";
  readonly slaDueAt?: Date;
  readonly reason: string;
  readonly requestId: string;
}) {
  return prisma.$transaction(async (tx) => {
    const current = await tx.adminCase.findUnique({ where: { id: input.caseId } });
    if (!current) throw Errors.notFound("Case not found");
    assertCaseScope(current, input.actor);
    if (current.version !== input.expectedVersion) throw Errors.conflict("Case version changed");
    if (input.ownerId) {
      const owner = await tx.user.findUnique({ where: { id: input.ownerId }, select: { role: true, status: true } });
      if (!owner || owner.status !== "active" || owner.role === "user") {
        throw Errors.badRequest("Case owner must be an active operator");
      }
    }
    const nextStatus = current.status === "new" ? "triaged" : current.status;
    const updated = await tx.adminCase.update({
      where: { id: current.id, version: current.version },
      data: {
        ownerId: input.ownerId,
        priority: input.priority,
        slaDueAt: input.slaDueAt,
        status: nextStatus,
        version: { increment: 1 },
      },
    });
    await tx.adminAuditLog.create({
      data: {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: "case.assigned",
        targetType: "admin_case",
        targetId: current.id,
        reason: input.reason,
        before: toInputJson({ ownerId: current.ownerId, priority: current.priority, slaDueAt: current.slaDueAt, status: current.status }),
        after: toInputJson({ ownerId: updated.ownerId, priority: updated.priority, slaDueAt: updated.slaDueAt, status: updated.status }),
        requestId: input.requestId,
      },
    });
    await tx.mainOutboxEvent.create({
      data: {
        eventType: "admin.case.assigned.v2",
        aggregateType: "admin_case",
        aggregateId: current.id,
        payload: toInputJson({ caseId: current.id, ownerId: updated.ownerId, version: updated.version }),
      },
    });
    return updated;
  });
}

export async function recordReviewCaseDecision(
  db: Db,
  input: {
    readonly caseId: string;
    readonly actor: Actor;
    readonly expectedVersion?: number;
    readonly decision: string;
    readonly summary: string;
    readonly evidenceRefs: readonly string[];
    readonly confidence?: number;
    readonly downstreamVerified?: boolean;
    readonly requestId: string;
  },
) {
  const current = await db.adminCase.findUnique({ where: { id: input.caseId } });
  if (!current) throw Errors.notFound("Case not found");
  assertCaseScope(current, input.actor);
  if (input.expectedVersion !== undefined && current.version !== input.expectedVersion) {
    throw Errors.conflict("Case version changed");
  }
  if (["closed"].includes(current.status)) throw Errors.conflict("Closed case must be reopened before a new decision");
  const evidence = await db.caseEvidence.count({
    where: { caseId: current.id, id: { in: [...input.evidenceRefs] } },
  });
  if (input.evidenceRefs.length === 0 || evidence !== new Set(input.evidenceRefs).size) {
    throw Errors.badRequest("Decision evidence must reference evidence on this Case");
  }
  const resolution = {
    summary: input.summary,
    decision: input.decision,
    evidenceRefs: [...input.evidenceRefs],
    decidedById: input.actor.id,
    decidedAt: new Date().toISOString(),
    verification: input.downstreamVerified
      ? { state: "passed", evidenceRefs: [...input.evidenceRefs], verifiedAt: new Date().toISOString() }
      : { state: "pending", evidenceRefs: [...input.evidenceRefs], verifiedAt: null },
  };
  const updated = await db.adminCase.update({
    where: { id: current.id, version: current.version },
    data: {
      status: input.downstreamVerified ? "resolved" : "in_progress",
      resolution: toInputJson(resolution),
      verificationState: input.downstreamVerified ? "passed" : "pending",
      version: { increment: 1 },
    },
  });
  await db.decisionRecord.create({
    data: {
      sourceType: "admin_case",
      sourceId: current.id,
      question: `Resolve ${current.type}`,
      evidenceRefs: [...input.evidenceRefs],
      decision: input.decision,
      confidence: input.confidence,
      ownerId: input.actor.id,
      successCriteria: ["downstream_outcome_verified"],
      guardrails: ["evidence_preserved", "appeal_link_preserved"],
      outcome: input.downstreamVerified ? { verificationState: "passed" } : undefined,
    },
  });
  await db.adminAuditLog.create({
    data: {
      actorId: input.actor.id,
      actorRole: input.actor.role,
      action: "case.decision.recorded",
      targetType: "admin_case",
      targetId: current.id,
      reason: input.summary,
      before: toInputJson({ status: current.status, version: current.version }),
      after: toInputJson({ status: updated.status, version: updated.version, decision: input.decision }),
      requestId: input.requestId,
    },
  });
  await db.mainOutboxEvent.create({
    data: {
      eventType: "admin.case.decision.recorded.v2",
      aggregateType: "admin_case",
      aggregateId: current.id,
      payload: toInputJson({ caseId: current.id, decision: input.decision, version: updated.version }),
    },
  });
  return updated;
}

export async function recordReviewCaseDecisionAtomic(
  input: Parameters<typeof recordReviewCaseDecision>[1],
) {
  return prisma.$transaction((tx) => recordReviewCaseDecision(tx, input));
}

export async function verifyReviewCase(input: {
  readonly caseId: string;
  readonly actor: Actor;
  readonly expectedVersion: number;
  readonly state: "passed" | "failed" | "overridden";
  readonly evidenceRefs: readonly string[];
  readonly overrideReason?: string;
  readonly requestId: string;
}) {
  if (input.evidenceRefs.length === 0) throw Errors.badRequest("Verification requires evidence");
  if (input.state === "overridden" && !input.overrideReason?.trim()) {
    throw Errors.badRequest("Verification override requires a reason");
  }
  return prisma.$transaction(async (tx) => {
    const current = await tx.adminCase.findUnique({ where: { id: input.caseId } });
    if (!current) throw Errors.notFound("Case not found");
    assertCaseScope(current, input.actor);
    if (current.version !== input.expectedVersion) throw Errors.conflict("Case version changed");
    if (!current.resolution) throw Errors.conflict("Case needs a decision before verification");
    const evidenceCount = await tx.caseEvidence.count({
      where: { caseId: current.id, id: { in: [...input.evidenceRefs] } },
    });
    if (evidenceCount !== new Set(input.evidenceRefs).size) throw Errors.badRequest("Verification evidence is outside this Case");
    const resolution = {
      ...(current.resolution as Record<string, unknown>),
      verification: {
        state: input.state,
        evidenceRefs: [...input.evidenceRefs],
        verifiedAt: new Date().toISOString(),
        overrideReason: input.overrideReason ?? null,
      },
    };
    const updated = await tx.adminCase.update({
      where: { id: current.id, version: current.version },
      data: {
        status: input.state === "failed" ? "in_progress" : "resolved",
        verificationState: input.state,
        resolution: toInputJson(resolution),
        version: { increment: 1 },
      },
    });
    await tx.adminAuditLog.create({
      data: {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: input.state === "overridden" ? "case.verification.overridden" : "case.verification.recorded",
        targetType: "admin_case",
        targetId: current.id,
        reason: input.overrideReason ?? `Verification ${input.state}`,
        before: toInputJson({ status: current.status, verificationState: current.verificationState }),
        after: toInputJson({ status: updated.status, verificationState: updated.verificationState }),
        requestId: input.requestId,
      },
    });
    return updated;
  });
}
