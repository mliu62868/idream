import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import {
  MAX_REDEEM_CODE_DREAMCOINS,
  MIN_REDEEM_CODE_DREAMCOINS,
  redeemCodeHash,
  redeemCodeHashCandidates,
} from "@/server/lib/redeem-codes";
import {
  adminAuditData,
  actorWithPermission,
  clampInt,
  jsonBody,
  toInputJson,
} from "@/server/modules/admin/shared/legacy-primitives";
import { executeIdempotentDomainCommand } from "@/server/modules/admin/shared/domain-command";
import {
  decodeAdminListCursor,
  encodeAdminListCursor,
} from "@/server/modules/admin-v2/shared/list-cursor";

const redeemCodeCreateSchema = z.object({
  code: z.string().trim().min(4).max(80),
  reward: z
    .object({
      dreamcoins: z
        .number()
        .finite()
        .int()
        .min(MIN_REDEEM_CODE_DREAMCOINS)
        .max(MAX_REDEEM_CODE_DREAMCOINS),
      note: z.string().trim().max(200).optional(),
    })
    .passthrough(),
  maxRedemptions: z.number().int().min(1).max(1_000_000).nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

const promoDisableSchema = z.object({
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

export async function listRedeemCodes(request: Request) {
  await actorWithPermission(request, "growth.promo.read");
  const url = new URL(request.url);
  const search = url.searchParams.get("search")?.trim() || undefined;
  const status = url.searchParams.get("status") ?? undefined;
  const limit = clampInt(url.searchParams.get("limit"), 1, 100, 100);
  const queryIdentity = { search, status };
  const cursorKeys = cursorKeysFor(url, "redeem_codes", queryIdentity);
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
  return ok({
    items: page.map((code) => ({
      id: code.id,
      reward: code.reward,
      status: code.status,
      maxRedemptions: code.maxRedemptions,
      redemptions: code._count.redemptions,
      expiresAt: code.expiresAt,
      createdAt: code.createdAt,
    })),
    pageInfo: pageInfo(
      "redeem_codes",
      queryIdentity,
      page,
      codes.length > limit,
      (row) => [row.createdAt.toISOString(), row.id],
    ),
  });
}

export async function createRedeemCode(request: Request) {
  const actor = await actorWithPermission(request, "growth.promo.write");
  const body = redeemCodeCreateSchema.parse(await jsonBody(request));
  if (body.confirmation !== body.code)
    throw Errors.badRequest("Confirmation did not match");
  const codeHash = redeemCodeHash(body.code);
  const result = await executeIdempotentDomainCommand({
    request,
    actor,
    commandType: "promo.redeem_code.create",
    targetType: "redeem_code",
    targetId: codeHash,
    payload: {
      codeHash,
      reward: body.reward,
      maxRedemptions: body.maxRedemptions ?? null,
      expiresAt: body.expiresAt ?? null,
    },
    execute: async (tx, requestId) => {
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
          ...adminAuditData(request, actor, {
            action: "promo.redeem_code.create",
            targetType: "redeem_code",
            targetId: code.id,
            reason: body.reason,
            after: {
              reward: body.reward,
              maxRedemptions: code.maxRedemptions,
              expiresAt: code.expiresAt,
            },
          }),
          requestId,
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
  return ok(result);
}

export async function disableRedeemCode(request: Request, id: string) {
  const actor = await actorWithPermission(request, "growth.promo.write");
  const body = promoDisableSchema.parse(await jsonBody(request));
  if (body.confirmation !== id)
    throw Errors.badRequest("Confirmation did not match target");
  const result = await executeIdempotentDomainCommand({
    request,
    actor,
    commandType: "promo.redeem_code.disable",
    targetType: "redeem_code",
    targetId: id,
    payload: body,
    execute: async (tx, requestId) => {
      const before = await tx.redeemCode.findUnique({ where: { id } });
      if (!before) throw Errors.notFound("Redeem code not found");
      const after = await tx.redeemCode.update({
        where: { id },
        data: { status: "disabled" },
      });
      await tx.adminAuditLog.create({
        data: {
          ...adminAuditData(request, actor, {
            action: "promo.redeem_code.disable",
            targetType: "redeem_code",
            targetId: id,
            reason: body.reason,
            before: { status: before.status },
            after: { status: after.status },
          }),
          requestId,
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
  return ok(result);
}

export async function listReferrals(request: Request) {
  await actorWithPermission(request, "growth.promo.read");
  const url = new URL(request.url);
  const search = url.searchParams.get("search")?.trim() || undefined;
  const inviterId = url.searchParams.get("inviterId") ?? undefined;
  const status = url.searchParams.get("status") ?? undefined;
  const limit = clampInt(url.searchParams.get("limit"), 1, 100, 100);
  const queryIdentity = { search, inviterId, status };
  const cursorKeys = cursorKeysFor(url, "referrals", queryIdentity);
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
  return ok({
    items: page,
    pageInfo: pageInfo(
      "referrals",
      queryIdentity,
      page,
      rows.length > limit,
      (row) => [row.createdAt.toISOString(), row.id],
    ),
  });
}

function cursorKeysFor(url: URL, scope: string, queryIdentity: unknown) {
  const raw = url.searchParams.get("cursor");
  return raw ? decodeAdminListCursor(raw, scope, queryIdentity) : undefined;
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
