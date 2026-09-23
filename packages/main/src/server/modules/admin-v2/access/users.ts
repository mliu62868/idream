import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import {
  applyOverrides,
  isPermissionKey,
  resolvePermissions,
} from "@/server/admin/permissions";
import type { ActorRole } from "@/server/lib/auth";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { dreamcoinBalance } from "@/server/modules/billing/ledger";
import { executeAtomicIdempotentMutation } from "@/server/modules/admin-v2/shared/atomic-mutation";
import {
  actorWithPermission,
  jsonBody,
  queryParams,
  type AdminActor,
} from "@/server/modules/admin-v2/shared/authority";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";
import {
  type AdminKeysetPaging,
  CREATED_AT_DESC_KEYS,
  paginateAdminKeyset,
} from "@/server/modules/admin-v2/shared/list-cursor";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";

/**
 * SPEC: 用户权威 —— 名录、明细、状态 / 角色 / 权限覆盖三条写命令。
 * INTENT: 与 `customers` 的 360 视图不是一回事：那边看的是「这个客户遇到了什么」，这边定的是
 *         「这个人能做什么」。两者的权限键（customer.read vs user.*）也不同，合并只会让一次
 *         客服查询顺带拿到改角色的入口。
 */

type UserCommandResult = Record<string, unknown>;

function userSummary(user: {
  id: string;
  email: string;
  displayName: string | null;
  name: string | null;
  role: string;
  status: string;
  createdAt: Date;
}) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName ?? user.name,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt.toISOString(),
  };
}

function permissionOverrideDto(override: {
  id: string;
  userId: string;
  permissionKey: string;
  effect: string;
  reason: string;
  createdById: string;
  createdAt: Date;
}) {
  return {
    id: override.id,
    userId: override.userId,
    permissionKey: override.permissionKey,
    effect: override.effect,
    reason: override.reason,
    createdById: override.createdById,
    createdAt: override.createdAt.toISOString(),
  };
}

async function runUserCommand(input: {
  request: Request;
  actor: AdminActor;
  commandType: string;
  userId: string;
  payload: unknown;
  execute: (
    tx: Prisma.TransactionClient,
    requestId: string,
  ) => Promise<UserCommandResult>;
}) {
  const requestId = input.request.headers.get("x-request-id")?.trim() || randomUUID();
  return executeAtomicIdempotentMutation({
    environment: env.APP_ENV,
    actor: input.actor,
    idempotencyKey: requireIdempotencyKey(input.request),
    requestId,
    commandType: input.commandType,
    target: { type: "user", id: input.userId },
    payload: input.payload,
    mutate: (tx) => input.execute(tx, requestId),
    decorateResult: (result, replayed) => ({
      ...(result as UserCommandResult),
      replayed,
    }),
  });
}

export async function listUsers(request: Request) {
  await actorWithPermission(request, "user.read");
  const query = queryParams(request, "GET /api/v2/admin/users");
  const q = query.q ?? query.search;
  const limit = query.limit ?? 40;
  const queryIdentity = {
    q,
    role: query.role,
    status: query.status,
    dataClass: query.dataClass,
  };
  const where: Prisma.UserWhereInput = {
    role: query.role,
    status: query.status,
    dataClass: query.dataClass,
    OR: q
      ? [
          { id: { contains: q } },
          { email: { contains: q } },
          { displayName: { contains: q } },
        ]
      : undefined,
  };
  const { items: page, pageInfo } = await paginateAdminKeyset({
    scope: "admin_users",
    queryIdentity,
    cursor: query.cursor,
    before: query.before,
    limit,
    keys: CREATED_AT_DESC_KEYS,
    fetch: (paging: AdminKeysetPaging<Prisma.UserOrderByWithRelationInput>) =>
      prisma.user.findMany({
        where: { AND: [where, ...paging.cursorWhere] },
        include: {
          subscriptions: {
            include: { plan: true },
            orderBy: { createdAt: "desc" },
            take: 1,
          },
        },
        orderBy: paging.orderBy,
        take: paging.take,
      }),
    count: () => prisma.user.count({ where }),
  });
  const items = await Promise.all(
    page.map(async (user) => ({
      id: user.id,
      email: user.email,
      displayName: user.displayName ?? user.name,
      role: user.role,
      status: user.status,
      dataClass: user.dataClass,
      createdAt: user.createdAt.toISOString(),
      plan: user.subscriptions[0]?.plan
        ? {
            slug: user.subscriptions[0].plan.slug,
            billingPeriod: user.subscriptions[0].plan.billingPeriod,
            status: user.subscriptions[0].status,
          }
        : null,
      dreamcoins: await dreamcoinBalance(user.id),
    })),
  );

  return { items, pageInfo };
}

export async function getUserDetail(request: Request, userId: string) {
  await actorWithPermission(request, "user.read");
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      preferences: true,
      subscriptions: {
        include: { plan: true },
        orderBy: { createdAt: "desc" },
        take: 5,
      },
      entitlements: { orderBy: { createdAt: "desc" } },
      ledgerEntries: { orderBy: { createdAt: "desc" }, take: 25 },
      ageVerifications: { orderBy: { createdAt: "desc" }, take: 3 },
      generationJobs: { orderBy: { createdAt: "desc" }, take: 8 },
    },
  });
  if (!user) throw Errors.notFound("User not found");
  const ageVerification = user.ageVerifications[0] ?? null;

  return {
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName ?? user.name,
      role: user.role,
      status: user.status,
      dataClass: user.dataClass,
      createdAt: user.createdAt.toISOString(),
      ageVerification: ageVerification
        ? {
            id: ageVerification.id,
            provider: ageVerification.provider,
            status: ageVerification.status,
            jurisdiction: ageVerification.jurisdiction,
            requiredReason: ageVerification.requiredReason,
            verifiedAt: ageVerification.verifiedAt?.toISOString() ?? null,
            expiresAt: ageVerification.expiresAt?.toISOString() ?? null,
            createdAt: ageVerification.createdAt.toISOString(),
          }
        : null,
      preferences: user.preferences
        ? {
            userId: user.preferences.userId,
            mutedTags: user.preferences.mutedTags,
            safeModeFlags: user.preferences.safeModeFlags,
            notificationSettings: user.preferences.notificationSettings,
            locale: user.preferences.locale,
            updatedAt: user.preferences.updatedAt.toISOString(),
          }
        : null,
    },
    subscriptions: user.subscriptions.map((subscription) => ({
      id: subscription.id,
      provider: subscription.provider,
      status: subscription.status,
      planSlug: subscription.plan.slug,
      planName: subscription.plan.name,
      billingPeriod: subscription.plan.billingPeriod,
      currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      createdAt: subscription.createdAt.toISOString(),
    })),
    entitlements: user.entitlements.map((entitlement) => ({
      id: entitlement.id,
      key: entitlement.key,
      value: entitlement.value,
      source: entitlement.source,
      expiresAt: entitlement.expiresAt?.toISOString() ?? null,
      createdAt: entitlement.createdAt.toISOString(),
    })),
    ledger: user.ledgerEntries.map((entry) => ({
      id: entry.id,
      delta: entry.delta,
      balanceAfter: entry.balanceAfter,
      reason: entry.reason,
      sourceId: entry.sourceId,
      createdAt: entry.createdAt.toISOString(),
    })),
    dreamcoins: { balance: await dreamcoinBalance(user.id) },
    generationJobs: user.generationJobs.map((job) => ({
      id: job.id,
      mode: job.mode,
      model: job.model,
      status: job.status,
      provider: job.provider,
      errorCode: job.errorCode,
      outputCount: job.outputCount,
      costDreamcoins: job.costDreamcoins,
      promptHidden: Boolean(job.prompt),
      negativePromptHidden: Boolean(job.negativePrompt),
      createdAt: job.createdAt.toISOString(),
      completedAt: job.completedAt?.toISOString() ?? null,
    })),
  };
}

// SPEC: 后台不能把自己锁在门外。
// INVARIANT: 管理员不能改自己的状态/角色；任何写入之后至少还剩一个 active admin。
//   否则一次误操作或一个被盗账号就能锁死整个后台，只能直接改库恢复。
async function assertKeepsAdminAccess(
  tx: Prisma.TransactionClient,
  actorId: string,
  target: { id: string; role: string; status: string },
  next: { role: string; status: string },
) {
  if (target.id === actorId) {
    throw Errors.conflict("You cannot change your own status or role");
  }
  const losesAdmin = target.role === "admin" && target.status === "active"
    && (next.role !== "admin" || next.status !== "active");
  if (!losesAdmin) return;
  // 锁住全部 active admin 行，两个管理员同时互相降级时第二个会看到第一个的结果。
  await tx.$queryRaw`SELECT "id" FROM "users" WHERE "role" = 'admin' AND "status" = 'active' AND "deletedAt" IS NULL FOR UPDATE`;
  const others = await tx.user.count({
    where: { role: "admin", status: "active", deletedAt: null, id: { not: target.id } },
  });
  if (others === 0) throw Errors.conflict("At least one active admin must remain");
}

export async function updateUserStatus(request: Request, userId: string) {
  const actor = await actorWithPermission(request, "user.status.write");
  const body = await jsonBody(request, "POST /api/v2/admin/users/:id/status");
  if (body.confirmation !== `${userId}:${body.status}`) {
    throw Errors.badRequest("Confirmation did not match user status target");
  }
  return runUserCommand({
    request,
    actor,
    commandType: "user.status.write",
    userId,
    payload: body,
    execute: async (tx, requestId) => {
      // INVARIANT: deletion and status changes serialize on the User row. A
      // plain read followed by update can otherwise observe active, wait for a
      // concurrent deletion to commit, and then revive the deleted account.
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "users" WHERE "id" = ${userId} FOR UPDATE`,
      );
      const before = await tx.user.findUnique({ where: { id: userId } });
      if (!before) throw Errors.notFound("User not found");
      // INVARIANT: deletion is a cross-service lifecycle; this narrow status command cannot revive or rewrite it.
      if (before.status === "deleted" || before.deletedAt) {
        throw Errors.conflict("Deleted users are controlled by account deletion authority");
      }
      await assertKeepsAdminAccess(tx, actor.id, before, { role: before.role, status: body.status });
      const updated = await tx.user.update({
        where: { id: userId },
        data: { status: body.status, deletedAt: body.status === "active" ? null : undefined },
      });
      await tx.adminAuditLog.create({ data: {
        actorId: actor.id,
        actorRole: actor.role,
        action: "user.status.write",
        targetType: "user",
        targetId: userId,
        reason: body.reason,
        before: { status: before.status },
        after: { status: updated.status },
        requestId,
      } });
      await tx.mainOutboxEvent.create({ data: {
        eventType: "admin.user.status_changed.v2",
        aggregateType: "user",
        aggregateId: userId,
        payload: { userId, from: before.status, to: updated.status, actorId: actor.id, requestId },
      } });
      return { user: userSummary(updated) };
    },
  });
}

export async function updateUserRole(request: Request, userId: string) {
  const actor = await actorWithPermission(request, "user.role.write");
  const body = await jsonBody(request, "POST /api/v2/admin/users/:id/role");
  if (body.confirmation !== `${userId}:${body.role}`) {
    throw Errors.badRequest("Confirmation did not match role-change target");
  }
  return runUserCommand({
    request,
    actor,
    commandType: "user.role.write",
    userId,
    payload: body,
    execute: async (tx, requestId) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "users" WHERE "id" = ${userId} FOR UPDATE`,
      );
      const before = await tx.user.findUnique({ where: { id: userId } });
      if (!before) throw Errors.notFound("User not found");
      await assertKeepsAdminAccess(tx, actor.id, before, { role: body.role, status: before.status });
      const updated = await tx.user.update({ where: { id: userId }, data: { role: body.role } });
      await tx.adminAuditLog.create({ data: {
        actorId: actor.id,
        actorRole: actor.role,
        action: "user.role.write",
        targetType: "user",
        targetId: userId,
        reason: body.reason,
        before: { role: before.role },
        after: { role: updated.role },
        requestId,
      } });
      await tx.mainOutboxEvent.create({ data: {
        eventType: "admin.user.role_changed.v2",
        aggregateType: "user",
        aggregateId: userId,
        payload: { userId, from: before.role, to: updated.role, actorId: actor.id, requestId },
      } });
      return { user: userSummary(updated) };
    },
  });
}

export async function listUserPermissions(request: Request, userId: string) {
  await actorWithPermission(request, "user.role.write");
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw Errors.notFound("User not found");
  const overrides = await prisma.adminUserPermission.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
  return {
    role: user.role,
    overrides: overrides.map(permissionOverrideDto),
    effective: [...applyOverrides(resolvePermissions(user.role as ActorRole), overrides)].sort(),
  };
}

export async function setUserPermission(request: Request, userId: string) {
  const actor = await actorWithPermission(request, "user.role.write");
  const body = await jsonBody(request, "POST /api/v2/admin/users/:id/permissions");
  if (body.confirmation !== `${userId}:${body.permissionKey}:${body.effect}`) {
    throw Errors.badRequest("Confirmation did not match permission-override target");
  }
  if (body.effect !== "clear" && !isPermissionKey(body.permissionKey)) {
    throw Errors.badRequest("Unknown permission key");
  }
  return runUserCommand({
    request,
    actor,
    commandType: "admin.permission.write",
    userId,
    payload: body,
    execute: async (tx, requestId) => {
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) throw Errors.notFound("User not found");
      const before = await tx.adminUserPermission.findFirst({
        where: { userId, permissionKey: body.permissionKey },
      });
      await tx.adminUserPermission.deleteMany({ where: { userId, permissionKey: body.permissionKey } });
      const updated = body.effect === "clear"
        ? null
        : await tx.adminUserPermission.create({ data: {
            userId,
            permissionKey: body.permissionKey,
            effect: body.effect,
            reason: body.reason,
            createdById: actor.id,
          } });
      await tx.adminAuditLog.create({ data: {
        actorId: actor.id,
        actorRole: actor.role,
        action: `admin.permission.${body.effect}`,
        targetType: "user",
        targetId: userId,
        reason: body.reason,
        before: before ? toInputJson({ permissionKey: before.permissionKey, effect: before.effect }) : undefined,
        after: toInputJson({ permissionKey: body.permissionKey, effect: body.effect }),
        requestId,
      } });
      await tx.mainOutboxEvent.create({ data: {
        eventType: "admin.user.permission_changed.v2",
        aggregateType: "user",
        aggregateId: userId,
        payload: { userId, permissionKey: body.permissionKey, effect: body.effect, actorId: actor.id, requestId },
      } });
      return {
        override: updated ? permissionOverrideDto(updated) : null,
        cleared: body.effect === "clear",
      };
    },
  });
}
