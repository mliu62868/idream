import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { operationalSupportRequestWhere } from "@/server/modules/metric-data-scope";
import { synchronizeSupportCaseFromRequest } from "@/server/modules/admin-v2/cases/service";
import { executeAtomicIdempotentMutation } from "@/server/modules/admin-v2/shared/atomic-mutation";
import {
  actorWithPermission,
  jsonBody,
  queryParams,
  type AdminActor,
} from "@/server/modules/admin-v2/shared/authority";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";
import {
  decodeAdminListCursor,
  encodeAdminListCursor,
} from "@/server/modules/admin-v2/shared/list-cursor";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";

type PlaintextFields = Record<string, string | null>;

const supportRequestIncludes = {
  assignedTo: {
    select: { id: true, email: true, displayName: true, role: true },
  },
  user: { select: { id: true, email: true, displayName: true, role: true } },
} as const;

type SupportRequestRow = Prisma.SupportRequestGetPayload<{
  include: typeof supportRequestIncludes;
}>;
type SupportSlaState = "all" | "overdue" | "due_soon" | "on_track" | "paused" | "closed";

const supportSlaHoursByPriority = new Map([
  [1, 4],
  [2, 12],
  [3, 24],
  [4, 48],
  [5, 72],
]);

function supportRequestSla(request: SupportRequestRow) {
  if (request.status === "resolved" || request.status === "closed") {
    return { dueAt: null, hoursRemaining: null, state: "closed" as const };
  }
  if (request.status === "waiting_on_user") {
    return { dueAt: null, hoursRemaining: null, state: "paused" as const };
  }
  const hours = supportSlaHoursByPriority.get(request.priority) ?? 24;
  const dueAt = new Date(request.createdAt.getTime() + hours * 60 * 60 * 1_000);
  const hoursRemaining = Math.ceil((dueAt.getTime() - Date.now()) / (60 * 60 * 1_000));
  const state = hoursRemaining < 0
    ? "overdue"
    : hoursRemaining <= 4
      ? "due_soon"
      : "on_track";
  return { dueAt, hoursRemaining, state };
}

function supportRequestDTO(request: SupportRequestRow) {
  const sla = supportRequestSla(request);
  return {
    id: request.id,
    ticketId: request.ticketId,
    userId: request.userId,
    userEmail: request.user.email,
    userName: request.user.displayName ?? request.user.email,
    category: request.category,
    subject: request.subject,
    description: request.description,
    diagnosticConsent: request.diagnosticConsent,
    sourcePath: request.sourcePath,
    status: request.status,
    priority: request.priority,
    assignedToId: request.assignedToId,
    assignedToEmail: request.assignedTo?.email ?? null,
    assignedToName: request.assignedTo?.displayName ?? request.assignedTo?.email ?? null,
    slaEscalatedAt: request.slaEscalatedAt?.toISOString() ?? null,
    slaEscalatedById: request.slaEscalatedById,
    slaEscalationReason: request.slaEscalationReason,
    resolutionNotes: request.resolutionNotes,
    resolvedAt: request.resolvedAt?.toISOString() ?? null,
    slaDueAt: sla.dueAt?.toISOString() ?? null,
    slaHoursRemaining: sla.hoursRemaining,
    slaState: sla.state,
    createdAt: request.createdAt.toISOString(),
    updatedAt: request.updatedAt.toISOString(),
  };
}

export async function listSupportRequests(request: Request) {
  await actorWithPermission(request, "support.request.read");
  const query = queryParams(request, "GET /api/v2/admin/support/requests");
  const sla = query.sla as SupportSlaState;
  const requestedStatuses = query.status
    ?.split(",")
    .map((status) => status.trim())
    .filter(Boolean);
  const statusFilter = requestedStatuses?.length && !requestedStatuses.includes("all")
    ? requestedStatuses.includes("active")
      ? { notIn: ["resolved", "closed"] }
      : { in: requestedStatuses }
    : undefined;
  const search = query.search;
  const where: Prisma.SupportRequestWhereInput = {
    ticketId: query.ticketId,
    userId: query.userId,
    assignedToId: query.assignedToId,
    category: query.category,
    status: statusFilter,
    ...(search
      ? {
          OR: [
            { ticketId: { contains: search, mode: "insensitive" } },
            { userId: { contains: search, mode: "insensitive" } },
            { subject: { contains: search, mode: "insensitive" } },
            { description: { contains: search, mode: "insensitive" } },
            { resolutionNotes: { contains: search, mode: "insensitive" } },
            { sourcePath: { contains: search, mode: "insensitive" } },
            { user: { is: { email: { contains: search, mode: "insensitive" } } } },
            { assignedTo: { is: { email: { contains: search, mode: "insensitive" } } } },
          ],
        }
      : {}),
  };
  const limit = query.limit;
  const queryIdentity = {
    ticketId: query.ticketId,
    userId: query.userId,
    assignedToId: query.assignedToId,
    category: query.category,
    sla,
    statuses: requestedStatuses ?? [],
    search,
    sort: "priority_created_asc",
  };
  const cursorKeys = query.cursor
    ? decodeAdminListCursor(query.cursor, "support_requests", queryIdentity)
    : null;
  let [scanPriority, scanAt, scanTicketId] = cursorKeys
    ? [
        z.number().int().parse(cursorKeys[0]),
        new Date(z.string().parse(cursorKeys[1])),
        z.string().min(1).parse(cursorKeys[2]),
      ]
    : [null, null, null];
  if (scanAt && Number.isNaN(scanAt.getTime())) {
    throw Errors.badRequest("support_requests cursor timestamp is invalid");
  }
  // SPEC: SLA 状态是按 now() 算出来的，落不进 SQL where。
  // INTENT: 所以按主键顺序批量扫、在内存里过滤，直到凑满一页或扫完 —— 这是唯一能让
  // 「按 SLA 筛」和「稳定游标」同时成立的做法。
  const matches: Array<ReturnType<typeof supportRequestDTO>> = [];
  const rawByTicket = new Map<string, { priority: number; createdAt: Date; ticketId: string }>();
  const batchSize = 100;
  let exhausted = false;
  while (matches.length <= limit && !exhausted) {
    const items = await prisma.supportRequest.findMany({
      where: operationalSupportRequestWhere({
        AND: [
          where,
          ...(scanPriority !== null && scanAt && scanTicketId
            ? [
                {
                  OR: [
                    { priority: { gt: scanPriority } },
                    { priority: scanPriority, createdAt: { gt: scanAt } },
                    { priority: scanPriority, createdAt: scanAt, ticketId: { gt: scanTicketId } },
                  ],
                },
              ]
            : []),
        ],
      }),
      include: supportRequestIncludes,
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }, { ticketId: "asc" }],
      take: batchSize,
    });
    if (!items.length) {
      exhausted = true;
      break;
    }
    for (const item of items) {
      const dto = supportRequestDTO(item);
      if (sla !== "all" && dto.slaState !== sla) continue;
      matches.push(dto);
      rawByTicket.set(item.ticketId, {
        priority: item.priority,
        createdAt: item.createdAt,
        ticketId: item.ticketId,
      });
    }
    const last = items.at(-1)!;
    scanPriority = last.priority;
    scanAt = last.createdAt;
    scanTicketId = last.ticketId;
    exhausted = items.length < batchSize;
  }
  const page = matches.slice(0, limit);
  const hasNextPage = matches.length > limit || !exhausted;
  const last = page.at(-1) ? rawByTicket.get(page.at(-1)!.ticketId) : null;
  return {
    items: page,
    pageInfo: {
      endCursor: hasNextPage && last
        ? encodeAdminListCursor("support_requests", queryIdentity, [
            last.priority,
            last.createdAt.toISOString(),
            last.ticketId,
          ])
        : null,
      hasNextPage,
    },
    asOf: new Date().toISOString(),
    freshness: "fresh" as const,
  };
}

async function runSupportCommand(input: {
  request: Request;
  actor: AdminActor;
  commandType: string;
  ticketId: string;
  payload: unknown;
  execute: (
    tx: Prisma.TransactionClient,
    requestId: string,
  ) => Promise<{ request: ReturnType<typeof supportRequestDTO> }>;
}) {
  const requestId = input.request.headers.get("x-request-id")?.trim() || randomUUID();
  return executeAtomicIdempotentMutation({
    environment: env.APP_ENV,
    actor: input.actor,
    idempotencyKey: requireIdempotencyKey(input.request),
    requestId,
    commandType: input.commandType,
    target: { type: "support_request", id: input.ticketId },
    payload: input.payload,
    mutate: (tx) => input.execute(tx, requestId),
    decorateResult: (result, replayed) => ({
      ...(result as Record<string, unknown>),
      replayed,
    }),
  });
}

export async function patchSupportRequest(request: Request, ticketId: string) {
  const actor = await actorWithPermission(request, "support.request.write");
  const body = await jsonBody(request, "PATCH /api/v2/admin/support/requests/:id");
  if (body.confirmation !== ticketId && body.confirmation !== "UPDATE") {
    throw Errors.badRequest("Support request updates require ticket confirmation");
  }
  const terminal = body.status === "resolved" || body.status === "closed";
  return runSupportCommand({
    request,
    actor,
    commandType: "support.request.update",
    ticketId,
    payload: body,
    execute: async (tx, requestId) => {
      const before = await tx.supportRequest.findUnique({ where: { ticketId } });
      if (!before) throw Errors.notFound("Support request not found");
      const updated = await tx.supportRequest.update({
        where: { ticketId },
        data: {
          assignedToId: body.assignedToId === undefined ? undefined : body.assignedToId,
          priority: body.priority,
          resolutionNotes: body.resolutionNotes === undefined ? undefined : body.resolutionNotes,
          resolvedAt: body.status === undefined ? undefined : terminal ? new Date() : null,
          status: body.status,
        },
        include: supportRequestIncludes,
      });
      await synchronizeSupportCaseFromRequest(tx, updated);
      await tx.adminAuditLog.create({ data: {
        actorId: actor.id,
        actorRole: actor.role,
        action: "support.request.update",
        targetType: "support_request",
        targetId: ticketId,
        reason: body.reason,
        before: toInputJson({
          assignedToId: before.assignedToId,
          priority: before.priority,
          resolutionNotes: before.resolutionNotes,
          status: before.status,
        }),
        after: toInputJson({
          assignedToId: updated.assignedToId,
          priority: updated.priority,
          resolutionNotes: updated.resolutionNotes,
          status: updated.status,
        }),
        requestId,
      } });
      return { request: supportRequestDTO(updated) };
    },
  });
}

export async function escalateSupportRequest(request: Request, ticketId: string) {
  const actor = await actorWithPermission(request, "support.request.write");
  const body = await jsonBody(request, "POST /api/v2/admin/support/requests/:id/escalate");
  if (body.confirmation !== ticketId && body.confirmation !== "ESCALATE") {
    throw Errors.badRequest("Support escalation requires ticket confirmation");
  }
  return runSupportCommand({
    request,
    actor,
    commandType: "support.request.escalate",
    ticketId,
    payload: body,
    execute: async (tx, requestId) => {
      const before = await tx.supportRequest.findUnique({
        where: { ticketId },
        include: supportRequestIncludes,
      });
      if (!before) throw Errors.notFound("Support request not found");
      if (before.status === "resolved" || before.status === "closed") {
        throw Errors.badRequest("Resolved or closed support requests cannot be escalated");
      }
      const beforeSla = supportRequestSla(before);
      if (beforeSla.state !== "overdue" && beforeSla.state !== "due_soon") {
        throw Errors.badRequest("Only due-soon or overdue support requests can be escalated");
      }
      const updated = await tx.supportRequest.update({
        where: { ticketId },
        data: {
          assignedToId: before.assignedToId ?? actor.id,
          priority: 1,
          slaEscalatedAt: new Date(),
          slaEscalatedById: actor.id,
          slaEscalationReason: body.reason,
          status: before.status === "received" ? "open" : before.status,
        },
        include: supportRequestIncludes,
      });
      await synchronizeSupportCaseFromRequest(tx, updated);
      await tx.adminAuditLog.create({ data: {
        actorId: actor.id,
        actorRole: actor.role,
        action: "support.request.escalate",
        targetType: "support_request",
        targetId: ticketId,
        reason: body.reason,
        before: toInputJson({
          assignedToId: before.assignedToId,
          priority: before.priority,
          slaEscalatedAt: before.slaEscalatedAt?.toISOString() ?? null,
          slaState: beforeSla.state,
          status: before.status,
        }),
        after: toInputJson({
          assignedToId: updated.assignedToId,
          priority: updated.priority,
          slaEscalatedAt: updated.slaEscalatedAt?.toISOString() ?? null,
          slaState: supportRequestSla(updated).state,
          status: updated.status,
        }),
        requestId,
      } });
      return { request: supportRequestDTO(updated) };
    },
  });
}

export async function viewPlaintext(request: Request) {
  const actor = await actorWithPermission(request, "support.plaintext.view");
  const body = await jsonBody(request, "POST /api/v2/admin/support/plaintext/view");
  if (body.confirmation !== body.targetId) {
    throw Errors.badRequest("Confirmation did not match plaintext target");
  }
  const target = await plaintextTarget(body.targetType, body.targetId);
  if (!target) throw Errors.notFound("Plaintext target not found");
  const grant = body.ticketId
    ? await prisma.supportConsentGrant.findFirst({
        where: {
          userId: target.ownerId,
          ticketId: body.ticketId,
          targetType: body.targetType,
          targetId: body.targetId,
          expiresAt: { gt: new Date() },
        },
      })
    : null;
  const hold = body.legalHoldId
    ? await prisma.legalHold.findFirst({
        where: {
          id: body.legalHoldId,
          targetType: body.targetType,
          targetId: body.targetId,
          status: "active",
        },
      })
    : null;
  if (!grant && !hold) {
    throw Errors.forbidden("Plaintext view requires active support consent or legal hold");
  }
  const plaintext = hold
    ? target.plaintext
    : plaintextAllowedByConsent(target.plaintext, grant?.scope);
  if (!Object.keys(plaintext).length) {
    throw Errors.forbidden("Plaintext view grant does not authorize any plaintext fields");
  }
  await prisma.adminAuditLog.create({ data: {
    actorId: actor.id,
    actorRole: actor.role,
    action: "support.plaintext.view",
    targetType: body.targetType,
    targetId: body.targetId,
    reason: body.reason,
    after: toInputJson({
      ticketId: grant?.ticketId ?? null,
      legalHoldId: hold?.id ?? null,
      viewedFields: Object.keys(plaintext),
    }),
    requestId: request.headers.get("x-request-id")?.trim() || randomUUID(),
  } });
  return {
    target: {
      type: body.targetType,
      id: body.targetId,
      ownerId: target.ownerId,
    },
    plaintext,
    authorization: {
      ticketId: grant?.ticketId ?? null,
      legalHoldId: hold?.id ?? null,
    },
  };
}

async function plaintextTarget(
  targetType: "generation_job" | "media",
  targetId: string,
): Promise<{ ownerId: string; plaintext: PlaintextFields } | null> {
  if (targetType === "generation_job") {
    const job = await prisma.generationJob.findUnique({ where: { id: targetId } });
    return job
      ? {
          ownerId: job.userId,
          plaintext: { prompt: job.prompt, negativePrompt: job.negativePrompt },
        }
      : null;
  }
  const media = await prisma.mediaAsset.findUnique({ where: { id: targetId } });
  return media ? { ownerId: media.ownerId, plaintext: { prompt: media.prompt } } : null;
}

function plaintextAllowedByConsent(
  plaintext: PlaintextFields,
  scope: Prisma.JsonValue | undefined,
) {
  const fields = consentScopeFields(scope);
  return Object.fromEntries(
    Object.entries(plaintext).filter(([field]) => fields.has(field)),
  );
}

function consentScopeFields(scope: Prisma.JsonValue | undefined) {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return new Set<string>();
  const fields = (scope as Record<string, unknown>).fields;
  return new Set(
    Array.isArray(fields)
      ? fields.filter((field): field is string => typeof field === "string")
      : [],
  );
}
