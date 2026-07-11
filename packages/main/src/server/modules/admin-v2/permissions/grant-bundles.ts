import { z } from "zod";
import { ADMIN_GRANT_BUNDLES, type AdminGrantBundleKey } from "@idream/shared";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import { actorWithPermission, jsonBody } from "@/server/modules/admin/service";
import { toInputJson } from "../shared/prisma-json";

const bundleKeySchema = z.enum(["character_producer", "creative_operator", "growth_operator"]);
const bundleWriteSchema = z.object({
  bundleKey: bundleKeySchema,
  scope: z.object({ characterIds: z.array(z.string().trim().min(1).max(160)).max(500).default([]) }).strict().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(300),
}).strict();
const bundleRevokeSchema = z.object({
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(300),
}).strict();

function assertBundleScope(bundleKey: AdminGrantBundleKey, scope: { characterIds: string[] } | undefined) {
  if (bundleKey === "character_producer" && (!scope || scope.characterIds.length === 0)) {
    throw Errors.badRequest("Character producer grants require at least one assigned Character");
  }
  if (bundleKey !== "character_producer" && scope?.characterIds.length) {
    throw Errors.badRequest("This grant bundle does not accept Character scope");
  }
}

export async function listUserGrantBundles(request: Request, userId: string) {
  await actorWithPermission(request, "user.role.write");
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true, status: true } });
  if (!user) throw Errors.notFound("User not found");
  const rows = await prisma.adminUserGrantBundle.findMany({ where: { userId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  const now = Date.now();
  return ok({
    user,
    items: rows.map((row) => ({
      ...row,
      permissions: ADMIN_GRANT_BUNDLES[row.bundleKey as AdminGrantBundleKey]?.permissions ?? [],
      state: row.revokedAt ? "revoked" : row.expiresAt && row.expiresAt.getTime() <= now ? "expired" : "active",
    })),
  });
}

export async function grantUserBundle(request: Request, userId: string) {
  const actor = await actorWithPermission(request, "user.role.write");
  const body = bundleWriteSchema.parse(await jsonBody(request));
  if (body.confirmation !== `${userId}:${body.bundleKey}:grant`) {
    throw Errors.badRequest("Confirmation did not match grant bundle target");
  }
  assertBundleScope(body.bundleKey, body.scope);
  const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
  if (expiresAt && expiresAt.getTime() <= Date.now()) throw Errors.badRequest("Grant expiry must be in the future");
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true, role: true, status: true } });
    if (!user || user.status !== "active" || user.role === "user") {
      throw Errors.badRequest("Grant bundles only apply to active operator accounts");
    }
    const before = await tx.adminUserGrantBundle.findUnique({ where: { userId_bundleKey: { userId, bundleKey: body.bundleKey } } });
    const row = await tx.adminUserGrantBundle.upsert({
      where: { userId_bundleKey: { userId, bundleKey: body.bundleKey } },
      create: {
        userId,
        bundleKey: body.bundleKey,
        scope: body.scope ? toInputJson(body.scope) : undefined,
        reason: body.reason,
        createdById: actor.id,
        expiresAt,
      },
      update: {
        scope: body.scope ? toInputJson(body.scope) : undefined,
        reason: body.reason,
        createdById: actor.id,
        expiresAt,
        revokedAt: null,
        revokedById: null,
      },
    });
    await tx.adminAuditLog.create({
      data: {
        actorId: actor.id,
        actorRole: actor.role,
        action: "admin.grant_bundle.granted",
        targetType: "user",
        targetId: userId,
        reason: body.reason,
        before: before ? toInputJson({ bundleKey: before.bundleKey, scope: before.scope, expiresAt: before.expiresAt, revokedAt: before.revokedAt }) : undefined,
        after: toInputJson({ bundleKey: row.bundleKey, scope: row.scope, expiresAt: row.expiresAt, revokedAt: null }),
        requestId: request.headers.get("x-request-id"),
      },
    });
    return ok({ bundle: row }, { status: 201 });
  });
}

export async function revokeUserBundle(request: Request, userId: string, bundleKeyValue: string) {
  const actor = await actorWithPermission(request, "user.role.write");
  const bundleKey = bundleKeySchema.parse(bundleKeyValue);
  const body = bundleRevokeSchema.parse(await request.json());
  if (body.confirmation !== `${userId}:${bundleKey}:revoke`) {
    throw Errors.badRequest("Confirmation did not match grant bundle target");
  }
  return prisma.$transaction(async (tx) => {
    const current = await tx.adminUserGrantBundle.findUnique({ where: { userId_bundleKey: { userId, bundleKey } } });
    if (!current) throw Errors.notFound("Grant bundle not found");
    const row = await tx.adminUserGrantBundle.update({
      where: { id: current.id },
      data: { revokedAt: new Date(), revokedById: actor.id },
    });
    await tx.adminAuditLog.create({
      data: {
        actorId: actor.id,
        actorRole: actor.role,
        action: "admin.grant_bundle.revoked",
        targetType: "user",
        targetId: userId,
        reason: body.reason,
        before: toInputJson({ bundleKey, scope: current.scope, expiresAt: current.expiresAt, revokedAt: current.revokedAt }),
        after: toInputJson({ bundleKey, revokedAt: row.revokedAt }),
        requestId: request.headers.get("x-request-id"),
      },
    });
    return ok({ bundle: row });
  });
}
