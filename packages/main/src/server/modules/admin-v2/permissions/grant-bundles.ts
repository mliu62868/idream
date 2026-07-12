import type { AdminUserGrantBundle, Prisma } from "@prisma/client";
import {
  ADMIN_GRANT_BUNDLES,
  adminGrantBundleKeySchema,
  adminGrantBundleListSchema,
  adminGrantBundleMutationSchema,
  type AdminGrantBundle,
  type AdminGrantBundleKey,
  type AdminGrantBundleRevoke,
  type AdminGrantBundleWrite,
} from "@idream/shared/admin";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { actorWithPermission, type AdminActor } from "@/server/modules/admin-v2/shared/authority";
import { toInputJson } from "../shared/prisma-json";

function assertBundleScope(bundleKey: AdminGrantBundleKey, scope: { readonly characterIds: readonly string[] } | undefined) {
  if (bundleKey === "character_producer" && (!scope || scope.characterIds.length === 0)) {
    throw Errors.badRequest("Character producer grants require at least one assigned Character");
  }
  if (bundleKey !== "character_producer" && scope?.characterIds.length) {
    throw Errors.badRequest("This grant bundle does not accept Character scope");
  }
}

function scopeOf(value: Prisma.JsonValue | null): { characterIds: string[] } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const characterIds = (value as Record<string, unknown>).characterIds;
  if (!Array.isArray(characterIds) || !characterIds.every((item): item is string => typeof item === "string")) return null;
  return { characterIds };
}

function grantBundleDto(row: AdminUserGrantBundle, now = Date.now()): AdminGrantBundle {
  const bundleKey = adminGrantBundleKeySchema.parse(row.bundleKey);
  return {
    id: row.id,
    userId: row.userId,
    bundleKey,
    scope: scopeOf(row.scope),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    state: row.revokedAt ? "revoked" : row.expiresAt && row.expiresAt.getTime() <= now ? "expired" : "active",
    permissions: ADMIN_GRANT_BUNDLES[bundleKey].permissions,
  };
}

export async function listUserGrantBundles(request: Request, userId: string) {
  await actorWithPermission(request, "user.role.write");
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true, status: true } });
  if (!user) throw Errors.notFound("User not found");
  const rows = await prisma.adminUserGrantBundle.findMany({
    where: { userId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const now = Date.now();
  return adminGrantBundleListSchema.parse({ user, items: rows.map((row) => grantBundleDto(row, now)) });
}

export async function grantUserBundle(input: {
  readonly userId: string;
  readonly actor: AdminActor;
  readonly body: AdminGrantBundleWrite;
  readonly requestId: string;
}, db?: Prisma.TransactionClient) {
  const { body } = input;
  if (body.confirmation !== `${input.userId}:${body.bundleKey}:grant`) {
    throw Errors.badRequest("Confirmation did not match grant bundle target");
  }
  assertBundleScope(body.bundleKey, body.scope);
  const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
  if (expiresAt && expiresAt.getTime() <= Date.now()) throw Errors.badRequest("Grant expiry must be in the future");
  const execute = async (tx: Prisma.TransactionClient) => {
    const user = await tx.user.findUnique({
      where: { id: input.userId },
      select: { id: true, role: true, status: true },
    });
    if (!user || user.status !== "active" || user.role === "user") {
      throw Errors.badRequest("Grant bundles only apply to active operator accounts");
    }
    const before = await tx.adminUserGrantBundle.findUnique({
      where: { userId_bundleKey: { userId: input.userId, bundleKey: body.bundleKey } },
    });
    const row = await tx.adminUserGrantBundle.upsert({
      where: { userId_bundleKey: { userId: input.userId, bundleKey: body.bundleKey } },
      create: {
        userId: input.userId,
        bundleKey: body.bundleKey,
        scope: body.scope ? toInputJson(body.scope) : undefined,
        reason: body.reason,
        createdById: input.actor.id,
        expiresAt,
      },
      update: {
        scope: body.scope ? toInputJson(body.scope) : undefined,
        reason: body.reason,
        createdById: input.actor.id,
        expiresAt,
        revokedAt: null,
        revokedById: null,
      },
    });
    await tx.adminAuditLog.create({
      data: {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: "admin.grant_bundle.granted",
        targetType: "user",
        targetId: input.userId,
        reason: body.reason,
        before: before ? toInputJson({ bundleKey: before.bundleKey, scope: before.scope, expiresAt: before.expiresAt, revokedAt: before.revokedAt }) : undefined,
        after: toInputJson({ bundleKey: row.bundleKey, scope: row.scope, expiresAt: row.expiresAt, revokedAt: null }),
        requestId: input.requestId,
      },
    });
    const result = adminGrantBundleMutationSchema.parse({ bundle: grantBundleDto(row) });
    await tx.mainOutboxEvent.create({
      data: {
        eventType: "admin.grant_bundle.granted.v2",
        aggregateType: "admin_user_grant_bundle",
        aggregateId: row.id,
        payload: toInputJson(result),
      },
    });
    return result;
  };
  return db ? execute(db) : prisma.$transaction(execute);
}

export async function revokeUserBundle(input: {
  readonly userId: string;
  readonly bundleKey: AdminGrantBundleKey;
  readonly actor: AdminActor;
  readonly body: AdminGrantBundleRevoke;
  readonly requestId: string;
}, db?: Prisma.TransactionClient) {
  if (input.body.confirmation !== `${input.userId}:${input.bundleKey}:revoke`) {
    throw Errors.badRequest("Confirmation did not match grant bundle target");
  }
  const execute = async (tx: Prisma.TransactionClient) => {
    const current = await tx.adminUserGrantBundle.findUnique({
      where: { userId_bundleKey: { userId: input.userId, bundleKey: input.bundleKey } },
    });
    if (!current) throw Errors.notFound("Grant bundle not found");
    const row = await tx.adminUserGrantBundle.update({
      where: { id: current.id },
      data: { revokedAt: new Date(), revokedById: input.actor.id },
    });
    await tx.adminAuditLog.create({
      data: {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: "admin.grant_bundle.revoked",
        targetType: "user",
        targetId: input.userId,
        reason: input.body.reason,
        before: toInputJson({ bundleKey: input.bundleKey, scope: current.scope, expiresAt: current.expiresAt, revokedAt: current.revokedAt }),
        after: toInputJson({ bundleKey: input.bundleKey, revokedAt: row.revokedAt }),
        requestId: input.requestId,
      },
    });
    const result = adminGrantBundleMutationSchema.parse({ bundle: grantBundleDto(row) });
    await tx.mainOutboxEvent.create({
      data: {
        eventType: "admin.grant_bundle.revoked.v2",
        aggregateType: "admin_user_grant_bundle",
        aggregateId: row.id,
        payload: toInputJson(result),
      },
    });
    return result;
  };
  return db ? execute(db) : prisma.$transaction(execute);
}
