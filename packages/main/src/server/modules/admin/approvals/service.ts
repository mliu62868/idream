import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { effectivePermissions } from "@/server/admin/effective-permissions";
import { isPermissionKey } from "@/server/admin/permissions";
import { getAuthCtx, requireUser } from "@/server/lib/auth";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import {
  actorWithPermission,
  clampInt,
  jsonBody,
  toInputJson,
  writeAudit,
  type AdminActor,
} from "@/server/modules/admin/shared/legacy-primitives";
import {
  decodeAdminListCursor,
  encodeAdminListCursor,
} from "@/server/modules/admin-v2/shared/list-cursor";

const approvalCreateSchema = z.object({
  permissionKey: z.string().trim().min(1).max(80),
  action: z.string().trim().min(1).max(120),
  targetType: z.string().trim().min(1).max(80),
  targetId: z.string().trim().min(1).max(160),
  payload: z.record(z.string(), z.unknown()).default({}),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

const approvalDecisionSchema = z.object({
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

export async function listApprovals(request: Request) {
  await actorWithPermission(request, "admin.approval.review");
  const url = new URL(request.url);
  const search = url.searchParams.get("search")?.trim() || undefined;
  const status = url.searchParams.get("status") ?? "pending";
  const limit = clampInt(url.searchParams.get("limit"), 1, 100, 100);
  const queryIdentity = { search, status };
  const cursorKeys = url.searchParams.get("cursor")
    ? decodeAdminListCursor(
        url.searchParams.get("cursor")!,
        "approvals",
        queryIdentity,
      )
    : undefined;
  const cursorWhere: Prisma.AdminActionRequestWhereInput | undefined =
    cursorKeys
      ? (() => {
          const createdAt = cursorDate(cursorKeys, 0);
          const id = cursorString(cursorKeys, 1);
          return {
            OR: [
              { createdAt: { lt: createdAt } },
              { createdAt, id: { lt: id } },
            ],
          };
        })()
      : undefined;
  const rows = await prisma.adminActionRequest.findMany({
    where: {
      status,
      OR: search
        ? [
            { id: { contains: search } },
            { action: { contains: search } },
            { permissionKey: { contains: search } },
            { targetId: { contains: search } },
            { requestedById: { contains: search } },
          ]
        : undefined,
      AND: cursorWhere,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return ok({
    items: page,
    pageInfo: {
      endCursor:
        rows.length > limit && last
          ? encodeAdminListCursor("approvals", queryIdentity, [
              last.createdAt.toISOString(),
              last.id,
            ])
          : null,
      hasNextPage: rows.length > limit,
    },
  });
}

export async function createApproval(request: Request) {
  const context = await getAuthCtx(request);
  const user = requireUser(context);
  const body = approvalCreateSchema.parse(await jsonBody(request));
  if (body.confirmation !== `${body.targetId}:${body.action}`) {
    throw Errors.badRequest("Confirmation did not match approval target");
  }
  if (!isPermissionKey(body.permissionKey))
    throw Errors.badRequest("Unknown permission key");
  const permissions = await effectivePermissions(user.id, user.role);
  if (!permissions.has(body.permissionKey)) {
    throw Errors.forbidden("Cannot request an action you lack permission for", {
      permission: body.permissionKey,
    });
  }
  const actor: AdminActor = { id: user.id, role: user.role };
  const created = await prisma.adminActionRequest.create({
    data: {
      requestedById: actor.id,
      permissionKey: body.permissionKey,
      action: body.action,
      targetType: body.targetType,
      targetId: body.targetId,
      payload: toInputJson(body.payload),
      status: "pending",
      reason: body.reason,
    },
  });
  await writeAudit(request, actor, {
    action: "admin.approval.request",
    targetType: body.targetType,
    targetId: body.targetId,
    reason: body.reason,
    after: {
      requestId: created.id,
      permissionKey: body.permissionKey,
      action: body.action,
    },
  });
  return ok({ request: created });
}

export async function approveApproval(request: Request, id: string) {
  const actor = await actorWithPermission(request, "admin.approval.review");
  const body = approvalDecisionSchema.parse(await jsonBody(request));
  const approval = await prisma.adminActionRequest.findUnique({
    where: { id },
  });
  if (!approval) throw Errors.notFound("Approval request not found");
  assertConfirmation(body.confirmation, approval.id);
  if (approval.status !== "pending")
    throw Errors.badRequest("Approval request is not pending");
  if (approval.requestedById === actor.id)
    throw Errors.badRequest("Approver must differ from requester");
  if (!isPermissionKey(approval.permissionKey))
    throw Errors.badRequest("Request has an unknown permission key");
  const permissions = await effectivePermissions(actor.id, actor.role);
  if (!permissions.has(approval.permissionKey)) {
    throw Errors.forbidden(
      "Approver lacks the permission required by this request",
      {
        permission: approval.permissionKey,
      },
    );
  }
  const updated = await prisma.adminActionRequest.update({
    where: { id },
    data: { status: "approved", approvedById: actor.id, decidedAt: new Date() },
  });
  await writeAudit(request, actor, {
    action: "admin.approval.approve",
    targetType: approval.targetType,
    targetId: approval.targetId,
    reason: body.reason,
    before: { status: "pending" },
    after: {
      status: "approved",
      requestId: updated.id,
      permissionKey: approval.permissionKey,
    },
  });
  return ok({ request: updated });
}

export async function rejectApproval(request: Request, id: string) {
  const actor = await actorWithPermission(request, "admin.approval.review");
  const body = approvalDecisionSchema.parse(await jsonBody(request));
  const approval = await prisma.adminActionRequest.findUnique({
    where: { id },
  });
  if (!approval) throw Errors.notFound("Approval request not found");
  assertConfirmation(body.confirmation, approval.id);
  if (approval.status !== "pending")
    throw Errors.badRequest("Approval request is not pending");
  const updated = await prisma.adminActionRequest.update({
    where: { id },
    data: { status: "rejected", approvedById: actor.id, decidedAt: new Date() },
  });
  await writeAudit(request, actor, {
    action: "admin.approval.reject",
    targetType: approval.targetType,
    targetId: approval.targetId,
    reason: body.reason,
    before: { status: "pending" },
    after: { status: "rejected", requestId: updated.id },
  });
  return ok({ request: updated });
}

function assertConfirmation(value: string, target: string) {
  if (value !== target)
    throw Errors.badRequest("Confirmation did not match target");
}

function cursorString(keys: readonly unknown[], index: number) {
  const value = keys[index];
  if (typeof value !== "string" || !value)
    throw Errors.badRequest("approvals cursor key is invalid");
  return value;
}

function cursorDate(keys: readonly unknown[], index: number) {
  const value = new Date(cursorString(keys, index));
  if (Number.isNaN(value.getTime()))
    throw Errors.badRequest("approvals cursor timestamp is invalid");
  return value;
}
