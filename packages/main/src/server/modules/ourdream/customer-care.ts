import type { Prisma } from "@prisma/client";
import {
  APPEAL_TARGET_TYPES,
  PRODUCT_FEEDBACK_CATEGORIES,
  SUPPORT_REQUEST_CATEGORIES,
} from "@idream/shared/catalog";
import { METRIC_PRODUCT_EVENTS, supportReplyRequestSchema } from "@idream/shared/contracts";
import { z } from "zod";
import {
  ensureReviewCaseForAppeal,
  ensureSupportCaseForRequest,
} from "@/server/modules/admin-v2/cases/service";
import { appendCanonicalMetricEvent } from "@/server/modules/admin-v2/metrics/event-writer";
import { createClassifiedAnalyticsEvent } from "@/server/modules/admin-v2/metrics/classified-event-writer";
import {
  getAuthCtx,
  requireAgeGate,
  requireUser,
} from "@/server/lib/auth";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import { jsonBody } from "@/server/lib/request-json";
import { enforceRateLimit } from "@/server/lib/rate-limit";
import {
  isCustomerEngagementActor,
  publicFeedbackAudienceWhere,
} from "./public-content-audience";
import { trackEvent } from "./product-events";
import { submitReport } from "./reports";
import { appendSupportMessage, supportConversation } from "@/server/modules/admin-v2/support/conversation";
import { transitionCase } from "@/server/modules/admin-v2/cases/transition";
import { operationsCaseStatusSchema } from "@idream/shared/admin";

type ApiMethod = "GET" | "POST" | "PATCH" | "DELETE" | "PUT";

const appealTargetTypeSchema = z.enum(APPEAL_TARGET_TYPES);

const appealCreateSchema = z.object({
  targetType: appealTargetTypeSchema,
  targetId: z.string().trim().min(1).max(300),
  appealText: z.string().min(1).max(4_000),
  originalDecisionId: z.string().trim().min(1).max(160).optional(),
});

const supportRequestSchema = z.object({
  category: z.enum(SUPPORT_REQUEST_CATEGORIES),
  subject: z.string().trim().min(3).max(120),
  description: z.string().trim().min(10).max(2_000),
  diagnosticConsent: z.boolean().default(false),
  sourcePath: z.string().trim().max(240).optional(),
});

const feedbackItemCreateSchema = z.object({
  category: z.enum(PRODUCT_FEEDBACK_CATEGORIES).default("feature"),
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().min(10).max(600),
});

type ProductFeedbackItemRow = {
  id: string;
  sourceKey: string | null;
  title: string;
  description: string;
  category: string;
  status: string;
  voteCount: number;
  createdAt: Date;
  updatedAt: Date;
};

// SPEC: Customer care is one product journey: report/appeal state, support
// requests, customer history, policies and roadmap feedback share one authority
// interface. The v1 dispatcher is only its HTTP adapter.
// INTENT: Keep permission, transaction, Case, metric and read-model knowledge in
// one deep module instead of teaching the global route table their call order.
export async function dispatchCustomerCareRequest(
  request: Request,
  segments: readonly string[],
): Promise<Response | null> {
  const method = request.method as ApiMethod;
  const [resource, id, action, child] = segments;

  if (resource === "reports") {
    if (!id && method === "POST") {
      await enforceRateLimit(request, "contentReport");
      return submitReport(request);
    }
    if (id && method === "GET") return reportStatus(request, id);
  }

  if (resource === "appeals" && !id && method === "POST") {
    return createAppeal(request);
  }

  if (resource === "policies" && !id && method === "GET") {
    return policies();
  }

  if (resource === "feedback" && id === "items") {
    if (!action && method === "GET") return listFeedbackItems(request);
    if (!action && method === "POST") return createFeedbackItem(request);
    if (action && child === "vote" && method === "POST") {
      return voteFeedbackItem(request, action);
    }
    if (action && child === "vote" && method === "DELETE") {
      return unvoteFeedbackItem(request, action);
    }
  }

  if (resource === "support" && id === "requests" && !action && method === "POST") {
    return submitSupportRequest(request);
  }
  if (resource === "support" && id === "history" && !action && method === "GET") {
    return customerHelpDeskHistory(request);
  }
  if (resource === "support" && id === "requests" && action) {
    if (!child && method === "GET") return customerSupportDetail(request, action);
    if (child === "messages" && method === "POST") return replyToSupportRequest(request, action);
  }

  return null;
}

async function reportStatus(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  const report = await prisma.contentReport.findFirst({
    where: { id, reporterId: user.id },
    select: {
      id: true,
      targetType: true,
      targetId: true,
      category: true,
      status: true,
      createdAt: true,
      reviews: {
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { id: true, decision: true, createdAt: true },
      },
    },
  });
  if (!report) throw Errors.notFound("Report not found");

  const decisionIds = [report.id, ...report.reviews.map((review) => review.id)];
  const appeals = await prisma.appeal.findMany({
    where: { userId: user.id, originalDecisionId: { in: decisionIds } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true },
  });
  const latestReview = report.reviews[0];
  return ok({
    report: {
      id: report.id,
      targetType: report.targetType,
      targetId: report.targetId,
      category: report.category,
      status: report.status,
      createdAt: report.createdAt.toISOString(),
      decision: latestReview
        ? {
            outcome: latestReview.decision,
            decidedAt: latestReview.createdAt.toISOString(),
          }
        : null,
      appealIds: appeals.map((appeal) => appeal.id),
    },
  });
}

async function createAppeal(request: Request) {
  const ctx = await getAuthCtx(request);
  requireAgeGate(ctx);
  const user = requireUser(ctx);
  const body = appealCreateSchema.parse(await jsonBody(request));
  const appeal = await prisma.$transaction(async (tx) => {
    const decisionId = await resolveAppealDecisionAuthority(tx, {
      userId: user.id,
      targetType: body.targetType,
      targetId: body.targetId,
      originalDecisionId: body.originalDecisionId,
    });
    const created = await tx.appeal.create({
      data: {
        userId: user.id,
        targetType: body.targetType,
        targetId: body.targetId,
        appealText: body.appealText,
        originalDecisionId: decisionId,
      },
    });
    await ensureReviewCaseForAppeal(tx, created);
    return created;
  });
  await trackEvent("moderation_appeal_started", { appealId: appeal.id }, ctx);
  return ok({ appeal });
}

async function resolveAppealDecisionAuthority(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    targetType: z.infer<typeof appealTargetTypeSchema>;
    targetId: string;
    originalDecisionId?: string;
  },
) {
  const exactDecisionId = input.originalDecisionId ??
    (input.targetType === "moderation_decision" ? input.targetId : undefined);
  if (
    input.targetType === "moderation_decision" &&
    input.originalDecisionId &&
    input.originalDecisionId !== input.targetId
  ) {
    throw Errors.badRequest("Appeal target does not match the moderation decision");
  }

  const targetOwnedByUser = await appealTargetOwnedByUser(tx, input);
  const decision = exactDecisionId
    ? await tx.moderationReview.findUnique({
        where: { id: exactDecisionId },
        select: {
          id: true,
          report: {
            select: { reporterId: true, targetType: true, targetId: true },
          },
        },
      })
    : await tx.moderationReview.findFirst({
        where: {
          report: {
            is: { targetType: input.targetType, targetId: input.targetId },
          },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: {
          id: true,
          report: {
            select: { reporterId: true, targetType: true, targetId: true },
          },
        },
      });
  if (!decision?.report) {
    throw Errors.badRequest("Appeal requires an existing moderation decision");
  }
  if (
    input.targetType !== "moderation_decision" &&
    (decision.report.targetType !== input.targetType ||
      decision.report.targetId !== input.targetId)
  ) {
    throw Errors.badRequest("Appeal target does not match the moderation decision");
  }
  if (decision.report.reporterId !== input.userId && !targetOwnedByUser) {
    throw Errors.forbidden("Moderation decision does not belong to this user");
  }
  return decision.id;
}

async function appealTargetOwnedByUser(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    targetType: z.infer<typeof appealTargetTypeSchema>;
    targetId: string;
  },
) {
  if (input.targetType === "user_profile") return input.targetId === input.userId;
  if (input.targetType === "character") {
    return Boolean(await tx.character.findFirst({
      where: { id: input.targetId, creatorId: input.userId },
      select: { id: true },
    }));
  }
  if (input.targetType === "media") {
    return Boolean(await tx.mediaAsset.findFirst({
      where: { id: input.targetId, ownerId: input.userId },
      select: { id: true },
    }));
  }
  return false;
}

async function policies() {
  const items = await prisma.policyVersion.findMany({
    orderBy: [{ slug: "asc" }, { publishedAt: "desc" }],
  });
  return ok({ items });
}

async function submitSupportRequest(request: Request) {
  const ctx = await getAuthCtx(request);
  requireAgeGate(ctx);
  const user = requireUser(ctx);
  const body = supportRequestSchema.parse(await jsonBody(request));
  const ticketId = supportTicketId();
  const supportRequest = await prisma.$transaction(async (tx) => {
    const created = await tx.supportRequest.create({
      data: {
        ticketId,
        userId: user.id,
        category: body.category,
        subject: body.subject,
        description: body.description,
        diagnosticConsent: body.diagnosticConsent,
        sourcePath: body.sourcePath ?? null,
        status: "received",
      },
    });
    await createClassifiedAnalyticsEvent(tx, {
      userId: user.id,
      anonymousId: ctx.anonymousId,
      name: "support_request_submitted",
      props: {
        ticketId,
        supportRequestId: created.id,
        category: body.category,
        subject: body.subject,
        description: body.description,
        diagnosticConsent: body.diagnosticConsent,
        sourcePath: body.sourcePath ?? null,
      },
    });
    await appendCanonicalMetricEvent(tx, {
      sourceEventId: `support_request:${created.id}`,
      eventType: METRIC_PRODUCT_EVENTS.supportRequestSubmitted,
      occurredAt: created.createdAt,
      userId: user.id,
      anonymousId: ctx.anonymousId,
      payload: {
        supportRequestId: created.id,
        userId: user.id,
        category: created.category,
      },
    });
    await ensureSupportCaseForRequest(tx, created);
    return created;
  });

  return ok(
    {
      request: {
        id: supportRequest.id,
        ticketId,
        status: supportRequest.status,
        category: supportRequest.category,
        createdAt: supportRequest.createdAt.toISOString(),
      },
    },
    { status: 201 },
  );
}

async function customerHelpDeskHistory(request: Request) {
  const ctx = await getAuthCtx(request);
  const viewer = requireUser(ctx);
  const customer = await prisma.user.findFirst({
    where: {
      id: viewer.id,
      dataClass: "customer",
      status: "active",
      deletedAt: null,
    },
    select: { id: true },
  });
  if (!customer) {
    throw Errors.forbidden("Customer history is unavailable for this account");
  }

  const [supportRequests, reports, appeals] = await Promise.all([
    prisma.supportRequest.findMany({
      where: {
        userId: customer.id,
        user: { is: { dataClass: "customer", status: "active", deletedAt: null } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        ticketId: true,
        category: true,
        subject: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        resolvedAt: true,
      },
    }),
    prisma.contentReport.findMany({
      where: {
        reporterId: customer.id,
        reporter: { is: { dataClass: "customer", status: "active", deletedAt: null } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        targetType: true,
        targetId: true,
        category: true,
        status: true,
        createdAt: true,
        reviews: {
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: { id: true, decision: true, createdAt: true },
        },
      },
    }),
    prisma.appeal.findMany({
      where: {
        userId: customer.id,
        user: { is: { dataClass: "customer", status: "active", deletedAt: null } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        targetType: true,
        targetId: true,
        originalDecisionId: true,
        status: true,
        createdAt: true,
        resolvedAt: true,
      },
    }),
  ]);

  const reportByDecisionId = new Map<string, string>();
  for (const report of reports) {
    reportByDecisionId.set(report.id, report.id);
    for (const review of report.reviews) reportByDecisionId.set(review.id, report.id);
  }
  const reportAppealIds = new Map<string, string[]>();
  for (const appeal of appeals) {
    if (!appeal.originalDecisionId) continue;
    const reportId = reportByDecisionId.get(appeal.originalDecisionId);
    if (!reportId) continue;
    const current = reportAppealIds.get(reportId) ?? [];
    current.push(appeal.id);
    reportAppealIds.set(reportId, current);
  }

  return ok({
    supportRequests: supportRequests.map((item) => ({
      id: item.id,
      ticketId: item.ticketId,
      category: item.category,
      subject: item.subject,
      status: item.status,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
      resolution: item.resolvedAt
        ? { outcome: item.status, resolvedAt: item.resolvedAt.toISOString() }
        : null,
    })),
    reports: reports.map((item) => {
      const latestReview = item.reviews[0];
      return {
        id: item.id,
        targetType: item.targetType,
        targetId: item.targetId,
        category: item.category,
        status: item.status,
        createdAt: item.createdAt.toISOString(),
        decision: latestReview
          ? {
              outcome: latestReview.decision,
              decidedAt: latestReview.createdAt.toISOString(),
            }
          : null,
        appealIds: reportAppealIds.get(item.id) ?? [],
      };
    }),
    appeals: appeals.map((item) => ({
      id: item.id,
      targetType: item.targetType,
      targetId: item.targetId,
      status: item.status,
      createdAt: item.createdAt.toISOString(),
      relatedReportId: item.originalDecisionId
        ? (reportByDecisionId.get(item.originalDecisionId) ?? null)
        : null,
      outcome: item.resolvedAt
        ? { result: item.status, resolvedAt: item.resolvedAt.toISOString() }
        : null,
    })),
  });
}

async function customerSupportDetail(request: Request, ticketId: string) {
  const viewer = requireUser(await getAuthCtx(request));
  const ticket = await prisma.supportRequest.findFirst({
    where: { ticketId, userId: viewer.id, user: { is: { dataClass: "customer", status: "active", deletedAt: null } } },
  });
  if (!ticket) throw Errors.notFound("Support request not found");
  return ok({ request: await supportConversation(prisma, ticket) });
}

async function replyToSupportRequest(request: Request, ticketId: string) {
  const viewer = requireUser(await getAuthCtx(request));
  const body = supportReplyRequestSchema.parse(await jsonBody(request));
  const result = await prisma.$transaction(async (tx) => {
    // INVARIANT: Serialize replies with ticket status changes, so a retry cannot
    // duplicate a message or reopen a request that an operator has resolved.
    await tx.$queryRaw`SELECT id FROM support_requests WHERE "ticketId" = ${ticketId} AND "userId" = ${viewer.id} FOR UPDATE`;
    const ticket = await tx.supportRequest.findFirst({
      where: { ticketId, userId: viewer.id, user: { is: { dataClass: "customer", status: "active", deletedAt: null } } },
    });
    if (!ticket) throw Errors.notFound("Support request not found");
    const added = await appendSupportMessage(tx, ticket, { ...body, author: "customer", authorId: viewer.id, actorRole: "customer" });
    if (added.replayed) return { request: await supportConversation(tx, ticket), replayed: true };
    const updated = await tx.supportRequest.update({ where: { id: ticket.id }, data: { status: "open", resolvedAt: null } });
    const adminCase = await tx.adminCase.findUniqueOrThrow({ where: { id: added.caseId } });
    await transitionCase(tx, {
      caseId: adminCase.id, to: "in_progress",
      expected: { from: operationsCaseStatusSchema.parse(adminCase.status), version: adminCase.version },
    });
    return { request: await supportConversation(tx, updated), replayed: false };
  });
  return ok(result, { status: result.replayed ? 200 : 201 });
}

async function listFeedbackItems(request: Request) {
  const ctx = await getAuthCtx(request);
  const items = await prisma.productFeedbackItem.findMany({
    where: publicFeedbackAudienceWhere,
    orderBy: [{ voteCount: "desc" }, { createdAt: "desc" }],
    take: 12,
  });
  const votedIds = await userFeedbackVoteIds(ctx.userId, items.map((item) => item.id));
  return ok({ items: items.map((item) => feedbackItemDTO(item, votedIds)) });
}

async function createFeedbackItem(request: Request) {
  const ctx = await getAuthCtx(request);
  requireAgeGate(ctx);
  const user = requireUser(ctx);
  const body = feedbackItemCreateSchema.parse(await jsonBody(request));
  const countsAsEngagement = await isCustomerEngagementActor(user.id);
  const created = await prisma.$transaction(async (tx) => {
    const item = await tx.productFeedbackItem.create({
      data: {
        createdById: user.id,
        source: "user",
        title: body.title,
        description: body.description,
        category: body.category,
        status: "under_review",
        voteCount: countsAsEngagement ? 1 : 0,
      },
    });
    await tx.productFeedbackVote.create({ data: { userId: user.id, itemId: item.id } });
    await createClassifiedAnalyticsEvent(tx, {
      userId: user.id,
      anonymousId: ctx.anonymousId,
      name: "feedback_item_created",
      props: { itemId: item.id, category: item.category, title: item.title },
    });
    return item;
  });
  return ok({ item: feedbackItemDTO(created, new Set([created.id])) }, { status: 201 });
}

async function voteFeedbackItem(request: Request, itemId: string) {
  const ctx = await getAuthCtx(request);
  requireAgeGate(ctx);
  const user = requireUser(ctx);
  const countsAsEngagement = await isCustomerEngagementActor(user.id);
  const item = await prisma.$transaction(async (tx) => {
    const existingItem = await tx.productFeedbackItem.findFirst({
      where: { AND: [publicFeedbackAudienceWhere, { id: itemId }] },
    });
    if (!existingItem) throw Errors.notFound("Feedback item not found");
    const existingVote = await tx.productFeedbackVote.findUnique({
      where: { userId_itemId: { userId: user.id, itemId } },
    });
    if (existingVote) return existingItem;
    await tx.productFeedbackVote.create({ data: { userId: user.id, itemId } });
    const updated = countsAsEngagement
      ? await tx.productFeedbackItem.update({
          where: { id: itemId },
          data: { voteCount: { increment: 1 } },
        })
      : existingItem;
    await createClassifiedAnalyticsEvent(tx, {
      userId: user.id,
      anonymousId: ctx.anonymousId,
      name: "feedback_item_voted",
      props: { itemId },
    });
    return updated;
  });
  return ok({ item: feedbackItemDTO(item, new Set([item.id])) });
}

async function unvoteFeedbackItem(request: Request, itemId: string) {
  const ctx = await getAuthCtx(request);
  requireAgeGate(ctx);
  const user = requireUser(ctx);
  const countsAsEngagement = await isCustomerEngagementActor(user.id);
  const item = await prisma.$transaction(async (tx) => {
    const existingItem = await tx.productFeedbackItem.findFirst({
      where: { AND: [publicFeedbackAudienceWhere, { id: itemId }] },
    });
    if (!existingItem) throw Errors.notFound("Feedback item not found");
    const existingVote = await tx.productFeedbackVote.findUnique({
      where: { userId_itemId: { userId: user.id, itemId } },
    });
    if (!existingVote) return existingItem;
    await tx.productFeedbackVote.delete({ where: { id: existingVote.id } });
    const updated = countsAsEngagement
      ? await tx.productFeedbackItem.update({
          where: { id: itemId },
          data: { voteCount: { decrement: 1 } },
        })
      : existingItem;
    await createClassifiedAnalyticsEvent(tx, {
      userId: user.id,
      anonymousId: ctx.anonymousId,
      name: "feedback_item_unvoted",
      props: { itemId },
    });
    return updated;
  });
  return ok({ item: feedbackItemDTO(item, new Set()) });
}

async function userFeedbackVoteIds(userId: string | undefined, itemIds: string[]) {
  if (!userId || itemIds.length === 0) return new Set<string>();
  const votes = await prisma.productFeedbackVote.findMany({
    where: { userId, itemId: { in: itemIds } },
    select: { itemId: true },
  });
  return new Set(votes.map((vote) => vote.itemId));
}

function feedbackItemDTO(item: ProductFeedbackItemRow, votedIds: Set<string>) {
  return {
    id: item.id,
    sourceKey: item.sourceKey,
    title: item.title,
    description: item.description,
    category: item.category,
    status: item.status,
    voteCount: Math.max(0, item.voteCount),
    userVoted: votedIds.has(item.id),
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}

function supportTicketId() {
  // The identifier is intentionally random rather than time-derived: support
  // submissions in the same millisecond must still have independent authority.
  const random = `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`
    .replace(/[^a-z0-9]/giu, "")
    .slice(0, 10)
    .toUpperCase();
  return `SUP-${random}`;
}
