import { z } from "zod";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import {
  actorWithPermission,
  jsonBody,
  toInputJson,
  writeAudit,
} from "@/server/modules/admin/shared/legacy-primitives";
import { decodeAdminListCursor, encodeAdminListCursor } from "@/server/modules/admin-v2/shared/list-cursor";

const flagPatchSchema = z.object({
  enabled: z.boolean().optional(),
  rolloutPercent: z.number().int().min(0).max(100).optional(),
  targetRoles: z.array(z.string()).optional(),
  targetPlans: z.array(z.string()).optional(),
  description: z.string().max(500).optional(),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

const featureFlagListQuerySchema = z.object({
  search: z.string().trim().min(1).max(200).optional(),
  enabled: z.enum(["true", "false"]).transform((value) => value === "true").optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).optional(),
}).strict();

export async function listFeatureFlags(request: Request) {
  await actorWithPermission(request, "ops.queue.read");
  const query = featureFlagListQuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
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
        ? [{ key: { contains: search } }, { label: { contains: search } }, { description: { contains: search } }]
        : undefined,
      AND: cursorKey ? { key: { gt: cursorKey } } : undefined,
    },
    orderBy: { key: "asc" },
    take: limit === null ? undefined : limit + 1,
  });
  const page = limit === null ? flags : flags.slice(0, limit);
  const last = page.at(-1);
  return ok({
    items: page,
    pageInfo: {
      endCursor: limit !== null && flags.length > limit && last
        ? encodeAdminListCursor("feature_flags", queryIdentity, [last.key])
        : null,
      hasNextPage: limit !== null && flags.length > limit,
    },
  });
}

export async function patchFeatureFlag(request: Request, key: string) {
  const actor = await actorWithPermission(request, "config.feature_flag.write");
  const body = flagPatchSchema.parse(await jsonBody(request));
  if (isHardPolicyFlag(key)) throw Errors.forbidden("Hard safety policy flags cannot be changed");
  if (body.confirmation !== featureFlagConfirmation(key, body.enabled)) {
    throw Errors.badRequest("Confirmation did not match feature flag action");
  }
  const before = await prisma.featureFlag.findUnique({ where: { key } });
  if (before?.hardPolicy) throw Errors.forbidden("Hard safety policy flags cannot be changed");
  const updated = await prisma.featureFlag.upsert({
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
  await writeAudit(request, actor, {
    action: "config.feature_flag.write",
    targetType: "feature_flag",
    targetId: key,
    reason: body.reason,
    before: before ? flagAuditSnapshot(before) : null,
    after: flagAuditSnapshot(updated),
  });
  return ok({ flag: updated });
}

function cursorString(keys: readonly unknown[]) {
  const value = keys[0];
  if (typeof value !== "string" || !value) throw Errors.badRequest("feature_flags cursor key is invalid");
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
