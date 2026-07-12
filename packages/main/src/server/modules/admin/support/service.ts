import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import {
  actorWithPermission,
  clampInt,
  jsonBody,
  writeAudit,
} from "@/server/modules/admin/shared/legacy-primitives";
import { synchronizeSupportCaseFromRequest } from "@/server/modules/admin-v2/cases/service";
import {
  decodeAdminListCursor,
  encodeAdminListCursor,
} from "@/server/modules/admin-v2/shared/list-cursor";

type PlaintextFields = Record<string, string | null>;

const supportRequestPatchSchema = z.object({
  status: z
    .enum(["received", "open", "waiting_on_user", "resolved", "closed"])
    .optional(),
  assignedToId: z.string().trim().min(1).max(160).nullable().optional(),
  priority: z.number().int().min(1).max(5).optional(),
  resolutionNotes: z.string().trim().max(2_000).nullable().optional(),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

const supportRequestEscalateSchema = z.object({
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

const plaintextViewSchema = z.object({
  targetType: z.enum(["generation_job", "media"]),
  targetId: z.string().trim().min(1).max(160),
  ticketId: z.string().trim().max(160).optional(),
  legalHoldId: z.string().trim().max(160).optional(),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

export async function listSupportRequests(request: Request) {
  await actorWithPermission(request, "support.request.read");
  const url = new URL(request.url);
  const ticketId = url.searchParams.get("ticketId")?.trim() || undefined;
  const userId = url.searchParams.get("userId")?.trim() || undefined;
  const assignedToId =
    url.searchParams.get("assignedToId")?.trim() || undefined;
  const category = url.searchParams.get("category")?.trim() || undefined;
  const search = url.searchParams.get("search")?.trim() || undefined;
  const sla = supportSlaStateFromUnknown(url.searchParams.get("sla"));
  const requestedStatuses = url.searchParams
    .get("status")
    ?.split(",")
    .map((status) => status.trim())
    .filter(Boolean);
  const statusFilter =
    requestedStatuses?.length && !requestedStatuses.includes("all")
      ? requestedStatuses.includes("active")
        ? { notIn: ["resolved", "closed"] }
        : { in: requestedStatuses }
      : undefined;
  const where: Prisma.SupportRequestWhereInput = {
    ticketId,
    userId,
    assignedToId,
    category,
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
            {
              user: {
                is: { email: { contains: search, mode: "insensitive" } },
              },
            },
            {
              assignedTo: {
                is: { email: { contains: search, mode: "insensitive" } },
              },
            },
          ],
        }
      : {}),
  };
  const limit = clampInt(url.searchParams.get("limit"), 1, 100, 25);
  const queryIdentity = {
    ticketId,
    userId,
    assignedToId,
    category,
    sla,
    statuses: requestedStatuses ?? [],
    search,
    sort: "priority_created_asc",
  };
  const cursorKeys = url.searchParams.get("cursor")
    ? decodeAdminListCursor(
        url.searchParams.get("cursor")!,
        "support_requests",
        queryIdentity,
      )
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
  const matches: Array<ReturnType<typeof supportRequestDTO>> = [];
  const rawByTicket = new Map<
    string,
    { priority: number; createdAt: Date; ticketId: string }
  >();
  const batchSize = 100;
  let exhausted = false;
  while (matches.length <= limit && !exhausted) {
    const items = await prisma.supportRequest.findMany({
      where: {
        AND: [
          where,
          ...(scanPriority !== null && scanAt && scanTicketId
            ? [
                {
                  OR: [
                    { priority: { gt: scanPriority } },
                    { priority: scanPriority, createdAt: { gt: scanAt } },
                    {
                      priority: scanPriority,
                      createdAt: scanAt,
                      ticketId: { gt: scanTicketId },
                    },
                  ],
                },
              ]
            : []),
        ],
      },
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
  return ok({
    items: page,
    pageInfo: {
      endCursor:
        hasNextPage && last
          ? encodeAdminListCursor("support_requests", queryIdentity, [
              last.priority,
              last.createdAt.toISOString(),
              last.ticketId,
            ])
          : null,
      hasNextPage,
    },
    asOf: new Date().toISOString(),
    freshness: "fresh",
  });
}

export async function patchSupportRequest(request: Request, ticketId: string) {
  const actor = await actorWithPermission(request, "support.request.write");
  const body = supportRequestPatchSchema.parse(await jsonBody(request));
  if (body.confirmation !== ticketId && body.confirmation !== "UPDATE") {
    throw Errors.badRequest(
      "Support request updates require ticket confirmation",
    );
  }
  const before = await prisma.supportRequest.findUnique({
    where: { ticketId },
  });
  if (!before) throw Errors.notFound("Support request not found");
  const terminal = body.status === "resolved" || body.status === "closed";
  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.supportRequest.update({
      where: { ticketId },
      data: {
        assignedToId:
          body.assignedToId === undefined ? undefined : body.assignedToId,
        priority: body.priority,
        resolutionNotes:
          body.resolutionNotes === undefined ? undefined : body.resolutionNotes,
        resolvedAt:
          body.status === undefined ? undefined : terminal ? new Date() : null,
        status: body.status,
      },
      include: supportRequestIncludes,
    });
    await synchronizeSupportCaseFromRequest(tx, row);
    return row;
  });
  await writeAudit(request, actor, {
    action: "support.request.update",
    targetType: "support_request",
    targetId: ticketId,
    reason: body.reason,
    before: {
      assignedToId: before.assignedToId,
      priority: before.priority,
      resolutionNotes: before.resolutionNotes,
      status: before.status,
    },
    after: {
      assignedToId: updated.assignedToId,
      priority: updated.priority,
      resolutionNotes: updated.resolutionNotes,
      status: updated.status,
    },
  });
  return ok({ request: supportRequestDTO(updated) });
}

export async function escalateSupportRequest(
  request: Request,
  ticketId: string,
) {
  const actor = await actorWithPermission(request, "support.request.write");
  const body = supportRequestEscalateSchema.parse(await jsonBody(request));
  if (body.confirmation !== ticketId && body.confirmation !== "ESCALATE") {
    throw Errors.badRequest("Support escalation requires ticket confirmation");
  }
  const before = await prisma.supportRequest.findUnique({
    where: { ticketId },
    include: supportRequestIncludes,
  });
  if (!before) throw Errors.notFound("Support request not found");
  if (before.status === "resolved" || before.status === "closed") {
    throw Errors.badRequest(
      "Resolved or closed support requests cannot be escalated",
    );
  }
  const beforeSla = supportRequestSla(before);
  if (beforeSla.state !== "overdue" && beforeSla.state !== "due_soon") {
    throw Errors.badRequest(
      "Only due-soon or overdue support requests can be escalated",
    );
  }
  const escalatedAt = new Date();
  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.supportRequest.update({
      where: { ticketId },
      data: {
        assignedToId: before.assignedToId ?? actor.id,
        priority: 1,
        slaEscalatedAt: escalatedAt,
        slaEscalatedById: actor.id,
        slaEscalationReason: body.reason,
        status: before.status === "received" ? "open" : before.status,
      },
      include: supportRequestIncludes,
    });
    await synchronizeSupportCaseFromRequest(tx, row);
    return row;
  });
  await writeAudit(request, actor, {
    action: "support.request.escalate",
    targetType: "support_request",
    targetId: ticketId,
    reason: body.reason,
    before: {
      assignedToId: before.assignedToId,
      priority: before.priority,
      slaEscalatedAt: before.slaEscalatedAt,
      slaState: beforeSla.state,
      status: before.status,
    },
    after: {
      assignedToId: updated.assignedToId,
      priority: updated.priority,
      slaEscalatedAt: updated.slaEscalatedAt,
      slaState: supportRequestSla(updated).state,
      status: updated.status,
    },
  });
  return ok({ request: supportRequestDTO(updated) });
}

export async function viewPlaintext(request: Request) {
  const actor = await actorWithPermission(request, "support.plaintext.view");
  const body = plaintextViewSchema.parse(await jsonBody(request));
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
    throw Errors.forbidden(
      "Plaintext view requires active support consent or legal hold",
    );
  }
  const plaintext = hold
    ? target.plaintext
    : plaintextAllowedByConsent(target.plaintext, grant?.scope);
  if (!Object.keys(plaintext).length) {
    throw Errors.forbidden(
      "Plaintext view grant does not authorize any plaintext fields",
    );
  }
  await writeAudit(request, actor, {
    action: "support.plaintext.view",
    targetType: body.targetType,
    targetId: body.targetId,
    reason: body.reason,
    after: {
      ticketId: grant?.ticketId ?? null,
      legalHoldId: hold?.id ?? null,
      viewedFields: Object.keys(plaintext),
    },
  });
  return ok({
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
  });
}

const supportRequestIncludes = {
  assignedTo: {
    select: { id: true, email: true, displayName: true, role: true },
  },
  user: { select: { id: true, email: true, displayName: true, role: true } },
} as const;

type SupportRequestRow = Prisma.SupportRequestGetPayload<{
  include: typeof supportRequestIncludes;
}>;
type SupportSlaState =
  | "all"
  | "overdue"
  | "due_soon"
  | "on_track"
  | "paused"
  | "closed";

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
    assignedToName:
      request.assignedTo?.displayName ?? request.assignedTo?.email ?? null,
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

const supportSlaHoursByPriority = new Map([
  [1, 4],
  [2, 12],
  [3, 24],
  [4, 48],
  [5, 72],
]);

function supportSlaStateFromUnknown(value: string | null): SupportSlaState {
  return ["overdue", "due_soon", "on_track", "paused", "closed"].includes(
    value ?? "",
  )
    ? (value as SupportSlaState)
    : "all";
}

function supportRequestSla(request: SupportRequestRow) {
  if (request.status === "resolved" || request.status === "closed") {
    return { dueAt: null, hoursRemaining: null, state: "closed" as const };
  }
  if (request.status === "waiting_on_user") {
    return { dueAt: null, hoursRemaining: null, state: "paused" as const };
  }
  const hours = supportSlaHoursByPriority.get(request.priority) ?? 24;
  const dueAt = new Date(request.createdAt.getTime() + hours * 60 * 60 * 1_000);
  const hoursRemaining = Math.ceil(
    (dueAt.getTime() - Date.now()) / (60 * 60 * 1_000),
  );
  const state =
    hoursRemaining < 0
      ? "overdue"
      : hoursRemaining <= 4
        ? "due_soon"
        : "on_track";
  return { dueAt, hoursRemaining, state };
}

async function plaintextTarget(
  targetType: "generation_job" | "media",
  targetId: string,
): Promise<{ ownerId: string; plaintext: PlaintextFields } | null> {
  if (targetType === "generation_job") {
    const job = await prisma.generationJob.findUnique({
      where: { id: targetId },
    });
    return job
      ? {
          ownerId: job.userId,
          plaintext: { prompt: job.prompt, negativePrompt: job.negativePrompt },
        }
      : null;
  }
  const media = await prisma.mediaAsset.findUnique({ where: { id: targetId } });
  return media
    ? { ownerId: media.ownerId, plaintext: { prompt: media.prompt } }
    : null;
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
  if (!scope || typeof scope !== "object" || Array.isArray(scope))
    return new Set<string>();
  const fields = (scope as Record<string, unknown>).fields;
  return new Set(
    Array.isArray(fields)
      ? fields.filter((field): field is string => typeof field === "string")
      : [],
  );
}
