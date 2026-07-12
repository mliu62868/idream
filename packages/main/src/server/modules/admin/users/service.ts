import { z } from "zod";
import {
  applyOverrides,
  isPermissionKey,
  resolvePermissions,
} from "@/server/admin/permissions";
import type { ActorRole } from "@/server/lib/auth";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import { dreamcoinBalance } from "@/server/modules/admin/billing/ledger";
import {
  actorWithPermission,
  clampInt,
  jsonBody,
} from "@/server/modules/admin/shared/legacy-primitives";
import {
  publicUser,
  redactGenerationJob,
} from "@/server/modules/admin/shared/presenters";

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

export async function listUsers(request: Request) {
  await actorWithPermission(request, "user.read");
  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim();
  const users = await prisma.user.findMany({
    where: q
      ? {
          OR: [
            { id: { contains: q } },
            { email: { contains: q } },
            { displayName: { contains: q } },
          ],
        }
      : undefined,
    include: {
      subscriptions: {
        include: { plan: true },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
    orderBy: { createdAt: "desc" },
    take: clampInt(url.searchParams.get("limit"), 1, 100, 40),
  });
  const items = await Promise.all(
    users.map(async (user) => ({
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

  return ok({ items });
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
  const after = await prisma.$transaction(async (tx) => {
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
      requestId: request.headers.get("x-request-id"),
    } });
    await tx.mainOutboxEvent.create({ data: {
      eventType: "admin.user.status_changed.v2",
      aggregateType: "user",
      aggregateId: userId,
      payload: { userId, from: before.status, to: updated.status, actorId: actor.id },
    } });
    return updated;
  });
  return ok({ user: publicUser(after) });
}

export async function updateUserRole(request: Request, userId: string) {
  const actor = await actorWithPermission(request, "user.role.write");
  const body = roleChangeSchema.parse(await jsonBody(request));
  if (body.confirmation !== `${userId}:${body.role}`) {
    throw Errors.badRequest("Confirmation did not match role-change target");
  }
  const after = await prisma.$transaction(async (tx) => {
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
      requestId: request.headers.get("x-request-id"),
    } });
    await tx.mainOutboxEvent.create({ data: {
      eventType: "admin.user.role_changed.v2",
      aggregateType: "user",
      aggregateId: userId,
      payload: { userId, from: before.role, to: updated.role, actorId: actor.id },
    } });
    return updated;
  });
  return ok({ user: publicUser(after) });
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
  const override = await prisma.$transaction(async (tx) => {
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
      requestId: request.headers.get("x-request-id"),
    } });
    await tx.mainOutboxEvent.create({ data: {
      eventType: "admin.user.permission_changed.v2",
      aggregateType: "user",
      aggregateId: userId,
      payload: { userId, permissionKey: body.permissionKey, effect: body.effect, actorId: actor.id },
    } });
    return updated;
  });
  return ok({ override, cleared: body.effect === "clear" });
}
