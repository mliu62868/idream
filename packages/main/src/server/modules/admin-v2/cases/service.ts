import type { Appeal, ContentReport, Prisma, PrismaClient, SupportRequest } from "@prisma/client";
import {
  APPEAL_CASE_DECISIONS,
  BILLING_CASE_ACTIONS,
  CONTENT_REPORT_CASE_DECISIONS,
  SUPPORT_CASE_ACTIONS,
} from "@idream/shared/admin";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { toInputJson } from "../shared/prisma-json";

type Db = PrismaClient | Prisma.TransactionClient;
type Actor = { readonly id: string; readonly role: string };

const ACTIVE_REPORT_STATUSES = ["open", "triaged", "reviewing"];
const ACTIVE_SUPPORT_STATUSES = ["received", "open", "waiting_on_user"];
const BILLING_CATEGORIES = new Set([
  "billing",
  "billing_dispute",
  "charge",
  "duplicate_charge",
  "payment",
  "refund",
  "subscription",
]);
const SUPPORT_ACTION_SET = new Set<string>(SUPPORT_CASE_ACTIONS);
const BILLING_ACTION_SET = new Set<string>(BILLING_CASE_ACTIONS);
const CONTENT_REPORT_DECISION_SET = new Set<string>(CONTENT_REPORT_CASE_DECISIONS);
const APPEAL_DECISION_SET = new Set<string>(APPEAL_CASE_DECISIONS);

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

function priorityForSupport(priority: number) {
  return priorityForReport(priority);
}

function supportCaseType(category: string) {
  return BILLING_CATEGORIES.has(category.trim().toLowerCase())
    ? "billing_dispute"
    : "support_request";
}

function supportCaseKey(request: Pick<SupportRequest, "ticketId">) {
  return `ticket:${request.ticketId}`;
}

function supportStatus(status: string) {
  if (status === "waiting_on_user") return "waiting";
  if (status === "resolved") return "resolved";
  if (status === "closed") return "closed";
  if (status === "open") return "triaged";
  return "new";
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

export function transformCustomerCaseBackfill(request: SupportRequest) {
  const type = supportCaseType(request.category);
  const priority = priorityForSupport(request.priority);
  const terminal = !ACTIVE_SUPPORT_STATUSES.includes(request.status);
  return {
    classification: "eligible" as const,
    action: "ensure_customer_case" as const,
    before: {
      sourceStatus: request.status,
      category: request.category,
      assignedToId: request.assignedToId,
    },
    after: {
      caseType: type,
      targetType: "user",
      targetId: request.userId,
      status: supportStatus(request.status),
      priority,
      ownerId: request.assignedToId,
      verificationState: terminal ? "overridden" : "pending",
    },
    mismatches: [] as Array<{ code: string; detail: string }>,
  };
}

export async function applyCustomerCaseBackfill(db: Db, request: SupportRequest) {
  const adminCase = await ensureSupportCaseForRequest(db, request);
  if (!adminCase) throw Errors.internal("Customer Case transformation did not produce Case authority");
  return adminCase;
}

export async function ensureSupportCaseForRequest(db: Db, request: SupportRequest) {
  const type = supportCaseType(request.category);
  const key = supportCaseKey(request);
  const keyActive = activeKey(type, "user", request.userId, key);
  const sourceEvidence = await db.caseEvidence.findFirst({
    where: { sourceType: "support_request", sourceId: request.id },
  });
  if (sourceEvidence) {
    return db.adminCase.findUnique({ where: { id: sourceEvidence.caseId } });
  }

  const isActive = ACTIVE_SUPPORT_STATUSES.includes(request.status);
  const priority = priorityForSupport(request.priority);
  let adminCase = isActive
    ? await db.adminCase.upsert({
        where: { activeKey: keyActive },
        create: {
          type,
          targetType: "user",
          targetId: request.userId,
          caseKey: key,
          activeKey: keyActive,
          status: supportStatus(request.status),
          priority,
          ownerId: request.assignedToId,
          slaDueAt: slaFor(priority, request.createdAt),
          resolution: toInputJson({
            severity: severityForPriority(priority),
            category: request.category,
          }),
        },
        update: {},
      })
    : await db.adminCase.create({
        data: {
          type,
          targetType: "user",
          targetId: request.userId,
          caseKey: key,
          activeKey: null,
          status: supportStatus(request.status),
          priority,
          ownerId: request.assignedToId,
          slaDueAt: request.resolvedAt ?? request.updatedAt,
          verificationState: "overridden",
        },
      });

  const evidence = await db.caseEvidence.create({
    data: {
      caseId: adminCase.id,
      sourceType: "support_request",
      sourceId: request.id,
      snapshot: toInputJson({
        ticketId: request.ticketId,
        userId: request.userId,
        category: request.category,
        subject: request.subject,
        description: request.description,
        diagnosticConsent: request.diagnosticConsent,
        sourcePath: request.sourcePath,
        sourceStatus: request.status,
        assignedToId: request.assignedToId,
        resolutionNotes: request.resolutionNotes,
      }),
      occurredAt: request.createdAt,
    },
  });

  if (type === "billing_dispute") {
    await addBillingEvidence(db, adminCase.id, request.userId);
  }

  if (!isActive) {
    const verifiedAt = (request.resolvedAt ?? request.updatedAt).toISOString();
    adminCase = await db.adminCase.update({
      where: { id: adminCase.id, version: adminCase.version },
      data: {
        resolution: toInputJson({
          severity: severityForPriority(priority),
          category: request.category,
          summary: request.resolutionNotes?.trim() || `Imported terminal Support Request (${request.status})`,
          decision: request.status,
          evidenceRefs: [evidence.id],
          verification: {
            state: "overridden",
            evidenceRefs: [evidence.id],
            verifiedAt,
            overrideReason: "Legacy terminal Support Request imported without replaying downstream verification.",
          },
        }),
      },
    });
  }

  await db.adminAuditLog.create({
    data: {
      actorId: request.userId,
      actorRole: "customer",
      action: "case.evidence.added",
      targetType: "admin_case",
      targetId: adminCase.id,
      reason: "Immutable Support Request intake",
      after: toInputJson({ sourceType: "support_request", sourceId: request.id, caseType: type }),
      requestId: `case-evidence:support-request:${request.id}`,
    },
  });
  return adminCase;
}

export async function synchronizeSupportCaseFromRequest(db: Db, request: SupportRequest) {
  await ensureSupportCaseForRequest(db, request);
  const evidence = await db.caseEvidence.findFirst({
    where: { sourceType: "support_request", sourceId: request.id },
  });
  if (!evidence) throw Errors.internal("Support Case intake evidence is missing");
  const current = await db.adminCase.findUnique({ where: { id: evidence.caseId } });
  if (!current) throw Errors.internal("Support Case is missing");
  const terminal = ["resolved", "closed"].includes(request.status);
  const priority = priorityForSupport(request.priority);
  let resolutionEvidenceId = evidence.id;
  if (terminal) {
    const resolutionEvidence = await db.caseEvidence.upsert({
      where: {
        caseId_sourceType_sourceId: {
          caseId: current.id,
          sourceType: "support_resolution",
          sourceId: request.id,
        },
      },
      create: {
        caseId: current.id,
        sourceType: "support_resolution",
        sourceId: request.id,
        snapshot: toInputJson({
          sourceStatus: request.status,
          resolutionNotes: request.resolutionNotes,
          assignedToId: request.assignedToId,
          resolvedAt: request.resolvedAt,
        }),
        occurredAt: request.resolvedAt ?? request.updatedAt,
      },
      update: {},
    });
    resolutionEvidenceId = resolutionEvidence.id;
  }
  const baseResolution = current.resolution && typeof current.resolution === "object" && !Array.isArray(current.resolution)
    ? current.resolution as Record<string, unknown>
    : {};
  return db.adminCase.update({
    where: { id: current.id, version: current.version },
    data: {
      activeKey: terminal
        ? null
        : activeKey(current.type, current.targetType, current.targetId, current.caseKey),
      status: supportStatus(request.status),
      priority,
      ownerId: request.assignedToId,
      slaDueAt: terminal ? request.resolvedAt ?? request.updatedAt : slaFor(priority, request.createdAt),
      verificationState: terminal ? "overridden" : "pending",
      resolution: terminal
        ? toInputJson({
            ...baseResolution,
            summary: request.resolutionNotes?.trim() || `Support Request ${request.status}`,
            decision: request.status,
            evidenceRefs: [evidence.id, resolutionEvidenceId],
            verification: {
              state: "overridden",
              evidenceRefs: [resolutionEvidenceId],
              verifiedAt: (request.resolvedAt ?? request.updatedAt).toISOString(),
              overrideReason: "Legacy Support Request update does not include system verification.",
            },
          })
        : toInputJson({ ...baseResolution, severity: severityForPriority(priority), category: request.category }),
      version: { increment: 1 },
    },
  });
}

async function addBillingEvidence(db: Db, caseId: string, userId: string) {
  const [subscription, ledger] = await Promise.all([
    db.subscription.findFirst({
      where: { userId },
      include: { plan: true },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    }),
    db.dreamcoinLedger.findFirst({
      where: { userId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }),
  ]);
  if (subscription) {
    await db.caseEvidence.upsert({
      where: {
        caseId_sourceType_sourceId: {
          caseId,
          sourceType: "subscription_snapshot",
          sourceId: subscription.id,
        },
      },
      create: {
        caseId,
        sourceType: "subscription_snapshot",
        sourceId: subscription.id,
        snapshot: toInputJson({
          userId,
          status: subscription.status,
          provider: subscription.provider,
          providerSubscriptionId: subscription.providerSubscriptionId,
          currentPeriodEnd: subscription.currentPeriodEnd,
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
          plan: {
            id: subscription.plan.id,
            name: subscription.plan.name,
            billingPeriod: subscription.plan.billingPeriod,
            priceCents: subscription.plan.priceCents,
          },
        }),
        occurredAt: subscription.updatedAt,
      },
      update: {},
    });
  }
  if (ledger) {
    await db.caseEvidence.upsert({
      where: {
        caseId_sourceType_sourceId: {
          caseId,
          sourceType: "dreamcoin_ledger",
          sourceId: ledger.id,
        },
      },
      create: {
        caseId,
        sourceType: "dreamcoin_ledger",
        sourceId: ledger.id,
        snapshot: toInputJson({
          userId,
          delta: ledger.delta,
          balanceAfter: ledger.balanceAfter,
          reason: ledger.reason,
          sourceId: ledger.sourceId,
        }),
        occurredAt: ledger.createdAt,
      },
      update: {},
    });
  }
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

export type ReviewCaseBackfillSource =
  | { readonly type: "content_report"; readonly row: ContentReport }
  | { readonly type: "appeal"; readonly row: Appeal };

export function transformReviewCaseBackfill(source: ReviewCaseBackfillSource) {
  const active = source.type === "content_report"
    ? ACTIVE_REPORT_STATUSES.includes(source.row.status)
    : source.row.status === "open";
  return {
    classification: "eligible" as const,
    action: active ? "ensure_active_review_case" as const : "import_terminal_review_evidence" as const,
    before: {
      sourceType: source.type,
      sourceStatus: source.row.status,
      targetType: source.row.targetType,
      targetId: source.row.targetId,
    },
    after: {
      caseType: source.type === "content_report" ? "content_report" : "appeal",
      status: active ? "new" : "closed",
      active,
      verificationState: active ? "pending" : "overridden",
    },
    mismatches: [] as Array<{ code: string; detail: string }>,
  };
}

export async function applyReviewCaseBackfill(
  db: Prisma.TransactionClient,
  source: ReviewCaseBackfillSource,
  actor: Actor,
) {
  if (source.type === "content_report") {
    if (ACTIVE_REPORT_STATUSES.includes(source.row.status)) {
      return ensureReviewCaseForReport(db, source.row);
    }
    return importTerminalReviewEvidence(db, source.type, source.row, actor);
  }
  if (source.row.status === "open") return ensureReviewCaseForAppeal(db, source.row);
  return importTerminalReviewEvidence(db, source.type, source.row, actor);
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

type AssignReviewCaseInput = {
  readonly caseId: string;
  readonly actor: Actor;
  readonly expectedVersion: number;
  readonly ownerId: string | null;
  readonly priority?: "urgent" | "high" | "normal" | "low";
  readonly slaDueAt?: Date;
  readonly reason: string;
  readonly requestId: string;
};

export async function assignReviewCaseInTransaction(
  tx: Prisma.TransactionClient,
  input: AssignReviewCaseInput,
) {
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
}

export async function assignReviewCase(input: AssignReviewCaseInput) {
  return prisma.$transaction((tx) => assignReviewCaseInTransaction(tx, input));
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
  if (!CONTENT_REPORT_DECISION_SET.has(input.decision) && current.type === "content_report") {
    throw Errors.badRequest("Decision is not valid for a Content Report Case", {
      caseType: current.type,
      decision: input.decision,
    });
  }
  if (!APPEAL_DECISION_SET.has(input.decision) && current.type === "appeal") {
    throw Errors.badRequest("Decision is not valid for an Appeal Case", {
      caseType: current.type,
      decision: input.decision,
    });
  }
  if (!["content_report", "appeal"].includes(current.type)) {
    throw Errors.badRequest("Support and Billing Cases require the subtype action endpoint", {
      caseType: current.type,
      actionEndpoint: `/api/v2/admin/cases/${current.id}/actions`,
    });
  }
  if (["closed", "resolved"].includes(current.status)) {
    throw Errors.conflict("Terminal case must be reopened before a new decision");
  }
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
      activeKey: input.downstreamVerified ? null : current.activeKey,
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

async function deriveCaseOutcomeVerification(
  tx: Prisma.TransactionClient,
  current: { type: string; targetType: string; targetId: string; resolution: Prisma.JsonValue | null },
) {
  const resolution = current.resolution !== null && typeof current.resolution === "object" && !Array.isArray(current.resolution)
    ? current.resolution as Record<string, Prisma.JsonValue | undefined>
    : {};
  const actions = Array.isArray(resolution.actions) ? resolution.actions : [];
  const latest = actions.at(-1);
  const action = latest !== null && typeof latest === "object" && !Array.isArray(latest)
    ? latest as Record<string, Prisma.JsonValue | undefined>
    : {};
  const actionName = typeof action.action === "string" ? action.action : null;
  const outcomeRef = typeof action.outcomeRef === "string" ? action.outcomeRef : null;
  if (!actionName || !outcomeRef) {
    return { passed: false, evidence: null, blocker: "case_action_outcome_authority_missing" } as const;
  }
  if (actionName === "incident_escalated") {
    const incidentId = outcomeRef.startsWith("incident:") ? outcomeRef.slice("incident:".length) : outcomeRef;
    const incident = await tx.opsIncident.findUnique({ where: { id: incidentId }, select: { id: true, status: true } });
    return incident
      ? { passed: true, evidence: `incident:${incident.id}:${incident.status}`, blocker: null } as const
      : { passed: false, evidence: null, blocker: "linked_incident_not_found" } as const;
  }
  if (current.targetType !== "user") {
    return { passed: false, evidence: null, blocker: "case_target_has_no_supported_downstream_verifier" } as const;
  }
  if (actionName === "ledger_reconciled" || actionName === "refund_requested") {
    const expectedPrefix = actionName === "refund_requested" ? "refund:" : "ledger:";
    if (!outcomeRef.startsWith(expectedPrefix)) {
      return { passed: false, evidence: null, blocker: `outcome_ref_must_start_with_${expectedPrefix.slice(0, -1)}` } as const;
    }
    const ledger = await tx.dreamcoinLedger.findUnique({ where: { id: outcomeRef.slice(expectedPrefix.length) } });
    const eligible = ledger?.userId === current.targetId &&
      (actionName !== "refund_requested" || (ledger.reason === "refund" && ledger.delta > 0));
    return eligible
      ? { passed: true, evidence: `ledger:${ledger.id}:${ledger.reason}:${ledger.delta}`, blocker: null } as const
      : { passed: false, evidence: null, blocker: "ledger_outcome_does_not_match_case_authority" } as const;
  }
  if (actionName === "subscription_corrected") {
    const match = /^subscription:([^:]+):([^:]+)$/.exec(outcomeRef);
    if (!match) return { passed: false, evidence: null, blocker: "subscription_outcome_requires_id_and_expected_status" } as const;
    const subscription = await tx.subscription.findUnique({ where: { id: match[1] } });
    return subscription?.userId === current.targetId && subscription.status === match[2]
      ? { passed: true, evidence: `subscription:${subscription.id}:${subscription.status}`, blocker: null } as const
      : { passed: false, evidence: null, blocker: "subscription_outcome_does_not_match_case_authority" } as const;
  }
  return { passed: false, evidence: null, blocker: `no_automatic_verifier_for_${actionName}` } as const;
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
    const authority = await deriveCaseOutcomeVerification(tx, current);
    if (input.state === "passed" && !authority.passed) {
      throw Errors.conflict("Case outcome is not proven by downstream authority", {
        blocker: authority.blocker,
        requiredAction: "Record a supported downstream outcome or use an explicit audited override",
      });
    }
    const verifiedAt = new Date();
    const resolution = {
      ...(current.resolution as Record<string, unknown>),
      verification: {
        state: input.state,
        evidenceRefs: [...input.evidenceRefs],
        verifiedAt: verifiedAt.toISOString(),
        overrideReason: input.overrideReason ?? null,
        authorityEvidence: authority.evidence,
      },
    };
    const updated = await tx.adminCase.update({
      where: { id: current.id, version: current.version },
      data: {
        status: input.state === "failed" ? "in_progress" : "resolved",
        activeKey: input.state === "failed"
          ? current.activeKey ?? `${current.type}:${current.targetType}:${current.targetId}:${current.caseKey}`
          : null,
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
    await tx.decisionRecord.create({ data: {
      sourceType: "admin_case",
      sourceId: current.id,
      question: `Verify ${current.type} action outcome`,
      evidenceRefs: [...input.evidenceRefs],
      decision: `verification_${input.state}`,
      ownerId: input.actor.id,
      successCriteria: ["downstream_outcome_verified"],
      guardrails: ["authority_derived_or_explicit_override", "evidence_preserved"],
      outcome: toInputJson({
        verificationState: input.state,
        authorityEvidence: authority.evidence,
        overrideReason: input.overrideReason ?? null,
        verifiedAt: verifiedAt.toISOString(),
      }),
    } });
    await tx.mainOutboxEvent.create({ data: {
      eventType: "admin.case.verification.recorded.v2",
      aggregateType: "admin_case",
      aggregateId: current.id,
      payload: toInputJson({
        caseId: current.id,
        state: input.state,
        authorityEvidence: authority.evidence,
        version: updated.version,
      }),
    } });
    return updated;
  });
}

export async function recordCustomerCaseAction(input: {
  readonly caseId: string;
  readonly actor: Actor;
  readonly expectedVersion: number;
  readonly action:
    | "diagnostic_reviewed"
    | "reply_requested"
    | "incident_escalated"
    | "account_guidance_provided"
    | "ledger_reconciled"
    | "refund_requested"
    | "subscription_corrected";
  readonly summary: string;
  readonly evidenceRefs: readonly string[];
  readonly outcomeRef: string;
  readonly requestId: string;
}) {
  return prisma.$transaction(async (tx) => {
    const current = await tx.adminCase.findUnique({ where: { id: input.caseId } });
    if (!current) throw Errors.notFound("Case not found");
    assertCaseScope(current, input.actor);
    if (!["support_request", "billing_dispute"].includes(current.type)) {
      throw Errors.badRequest("Customer Case actions only apply to Support/Billing subtypes");
    }
    const allowed = current.type === "billing_dispute" ? BILLING_ACTION_SET : SUPPORT_ACTION_SET;
    if (!allowed.has(input.action)) {
      throw Errors.badRequest("Action is not valid for this Case subtype", {
        caseType: current.type,
        action: input.action,
      });
    }
    if (current.version !== input.expectedVersion) throw Errors.conflict("Case version changed");
    if (["resolved", "closed"].includes(current.status)) {
      throw Errors.conflict("Terminal Case must be reopened before another action");
    }
    const evidenceCount = await tx.caseEvidence.count({
      where: { caseId: current.id, id: { in: [...input.evidenceRefs] } },
    });
    if (input.evidenceRefs.length === 0 || evidenceCount !== new Set(input.evidenceRefs).size) {
      throw Errors.badRequest("Action evidence must reference evidence on this Case");
    }
    const currentResolution = current.resolution && typeof current.resolution === "object" && !Array.isArray(current.resolution)
      ? current.resolution as Record<string, unknown>
      : {};
    let canonicalOutcomeRef = input.outcomeRef;
    if (input.action === "incident_escalated") {
      const incidentId = input.outcomeRef.startsWith("incident:") ? input.outcomeRef.slice("incident:".length) : input.outcomeRef;
      const incident = await tx.opsIncident.findUnique({ where: { id: incidentId }, select: { id: true } });
      if (!incident) throw Errors.badRequest("Incident escalation outcomeRef must identify an existing Incident");
      canonicalOutcomeRef = `incident:${incident.id}`;
    }
    const priorActions = Array.isArray(currentResolution.actions) ? currentResolution.actions : [];
    const decidedAt = new Date();
    const action = {
      action: input.action,
      summary: input.summary,
      evidenceRefs: [...input.evidenceRefs],
      outcomeRef: canonicalOutcomeRef,
      actorId: input.actor.id,
      performedAt: decidedAt.toISOString(),
    };
    const updated = await tx.adminCase.update({
      where: { id: current.id, version: current.version },
      data: {
        status: "in_progress",
        verificationState: "pending",
        resolution: toInputJson({
          ...currentResolution,
          summary: input.summary,
          decision: input.action,
          evidenceRefs: [...input.evidenceRefs],
          decidedById: input.actor.id,
          decidedAt: decidedAt.toISOString(),
          verification: {
            state: "pending",
            evidenceRefs: [...input.evidenceRefs],
            verifiedAt: null,
          },
          actions: [...priorActions, action],
        }),
        version: { increment: 1 },
      },
    });
    await tx.decisionRecord.create({
      data: {
        sourceType: "admin_case",
        sourceId: current.id,
        question: `Execute ${current.type} action`,
        evidenceRefs: [...input.evidenceRefs],
        decision: input.action,
        ownerId: input.actor.id,
        successCriteria: ["action_outcome_verified"],
        guardrails: ["typed_subtype_action", "evidence_preserved"],
        outcome: toInputJson({ outcomeRef: canonicalOutcomeRef, verificationState: "pending" }),
      },
    });
    await tx.adminAuditLog.create({
      data: {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: "case.action.recorded",
        targetType: "admin_case",
        targetId: current.id,
        reason: input.summary,
        before: toInputJson({ status: current.status, version: current.version }),
        after: toInputJson({ ...action, status: updated.status, version: updated.version }),
        requestId: input.requestId,
      },
    });
    await tx.mainOutboxEvent.create({
      data: {
        eventType: "admin.case.action.recorded.v2",
        aggregateType: "admin_case",
        aggregateId: current.id,
        payload: toInputJson({ caseId: current.id, ...action, version: updated.version }),
      },
    });
    return updated;
  });
}

export async function waitCase(input: {
  readonly caseId: string;
  readonly actor: Actor;
  readonly expectedVersion: number;
  readonly reason: string;
  readonly resumeAt?: Date;
  readonly requestId: string;
}) {
  return prisma.$transaction(async (tx) => {
    const current = await tx.adminCase.findUnique({ where: { id: input.caseId } });
    if (!current) throw Errors.notFound("Case not found");
    assertCaseScope(current, input.actor);
    if (current.version !== input.expectedVersion) throw Errors.conflict("Case version changed");
    if (!["new", "triaged", "in_progress", "reopened"].includes(current.status)) {
      throw Errors.conflict("Only active Cases can enter waiting state");
    }
    const prior = current.resolution && typeof current.resolution === "object" && !Array.isArray(current.resolution)
      ? current.resolution as Record<string, unknown>
      : {};
    const updated = await tx.adminCase.update({
      where: { id: current.id, version: current.version },
      data: {
        status: "waiting",
        resolution: toInputJson({
          ...prior,
          waiting: { reason: input.reason, resumeAt: input.resumeAt?.toISOString() ?? null, recordedAt: new Date().toISOString() },
        }),
        version: { increment: 1 },
      },
    });
    await tx.adminAuditLog.create({ data: {
      actorId: input.actor.id,
      actorRole: input.actor.role,
      action: "case.waiting.recorded",
      targetType: "admin_case",
      targetId: current.id,
      reason: input.reason,
      before: toInputJson({ status: current.status, version: current.version }),
      after: toInputJson({ status: updated.status, version: updated.version, resumeAt: input.resumeAt ?? null }),
      requestId: input.requestId,
    } });
    await tx.mainOutboxEvent.create({ data: {
      eventType: "admin.case.waiting.recorded.v2",
      aggregateType: "admin_case",
      aggregateId: current.id,
      payload: toInputJson({ caseId: current.id, version: updated.version, resumeAt: input.resumeAt?.toISOString() ?? null }),
    } });
    return updated;
  });
}

export async function reopenOrRecurCase(input: {
  readonly caseId: string;
  readonly actor: Actor;
  readonly expectedVersion: number;
  readonly reason: string;
  readonly requestId: string;
  readonly reopenWindowMs?: number;
}) {
  return prisma.$transaction(async (tx) => {
    const current = await tx.adminCase.findUnique({ where: { id: input.caseId } });
    if (!current) throw Errors.notFound("Case not found");
    assertCaseScope(current, input.actor);
    if (current.version !== input.expectedVersion) throw Errors.conflict("Case version changed");
    if (!["resolved", "closed"].includes(current.status)) throw Errors.conflict("Only terminal Cases can be reopened");
    const activeKey = `${current.type}:${current.targetType}:${current.targetId}:${current.caseKey}`;
    const existingActive = await tx.adminCase.findFirst({ where: { activeKey, id: { not: current.id } }, select: { id: true } });
    if (existingActive) throw Errors.conflict("A recurrence of this Case is already active", { activeCaseId: existingActive.id });
    const cutoff = Date.now() - (input.reopenWindowMs ?? 7 * 24 * 60 * 60 * 1_000);
    const reopenSameCase = current.updatedAt.getTime() >= cutoff;
    if (reopenSameCase) {
      const updated = await tx.adminCase.update({
        where: { id: current.id, version: current.version },
        data: { status: "reopened", activeKey, verificationState: "pending", version: { increment: 1 } },
      });
      await tx.adminAuditLog.create({ data: {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: "case.reopened",
        targetType: "admin_case",
        targetId: current.id,
        reason: input.reason,
        before: toInputJson({ status: current.status, activeKey: current.activeKey, version: current.version }),
        after: toInputJson({ status: updated.status, activeKey: updated.activeKey, version: updated.version }),
        requestId: input.requestId,
      } });
      await tx.mainOutboxEvent.create({ data: { eventType: "admin.case.reopened.v2", aggregateType: "admin_case", aggregateId: current.id, payload: toInputJson({ caseId: current.id, version: updated.version }) } });
      return { mode: "reopened" as const, adminCase: updated };
    }
    const terminal = current.activeKey === null
      ? current
      : await tx.adminCase.update({
          where: { id: current.id, version: current.version },
          data: { activeKey: null, version: { increment: 1 } },
        });
    if (current.activeKey !== null) {
      await tx.adminAuditLog.create({ data: {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: "case.terminal_identity.released",
        targetType: "admin_case",
        targetId: current.id,
        reason: "Release stale terminal active identity before creating recurrence",
        before: toInputJson({ status: current.status, activeKey: current.activeKey, version: current.version }),
        after: toInputJson({ status: terminal.status, activeKey: terminal.activeKey, version: terminal.version }),
        requestId: `${input.requestId}:release-terminal-identity`,
      } });
      await tx.mainOutboxEvent.create({ data: {
        eventType: "admin.case.terminal_identity_released.v2",
        aggregateType: "admin_case",
        aggregateId: current.id,
        payload: toInputJson({ caseId: current.id, version: terminal.version }),
      } });
    }
    const recurrence = await tx.adminCase.create({ data: {
      type: current.type,
      targetType: current.targetType,
      targetId: current.targetId,
      caseKey: current.caseKey,
      activeKey,
      status: "new",
      priority: current.priority,
      ownerId: current.ownerId,
      slaDueAt: current.slaDueAt ? new Date(Date.now() + Math.max(60_000, current.slaDueAt.getTime() - current.createdAt.getTime())) : null,
      resolution: toInputJson({ recurrenceOfCaseId: terminal.id, recurrenceReason: input.reason }),
      verificationState: "pending",
    } });
    await tx.caseEvidence.create({ data: {
      caseId: recurrence.id,
      sourceType: "case_recurrence",
      sourceId: terminal.id,
      snapshot: toInputJson({ priorCaseId: terminal.id, priorStatus: terminal.status, priorVersion: terminal.version, closedAt: terminal.updatedAt }),
      occurredAt: new Date(),
    } });
    await tx.adminAuditLog.create({ data: {
      actorId: input.actor.id,
      actorRole: input.actor.role,
      action: "case.recurrence.created",
      targetType: "admin_case",
      targetId: recurrence.id,
      reason: input.reason,
      before: toInputJson({ priorCaseId: terminal.id, status: terminal.status, version: terminal.version }),
      after: toInputJson({ recurrenceCaseId: recurrence.id, status: recurrence.status, version: recurrence.version }),
      requestId: input.requestId,
    } });
    await tx.mainOutboxEvent.create({ data: { eventType: "admin.case.recurrence.created.v2", aggregateType: "admin_case", aggregateId: recurrence.id, payload: toInputJson({ caseId: recurrence.id, priorCaseId: terminal.id, priorCaseVersion: terminal.version, version: recurrence.version }) } });
    return { mode: "recurrence" as const, adminCase: recurrence };
  });
}
