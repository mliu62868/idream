import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  applyOverrides,
  isPermissionKey,
  resolvePermissions,
} from "@/server/admin/permissions";
import type { ActorRole } from "@/server/lib/auth";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import { dreamcoinBalance } from "@/server/modules/admin/billing/ledger";
import {
  actorWithPermission,
  jsonBody,
  type AdminActor,
} from "@/server/modules/admin/shared/legacy-primitives";
import {
  publicUser,
  redactGenerationJob,
} from "@/server/modules/admin/shared/presenters";
import { canonicalRequestHash } from "@/server/modules/admin-v2/shared/control-plane-command";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import { decodeAdminListCursor, encodeAdminListCursor } from "@/server/modules/admin-v2/shared/list-cursor";

const statusChangeSchema = z.object({
  status: z.enum(["active", "suspended"]),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

const roleChangeSchema = z.object({
  role: z.enum(["user", "moderator", "support", "ops", "analyst", "admin"]),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

const permissionOverrideSchema = z.object({
  permissionKey: z.string().trim().min(1).max(80),
  effect: z.enum(["grant", "revoke", "clear"]),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

const userListQuerySchema = z.object({
  q: z.string().trim().min(1).max(200).optional(),
  search: z.string().trim().min(1).max(200).optional(),
  role: z.enum(["user", "moderator", "support", "ops", "analyst", "admin"]).optional(),
  status: z.enum(["active", "suspended", "deleted"]).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
}).strict();

type UserCommandInput = {
  request: Request;
  actor: AdminActor;
  commandType: string;
  targetId: string;
  payload: unknown;
  execute: (tx: Prisma.TransactionClient, requestId: string) => Promise<Record<string, unknown>>;
};

async function executeIdempotentUserCommand(input: UserCommandInput) {
  const idempotencyKey = requireIdempotencyKey(input.request);
  const requestId = input.request.headers.get("x-request-id")?.trim() || randomUUID();
  const scope = `${env.APP_ENV}:${input.actor.id}`;
  const requestHash = canonicalRequestHash({
    commandType: input.commandType,
    target: { type: "user", id: input.targetId },
    payload: input.payload,
    retryMode: "idempotent",
  });

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1::int AS locked FROM pg_advisory_xact_lock(hashtext(${`${scope}:${idempotencyKey}`}))`;
    const existing = await tx.controlPlaneCommand.findUnique({
      where: { scope_idempotencyKey: { scope, idempotencyKey } },
    });
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw Errors.conflict("Idempotency-Key was already used for a different user command", {
          commandId: existing.id,
          existingRequestHash: existing.requestHash,
          submittedRequestHash: requestHash,
        });
      }
      if (existing.status !== "succeeded" || !existing.result) {
        throw Errors.conflict("The original user command has not completed", {
          commandId: existing.id,
          status: existing.status,
        });
      }
      return { ...(existing.result as Record<string, unknown>), replayed: true };
    }

    const command = await tx.controlPlaneCommand.create({
      data: {
        scope,
        idempotencyKey,
        commandType: input.commandType,
        targetType: "user",
        targetId: input.targetId,
        actorId: input.actor.id,
        requestId,
        requestHash,
        requestPayload: toInputJson(input.payload),
        retryMode: "idempotent",
        status: "accepted",
      },
    });
    const result = { ...await input.execute(tx, requestId), replayed: false };
    await tx.controlPlaneCommand.update({
      where: { id: command.id },
      data: {
        status: "succeeded",
        result: toInputJson(result),
        finishedAt: new Date(),
      },
    });
    return result;
  });
}

export async function listUsers(request: Request) {
  await actorWithPermission(request, "user.read");
  const url = new URL(request.url);
  const query = userListQuerySchema.parse(Object.fromEntries(url.searchParams));
  const q = query.q ?? query.search;
  const limit = query.limit ?? 40;
  const queryIdentity = { q, role: query.role, status: query.status };
  const cursorKeys = query.cursor ? decodeAdminListCursor(query.cursor, "admin_users", queryIdentity) : null;
  const [cursorCreatedAt, cursorId] = cursorKeys
    ? z.tuple([z.string().datetime(), z.string().min(1)]).parse(cursorKeys)
    : [null, null];
  const cursorWhere: Prisma.UserWhereInput | undefined = cursorCreatedAt && cursorId ? {
    OR: [
      { createdAt: { lt: new Date(cursorCreatedAt) } },
      { createdAt: new Date(cursorCreatedAt), id: { lt: cursorId } },
    ],
  } : undefined;
  const users = await prisma.user.findMany({
    where: {
      role: query.role,
      status: query.status,
      OR: q ? [
            { id: { contains: q } },
            { email: { contains: q } },
            { displayName: { contains: q } },
          ] : undefined,
      AND: cursorWhere,
    },
    include: {
      subscriptions: {
        include: { plan: true },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const page = users.slice(0, limit);
  const items = await Promise.all(
    page.map(async (user) => ({
      id: user.id,
      email: user.email,
      displayName: user.displayName ?? user.name,
      role: user.role,
      status: user.status,
      createdAt: user.createdAt,
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

  const last = page.at(-1);
  return ok({
    items,
    pageInfo: {
      endCursor: users.length > limit && last
        ? encodeAdminListCursor("admin_users", queryIdentity, [last.createdAt.toISOString(), last.id])
        : null,
      hasNextPage: users.length > limit,
    },
  });
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

  return ok({
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName ?? user.name,
      role: user.role,
      status: user.status,
      createdAt: user.createdAt,
      ageVerification: user.ageVerifications[0] ?? null,
      preferences: user.preferences,
    },
    subscriptions: user.subscriptions,
    entitlements: user.entitlements,
    ledger: user.ledgerEntries,
    dreamcoins: { balance: await dreamcoinBalance(user.id) },
    generationJobs: user.generationJobs.map(redactGenerationJob),
  });
}

export async function updateUserStatus(request: Request, userId: string) {
  const actor = await actorWithPermission(request, "user.status.write");
  const body = statusChangeSchema.parse(await jsonBody(request));
  if (body.confirmation !== `${userId}:${body.status}`) {
    throw Errors.badRequest("Confirmation did not match user status target");
  }
  const result = await executeIdempotentUserCommand({
    request,
    actor,
    commandType: "user.status.write",
    targetId: userId,
    payload: body,
    execute: async (tx, requestId) => {
      const before = await tx.user.findUnique({ where: { id: userId } });
      if (!before) throw Errors.notFound("User not found");
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
      return { user: publicUser(updated) };
    },
  });
  return ok(result);
}

export async function updateUserRole(request: Request, userId: string) {
  const actor = await actorWithPermission(request, "user.role.write");
  const body = roleChangeSchema.parse(await jsonBody(request));
  if (body.confirmation !== `${userId}:${body.role}`) {
    throw Errors.badRequest("Confirmation did not match role-change target");
  }
  const result = await executeIdempotentUserCommand({
    request,
    actor,
    commandType: "user.role.write",
    targetId: userId,
    payload: body,
    execute: async (tx, requestId) => {
      const before = await tx.user.findUnique({ where: { id: userId } });
      if (!before) throw Errors.notFound("User not found");
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
      return { user: publicUser(updated) };
    },
  });
  return ok(result);
}

export async function listUserPermissions(request: Request, userId: string) {
  await actorWithPermission(request, "user.role.write");
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw Errors.notFound("User not found");
  const overrides = await prisma.adminUserPermission.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
  const effective = [...applyOverrides(resolvePermissions(user.role as ActorRole), overrides)].sort();
  return ok({ role: user.role, overrides, effective });
}

export async function setUserPermission(request: Request, userId: string) {
  const actor = await actorWithPermission(request, "user.role.write");
  const body = permissionOverrideSchema.parse(await jsonBody(request));
  if (body.confirmation !== `${userId}:${body.permissionKey}:${body.effect}`) {
    throw Errors.badRequest("Confirmation did not match permission-override target");
  }
  if (body.effect !== "clear" && !isPermissionKey(body.permissionKey)) {
    throw Errors.badRequest("Unknown permission key");
  }
  const result = await executeIdempotentUserCommand({
    request,
    actor,
    commandType: `admin.permission.${body.effect}`,
    targetId: userId,
    payload: body,
    execute: async (tx, requestId) => {
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) throw Errors.notFound("User not found");
      const before = await tx.adminUserPermission.findFirst({ where: { userId, permissionKey: body.permissionKey } });
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
      const action = body.effect === "grant"
        ? "admin.permission.grant"
        : body.effect === "revoke"
          ? "admin.permission.revoke"
          : "admin.permission.clear";
      await tx.adminAuditLog.create({ data: {
        actorId: actor.id,
        actorRole: actor.role,
        action,
        targetType: "user",
        targetId: userId,
        reason: body.reason,
        before: before ? { permissionKey: before.permissionKey, effect: before.effect } : undefined,
        after: { permissionKey: body.permissionKey, effect: body.effect },
        requestId,
      } });
      await tx.mainOutboxEvent.create({ data: {
        eventType: "admin.user.permission_changed.v2",
        aggregateType: "user",
        aggregateId: userId,
        payload: { userId, permissionKey: body.permissionKey, effect: body.effect, actorId: actor.id, requestId },
      } });
      return { override: updated, cleared: body.effect === "clear" };
    },
  });
  return ok(result);
}
