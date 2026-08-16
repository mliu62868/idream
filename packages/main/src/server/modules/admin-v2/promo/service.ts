import type { Prisma } from "@prisma/client";
import type {
  AdminRedeemCodeCreateRequest,
  AdminRedeemCodeDisableRequest,
} from "@idream/shared/admin";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import {
  redeemCodeHash,
  redeemCodeHashCandidates,
} from "@/server/lib/redeem-codes";
import {
  adminRequestId,
  adminRequestIpHash,
  adminRequestUserAgent,
} from "@/server/modules/admin-v2/shared/audit-request";
import { executeAtomicIdempotentMutation } from "@/server/modules/admin-v2/shared/atomic-mutation";
import type { AdminActor } from "@/server/modules/admin-v2/shared/authority";
import { actorWithPermission, queryParams } from "@/server/modules/admin-v2/shared/authority";
import {
  decodeAdminListCursor,
  encodeAdminListCursor,
} from "@/server/modules/admin-v2/shared/list-cursor";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";

export async function listRedeemCodes(request: Request) {
  await actorWithPermission(request, "growth.promo.read");
  const query = queryParams(request, "GET /api/v2/admin/promo/redeem-codes");
  const { search, status, limit } = query;
  const queryIdentity = { search, status };
  const cursorKeys = query.cursor
    ? decodeAdminListCursor(query.cursor, "redeem_codes", queryIdentity)
    : undefined;
  const cursorWhere: Prisma.RedeemCodeWhereInput | undefined = cursorKeys
    ? (() => {
        const createdAt = cursorDate(cursorKeys, 0, "redeem_codes");
        const id = cursorString(cursorKeys, 1, "redeem_codes");
        return {
          OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: id } }],
        };
      })()
    : undefined;
  const codes = await prisma.redeemCode.findMany({
    where: {
      status,
      id: search ? { contains: search } : undefined,
      AND: cursorWhere,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    include: { _count: { select: { redemptions: true } } },
  });
  const page = codes.slice(0, limit);
  return {
    items: page.map((code) => ({
      id: code.id,
      reward: code.reward,
      status: code.status,
      maxRedemptions: code.maxRedemptions,
      redemptions: code._count.redemptions,
      expiresAt: code.expiresAt?.toISOString() ?? null,
      createdAt: code.createdAt.toISOString(),
    })),
    pageInfo: pageInfo(
      "redeem_codes",
      queryIdentity,
      page,
      codes.length > limit,
      (row) => [row.createdAt.toISOString(), row.id],
    ),
  };
}

export async function createRedeemCode(
  request: Request,
  actor: AdminActor,
  body: AdminRedeemCodeCreateRequest,
  idempotencyKey: string,
) {
  if (body.confirmation !== body.code) {
    throw Errors.badRequest("Confirmation did not match");
  }
  const codeHash = redeemCodeHash(body.code);
  const requestId = adminRequestId(request);
  return executeAtomicIdempotentMutation({
    environment: env.APP_ENV,
    actor,
    idempotencyKey,
    requestId,
    commandType: "promo.redeem_code.create",
    target: { type: "redeem_code", id: codeHash },
    payload: {
      codeHash,
      reward: body.reward,
      maxRedemptions: body.maxRedemptions ?? null,
      expiresAt: body.expiresAt ?? null,
    },
    decorateResult: (value, replayed) => ({
      ...(value as Record<string, unknown>),
      replayed,
    }),
    mutate: async (tx) => {
      const existing = await tx.redeemCode.findFirst({
        where: { codeHash: { in: redeemCodeHashCandidates(body.code) } },
      });
      if (existing) throw Errors.badRequest("Redeem code already exists");
      const code = await tx.redeemCode.create({
        data: {
          codeHash,
          reward: toInputJson(body.reward),
          status: "active",
          maxRedemptions: body.maxRedemptions ?? null,
          expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
        },
      });
      await tx.adminAuditLog.create({
        data: {
          ...promoAuditIdentity(request, actor, requestId),
          action: "promo.redeem_code.create",
          targetType: "redeem_code",
          targetId: code.id,
          reason: body.reason,
          after: toInputJson({
            reward: body.reward,
            maxRedemptions: code.maxRedemptions,
            expiresAt: code.expiresAt,
          }),
        },
      });
      await tx.mainOutboxEvent.create({
        data: {
          eventType: "admin.promo.redeem_code_created.v2",
          aggregateType: "redeem_code",
          aggregateId: code.id,
          payload: toInputJson({ id: code.id, actorId: actor.id, requestId }),
        },
      });
      return { id: code.id, status: code.status };
    },
  });
}

export async function disableRedeemCode(
  request: Request,
  actor: AdminActor,
  id: string,
  body: AdminRedeemCodeDisableRequest,
  idempotencyKey: string,
) {
  if (body.confirmation !== id) {
    throw Errors.badRequest("Confirmation did not match target");
  }
  const requestId = adminRequestId(request);
  return executeAtomicIdempotentMutation({
    environment: env.APP_ENV,
    actor,
    idempotencyKey,
    requestId,
    commandType: "promo.redeem_code.disable",
    target: { type: "redeem_code", id },
    payload: body,
    decorateResult: (value, replayed) => ({
      ...(value as Record<string, unknown>),
      replayed,
    }),
    mutate: async (tx) => {
      const before = await tx.redeemCode.findUnique({ where: { id } });
      if (!before) throw Errors.notFound("Redeem code not found");
      const after = await tx.redeemCode.update({
        where: { id },
        data: { status: "disabled" },
      });
      await tx.adminAuditLog.create({
        data: {
          ...promoAuditIdentity(request, actor, requestId),
          action: "promo.redeem_code.disable",
          targetType: "redeem_code",
          targetId: id,
          reason: body.reason,
          before: toInputJson({ status: before.status }),
          after: toInputJson({ status: after.status }),
        },
      });
      await tx.mainOutboxEvent.create({
        data: {
          eventType: "admin.promo.redeem_code_disabled.v2",
          aggregateType: "redeem_code",
          aggregateId: id,
          payload: toInputJson({ id, actorId: actor.id, requestId }),
        },
      });
      return { id: after.id, status: after.status };
    },
  });
}

export async function listReferrals(request: Request) {
  await actorWithPermission(request, "growth.promo.read");
  const query = queryParams(request, "GET /api/v2/admin/promo/referrals");
  const { search, inviterId, status, limit } = query;
  const queryIdentity = { search, inviterId, status };
  const cursorKeys = query.cursor
    ? decodeAdminListCursor(query.cursor, "referrals", queryIdentity)
    : undefined;
  const cursorWhere: Prisma.ReferralWhereInput | undefined = cursorKeys
    ? (() => {
        const createdAt = cursorDate(cursorKeys, 0, "referrals");
        const id = cursorString(cursorKeys, 1, "referrals");
        return {
          OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: id } }],
        };
      })()
    : undefined;
  const rows = await prisma.referral.findMany({
    where: {
      inviterId,
      status,
      OR: search
        ? [
            { id: { contains: search } },
            { inviterId: { contains: search } },
            { inviteeId: { contains: search } },
            { code: { contains: search } },
          ]
        : undefined,
      AND: cursorWhere,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const page = rows.slice(0, limit);
  return {
    items: page.map((row) => ({
      id: row.id,
      inviterId: row.inviterId,
      inviteeId: row.inviteeId,
      code: row.code,
      status: row.status,
      subscriptionId: row.subscriptionId,
      rewardStatus: row.rewardStatus,
      createdAt: row.createdAt.toISOString(),
    })),
    pageInfo: pageInfo(
      "referrals",
      queryIdentity,
      page,
      rows.length > limit,
      (row) => [row.createdAt.toISOString(), row.id],
    ),
  };
}

function promoAuditIdentity(request: Request, actor: AdminActor, requestId: string) {
  return {
    actorId: actor.id,
    actorRole: actor.role,
    requestId,
    ipHash: adminRequestIpHash(request),
    userAgent: adminRequestUserAgent(request),
  };
}

function cursorString(keys: readonly unknown[], index: number, scope: string) {
  const value = keys[index];
  if (typeof value !== "string" || !value)
    throw Errors.badRequest(`${scope} cursor key is invalid`);
  return value;
}

function cursorDate(keys: readonly unknown[], index: number, scope: string) {
  const value = new Date(cursorString(keys, index, scope));
  if (Number.isNaN(value.getTime()))
    throw Errors.badRequest(`${scope} cursor timestamp is invalid`);
  return value;
}

function pageInfo<T>(
  scope: string,
  queryIdentity: unknown,
  page: readonly T[],
  hasNextPage: boolean,
  keys: (row: T) => readonly (string | number | boolean | null)[],
) {
  const last = page.at(-1);
  return {
    endCursor:
      hasNextPage && last
        ? encodeAdminListCursor(scope, queryIdentity, keys(last))
        : null,
    hasNextPage,
  };
}
