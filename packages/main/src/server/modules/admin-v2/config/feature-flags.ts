import { randomUUID } from "node:crypto";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { executeAtomicIdempotentMutation } from "@/server/modules/admin-v2/shared/atomic-mutation";
import { actorWithPermission, jsonBody, queryParams } from "@/server/modules/admin-v2/shared/authority";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";
import {
  decodeAdminListCursor,
  encodeAdminListCursor,
} from "@/server/modules/admin-v2/shared/list-cursor";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";

function flagDto(flag: {
  key: string;
  label: string;
  description: string | null;
  enabled: boolean;
  rolloutPercent: number;
  targetRoles: unknown;
  targetPlans: unknown;
  hardPolicy: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    key: flag.key,
    label: flag.label,
    description: flag.description,
    enabled: flag.enabled,
    rolloutPercent: flag.rolloutPercent,
    targetRoles: flag.targetRoles,
    targetPlans: flag.targetPlans,
    hardPolicy: flag.hardPolicy,
    version: flag.version,
    createdAt: flag.createdAt.toISOString(),
    updatedAt: flag.updatedAt.toISOString(),
  };
}

export async function listFeatureFlags(request: Request) {
  await actorWithPermission(request, "ops.queue.read");
  const query = queryParams(request, "GET /api/v2/admin/feature-flags");
  const { search, enabled } = query;
  const limit = query.limit ?? null;
  const queryIdentity = { search, enabled };
  const cursorKeys = query.cursor
    ? decodeAdminListCursor(query.cursor, "feature_flags", queryIdentity)
    : undefined;
  const cursorKey = cursorKeys ? cursorString(cursorKeys) : undefined;
  const flags = await prisma.featureFlag.findMany({
    where: {
      enabled,
      OR: search
        ? [
            { key: { contains: search } },
            { label: { contains: search } },
            { description: { contains: search } },
          ]
        : undefined,
      AND: cursorKey ? { key: { gt: cursorKey } } : undefined,
    },
    orderBy: { key: "asc" },
    take: limit === null ? undefined : limit + 1,
  });
  const page = limit === null ? flags : flags.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map(flagDto),
    pageInfo: {
      endCursor: limit !== null && flags.length > limit && last
        ? encodeAdminListCursor("feature_flags", queryIdentity, [last.key])
        : null,
      hasNextPage: limit !== null && flags.length > limit,
    },
  };
}

export async function patchFeatureFlag(request: Request, key: string) {
  const actor = await actorWithPermission(request, "config.feature_flag.write");
  const body = await jsonBody(request, "PATCH /api/v2/admin/feature-flags/:key");
  if (isHardPolicyFlag(key)) throw Errors.forbidden("Hard safety policy flags cannot be changed");
  if (body.confirmation !== featureFlagConfirmation(key, body.enabled)) {
    throw Errors.badRequest("Confirmation did not match feature flag action");
  }
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  return executeAtomicIdempotentMutation({
    environment: env.APP_ENV,
    actor,
    idempotencyKey: requireIdempotencyKey(request),
    requestId,
    commandType: "config.feature_flag.write",
    target: { type: "feature_flag", id: key },
    payload: body,
    mutate: async (tx) => {
      const before = await tx.featureFlag.findUnique({ where: { key } });
      if (before?.hardPolicy) throw Errors.forbidden("Hard safety policy flags cannot be changed");
      const changed = await tx.featureFlag.upsert({
        where: { key },
        update: {
          enabled: body.enabled,
          rolloutPercent: body.rolloutPercent,
          targetRoles: body.targetRoles ? toInputJson(body.targetRoles) : undefined,
          targetPlans: body.targetPlans ? toInputJson(body.targetPlans) : undefined,
          description: body.description,
          version: { increment: 1 },
        },
        create: {
          key,
          label: key,
          description: body.description,
          enabled: body.enabled ?? false,
          rolloutPercent: body.rolloutPercent ?? 0,
          targetRoles: toInputJson(body.targetRoles ?? []),
          targetPlans: toInputJson(body.targetPlans ?? []),
        },
      });
      const after = flagAuditSnapshot(changed);
      await tx.adminAuditLog.create({ data: {
        actorId: actor.id,
        actorRole: actor.role,
        action: "config.feature_flag.write",
        targetType: "feature_flag",
        targetId: key,
        reason: body.reason,
        before: before ? toInputJson(flagAuditSnapshot(before)) : undefined,
        after: toInputJson(after),
        requestId,
      } });
      await tx.mainOutboxEvent.create({ data: {
        eventType: "config.feature_flag.changed.v2",
        aggregateType: "feature_flag",
        aggregateId: key,
        // INVARIANT: 事件里带 actor 与 requestId —— 下游对账靠这两个字段把事件接回审计行。
        payload: toInputJson({ ...after, actorId: actor.id, actorRole: actor.role, requestId }),
      } });
      return { flag: flagDto(changed) };
    },
    decorateResult: (result, replayed) => ({
      ...(result as Record<string, unknown>),
      replayed,
    }),
  });
}

function cursorString(keys: readonly unknown[]) {
  const value = keys[0];
  if (typeof value !== "string" || !value) {
    throw Errors.badRequest("feature_flags cursor key is invalid");
  }
  return value;
}

function featureFlagConfirmation(key: string, enabled: boolean | undefined) {
  if (enabled === undefined) return `${key}:updated`;
  return `${key}:${enabled === false ? "disabled" : "enabled"}`;
}

function flagAuditSnapshot(flag: { key: string; enabled: boolean; rolloutPercent: number; version: number }) {
  return {
    key: flag.key,
    enabled: flag.enabled,
    rolloutPercent: flag.rolloutPercent,
    version: flag.version,
  };
}

// INVARIANT: 硬策略开关（年龄闸 / 未成年保护）不接受任何写入，键名匹配即拒绝 ——
// 数据库里的 hardPolicy 标记是第二道，键名这道拦的是「行还不存在就先 upsert 出来」。
function isHardPolicyFlag(key: string) {
  const normalized = key.toLowerCase();
  const compact = normalized.replace(/[^a-z0-9]/g, "");
  return (
    normalized.includes("hard_policy")
    || compact.includes("hardpolicy")
    || normalized.includes("age_gate")
    || compact.includes("agegate")
    || normalized.includes("underage")
    || normalized.includes("minor_safety")
    || compact.includes("minorsafety")
  );
}
