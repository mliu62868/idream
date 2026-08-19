import type { Prisma } from "@prisma/client";
import type {
  approvalListResponseSchema,
  approvalMutationResponseSchema,
} from "@idream/shared/admin/contracts";
import type { z } from "zod";
import { effectivePermissions } from "@/server/admin/effective-permissions";
import { isPermissionKey } from "@/server/admin/permissions";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { writeAudit } from "@/server/modules/admin/shared/legacy-primitives";
import {
  actorWithPermission,
  jsonBody,
  queryParams,
  type AdminActor,
  type AdminV2RequestBody,
} from "@/server/modules/admin-v2/shared/authority";
import {
  type AdminKeysetPaging,
  CREATED_AT_DESC_KEYS,
  paginateAdminKeyset,
} from "@/server/modules/admin-v2/shared/list-cursor";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";

/**
 * SPEC: 双人审批 —— 高风险动作先落一条请求，再由**另一个**同样持有该权限的人批准。
 * INTENT: 三条门槛都在服务端：请求方必须自己就持有要申请的那把钥匙（否则等于绕过授权），
 *         审批方不能是请求方，已裁决的请求不可再裁决。凭据一次性，消费在 enforcement.ts。
 */

type ApprovalListResponse = z.infer<typeof approvalListResponseSchema>;
type ApprovalMutationResponse = z.infer<typeof approvalMutationResponseSchema>;
type ApprovalCreateBody = AdminV2RequestBody<"approvalCreateRequestSchema">;
type ApprovalDecisionBody = AdminV2RequestBody<"approvalDecisionRequestSchema">;

type ApprovalRow = {
  id: string;
  requestedById: string;
  approvedById: string | null;
  permissionKey: string;
  action: string;
  targetType: string;
  targetId: string;
  payload: Prisma.JsonValue;
  status: string;
  reason: string | null;
  createdAt: Date;
  decidedAt: Date | null;
};

function serializeApproval(row: ApprovalRow): ApprovalMutationResponse["request"] {
  return {
    id: row.id,
    requestedById: row.requestedById,
    approvedById: row.approvedById,
    permissionKey: row.permissionKey,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    payload: row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
      ? row.payload as Record<string, unknown>
      : {},
    status: row.status,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
  };
}

export async function listApprovals(request: Request): Promise<ApprovalListResponse> {
  await actorWithPermission(request, "admin.approval.review");
  const { search, status, limit, cursor, before } = queryParams(request, "GET /api/v2/admin/approvals");
  const queryIdentity = { search, status };
  const where: Prisma.AdminActionRequestWhereInput = {
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
  };
  const { items, pageInfo } = await paginateAdminKeyset({
    scope: "approvals",
    queryIdentity,
    cursor,
    before,
    limit,
    keys: CREATED_AT_DESC_KEYS,
    fetch: (paging: AdminKeysetPaging<Prisma.AdminActionRequestOrderByWithRelationInput>) =>
      prisma.adminActionRequest.findMany({
        where: { AND: [where, ...paging.cursorWhere] },
        orderBy: paging.orderBy,
        take: paging.take,
      }),
    count: () => prisma.adminActionRequest.count({ where }),
  });
  return { items: items.map(serializeApproval), pageInfo };
}

export async function createApproval(request: Request): Promise<ApprovalMutationResponse> {
  // INVARIANT: 静态门槛只是「进得了运营台」；真正的门槛是下面那条 —— 你不能替自己申请
  // 一把你本来就没有的钥匙。
  const actor: AdminActor = await actorWithPermission(request, "dashboard.read");
  const body = await jsonBody(request, "approvalCreateRequestSchema") as ApprovalCreateBody;
  if (body.confirmation !== `${body.targetId}:${body.action}`) {
    throw Errors.badRequest("Confirmation did not match approval target");
  }
  if (!isPermissionKey(body.permissionKey)) {
    throw Errors.badRequest("Unknown permission key");
  }
  const permissions = await effectivePermissions(actor.id, actor.role);
  if (!permissions.has(body.permissionKey)) {
    throw Errors.forbidden("Cannot request an action you lack permission for", {
      permission: body.permissionKey,
    });
  }
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
  return { request: serializeApproval(created) };
}

export async function approveApproval(
  request: Request,
  id: string,
): Promise<ApprovalMutationResponse> {
  const actor = await actorWithPermission(request, "admin.approval.review");
  const body = await jsonBody(request, "approvalDecisionRequestSchema") as ApprovalDecisionBody;
  const approval = await prisma.adminActionRequest.findUnique({ where: { id } });
  if (!approval) throw Errors.notFound("Approval request not found");
  assertConfirmation(body.confirmation, approval.id);
  if (approval.status !== "pending") {
    throw Errors.badRequest("Approval request is not pending");
  }
  if (approval.requestedById === actor.id) {
    throw Errors.badRequest("Approver must differ from requester");
  }
  if (!isPermissionKey(approval.permissionKey)) {
    throw Errors.badRequest("Request has an unknown permission key");
  }
  const permissions = await effectivePermissions(actor.id, actor.role);
  if (!permissions.has(approval.permissionKey)) {
    throw Errors.forbidden(
      "Approver lacks the permission required by this request",
      { permission: approval.permissionKey },
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
  return { request: serializeApproval(updated) };
}

export async function rejectApproval(
  request: Request,
  id: string,
): Promise<ApprovalMutationResponse> {
  const actor = await actorWithPermission(request, "admin.approval.review");
  const body = await jsonBody(request, "approvalDecisionRequestSchema") as ApprovalDecisionBody;
  const approval = await prisma.adminActionRequest.findUnique({ where: { id } });
  if (!approval) throw Errors.notFound("Approval request not found");
  assertConfirmation(body.confirmation, approval.id);
  if (approval.status !== "pending") {
    throw Errors.badRequest("Approval request is not pending");
  }
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
  return { request: serializeApproval(updated) };
}

function assertConfirmation(value: string, target: string) {
  if (value !== target) throw Errors.badRequest("Confirmation did not match target");
}
