import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import { enforceApproval } from "@/server/modules/admin/shared/legacy-approval";
import {
  actorWithPermission,
  jsonBody,
} from "@/server/modules/admin/shared/legacy-primitives";
import { persistTransactionalAdminMutation } from "@/server/modules/admin/shared/transactional-mutation";
import {
  decodeAdminListCursor,
  encodeAdminListCursor,
} from "@/server/modules/admin-v2/shared/list-cursor";

const pricingRuleSchema = z.object({
  ruleKey: z.string().trim().min(1).max(120),
  label: z.string().trim().min(1).max(120),
  mode: z.enum(["image", "video", "voice"]).default("image"),
  baseCost: z.number().int().min(0).max(100_000),
  multiplier: z.number().min(0.1).max(20).default(1),
  effectiveFrom: z.string().datetime().optional(),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

const pricingRulePatchSchema = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  baseCost: z.number().int().min(0).max(100_000).optional(),
  multiplier: z.number().min(0.1).max(20).optional(),
  effectiveFrom: z.string().datetime().nullable().optional(),
});

const pricingPublishSchema = z.object({
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
  effectiveFrom: z.string().datetime().optional(),
});

const rollbackSchema = z.object({
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

const pricingRuleListQuerySchema = z.object({
  search: z.string().trim().min(1).max(200).optional(),
  mode: z.string().trim().min(1).max(80).optional(),
  status: z.enum(["draft", "active", "archived"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).optional(),
}).strict();

export async function listPricingRules(request: Request) {
  await actorWithPermission(request, "billing.read");
  const url = new URL(request.url);
  const query = pricingRuleListQuerySchema.parse(Object.fromEntries(url.searchParams));
  const { search, mode, status } = query;
  const limit = query.limit ?? null;
  const queryIdentity = { search, mode, status };
  const cursorKeys = query.cursor
    ? decodeAdminListCursor(query.cursor, "pricing_rules", queryIdentity)
    : undefined;
  const cursorWhere: Prisma.PricingRuleWhereInput | undefined = cursorKeys ? (() => {
    const ruleKey = cursorString(cursorKeys, 0);
    const version = cursorNumber(cursorKeys, 1);
    const id = cursorString(cursorKeys, 2);
    return { OR: [
      { ruleKey: { gt: ruleKey } },
      { ruleKey, version: { lt: version } },
      { ruleKey, version, id: { gt: id } },
    ] };
  })() : undefined;
  const rules = await prisma.pricingRule.findMany({
    where: {
      mode,
      status,
      OR: search
        ? [{ id: { contains: search } }, { ruleKey: { contains: search } }, { label: { contains: search } }]
        : undefined,
      AND: cursorWhere,
    },
    orderBy: [{ ruleKey: "asc" }, { version: "desc" }, { id: "asc" }],
    take: limit === null ? undefined : limit + 1,
  });
  const page = limit === null ? rules : rules.slice(0, limit);
  const last = page.at(-1);
  return ok({
    items: page,
    pageInfo: {
      endCursor: limit !== null && rules.length > limit && last
        ? encodeAdminListCursor("pricing_rules", queryIdentity, [last.ruleKey, last.version, last.id])
        : null,
      hasNextPage: limit !== null && rules.length > limit,
    },
  });
}

export async function createPricingRule(request: Request) {
  const actor = await actorWithPermission(request, "config.pricing.write");
  const body = pricingRuleSchema.parse(await jsonBody(request));
  if (body.confirmation !== body.ruleKey) throw Errors.badRequest("Confirmation did not match pricing rule key");
  const rule = await prisma.$transaction(async (tx) => {
    const latest = await tx.pricingRule.findFirst({ where: { ruleKey: body.ruleKey }, orderBy: { version: "desc" } });
    const created = await tx.pricingRule.create({
      data: {
        ruleKey: body.ruleKey,
        label: body.label,
        mode: body.mode,
        baseCost: body.baseCost,
        multiplier: body.multiplier,
        effectiveFrom: body.effectiveFrom ? new Date(body.effectiveFrom) : null,
        version: (latest?.version ?? 0) + 1,
        status: "draft",
      },
    });
    const after = pricingAuditSnapshot(created);
    await persistTransactionalAdminMutation(tx, request, actor, {
      audit: {
        action: "config.pricing.create",
        targetType: "pricing_rule",
        targetId: created.id,
        reason: body.reason,
        after,
      },
      event: {
        eventType: "config.pricing.rule.created.v2",
        aggregateType: "pricing_rule",
        aggregateId: created.id,
        payload: { ruleId: created.id, ...after },
      },
    });
    return created;
  });
  return ok({ rule });
}

export async function patchPricingRule(request: Request, id: string) {
  const actor = await actorWithPermission(request, "config.pricing.write");
  const body = pricingRulePatchSchema.parse(await jsonBody(request));
  const updated = await prisma.$transaction(async (tx) => {
    const before = await tx.pricingRule.findUnique({ where: { id } });
    if (!before) throw Errors.notFound("Pricing rule not found");
    if (before.status !== "draft") throw Errors.badRequest("Only draft pricing rules can be edited");
    const changed = await tx.pricingRule.update({
      where: { id },
      data: {
        label: body.label,
        baseCost: body.baseCost,
        multiplier: body.multiplier,
        effectiveFrom: body.effectiveFrom === undefined
          ? undefined
          : body.effectiveFrom === null ? null : new Date(body.effectiveFrom),
      },
    });
    const beforeSnapshot = pricingAuditSnapshot(before);
    const after = pricingAuditSnapshot(changed);
    await persistTransactionalAdminMutation(tx, request, actor, {
      audit: {
        action: "config.pricing.update",
        targetType: "pricing_rule",
        targetId: id,
        before: beforeSnapshot,
        after,
      },
      event: {
        eventType: "config.pricing.rule.updated.v2",
        aggregateType: "pricing_rule",
        aggregateId: id,
        payload: { ruleId: id, ...after },
      },
    });
    return changed;
  });
  return ok({ rule: updated });
}

export async function publishPricingRule(request: Request, id: string) {
  const actor = await actorWithPermission(request, "config.pricing.write");
  const body = pricingPublishSchema.parse(await jsonBody(request));
  const { previous, published } = await prisma.$transaction(async (tx) => {
    const rule = await tx.pricingRule.findUnique({ where: { id } });
    if (!rule) throw Errors.notFound("Pricing rule not found");
    assertTargetConfirmation(body.confirmation, rule.id);
    if (rule.status !== "draft") throw Errors.badRequest("Only draft pricing rules can be published");
    await enforceApproval("config.pricing.publish", id, tx);
    const previous = await tx.pricingRule.findFirst({ where: { mode: rule.mode, status: "active" } });
    const effectiveFrom = body.effectiveFrom ? new Date(body.effectiveFrom) : (rule.effectiveFrom ?? new Date());
    if (effectiveFrom.getTime() > Date.now()) {
      throw Errors.badRequest("Pricing publish is immediate; effectiveFrom cannot be in the future", {
        effectiveFrom: effectiveFrom.toISOString(),
      });
    }
    await tx.pricingRule.updateMany({
      where: { mode: rule.mode, status: "active" },
      data: { status: "archived", archivedAt: new Date() },
    });
    const published = await tx.pricingRule.update({
      where: { id },
      data: { status: "active", effectiveFrom, publishedAt: new Date(), archivedAt: null },
    });
    const before = previous ? pricingAuditSnapshot(previous) : null;
    const after = pricingAuditSnapshot(published);
    await persistTransactionalAdminMutation(tx, request, actor, {
      audit: {
        action: "config.pricing.publish",
        targetType: "pricing_rule",
        targetId: id,
        reason: body.reason,
        before,
        after,
      },
      event: {
        eventType: "config.pricing.rule.published.v2",
        aggregateType: "pricing_rule",
        aggregateId: id,
        payload: {
          ruleId: id,
          previousActiveId: previous?.id ?? null,
          ...after,
        },
      },
    });
    return { previous, published };
  });
  return ok({ rule: published, previousActiveId: previous?.id ?? null });
}

export async function rollbackPricingRule(request: Request, id: string) {
  const actor = await actorWithPermission(request, "config.pricing.write");
  const body = rollbackSchema.parse(await jsonBody(request));
  const { current, restored } = await prisma.$transaction(async (tx) => {
    const current = await tx.pricingRule.findUnique({ where: { id } });
    if (!current) throw Errors.notFound("Pricing rule not found");
    assertTargetConfirmation(body.confirmation, current.id);
    const previous = await tx.pricingRule.findFirst({
      where: { ruleKey: current.ruleKey, status: "archived", version: { lt: current.version } },
      orderBy: { version: "desc" },
    });
    if (!previous) throw Errors.notFound("No previous pricing rule version to roll back to");
    await tx.pricingRule.updateMany({
      where: { mode: current.mode, status: "active" },
      data: { status: "archived", archivedAt: new Date() },
    });
    const restored = await tx.pricingRule.update({
      where: { id: previous.id },
      data: { status: "active", publishedAt: new Date(), archivedAt: null },
    });
    const before = pricingAuditSnapshot(current);
    const after = pricingAuditSnapshot(restored);
    await persistTransactionalAdminMutation(tx, request, actor, {
      audit: {
        action: "config.pricing.rollback",
        targetType: "pricing_rule",
        targetId: current.id,
        reason: body.reason,
        before,
        after,
      },
      event: {
        eventType: "config.pricing.rule.rolled_back.v2",
        aggregateType: "pricing_rule",
        aggregateId: current.id,
        payload: {
          fromRuleId: current.id,
          restoredRuleId: restored.id,
          fromVersion: current.version,
          toVersion: restored.version,
          ruleKey: restored.ruleKey,
          mode: restored.mode,
          status: restored.status,
        },
      },
    });
    return { current, restored };
  });
  return ok({ rule: restored, fromVersion: current.version, toVersion: restored.version });
}

function cursorString(keys: readonly unknown[], index: number) {
  const value = keys[index];
  if (typeof value !== "string" || !value) throw Errors.badRequest("pricing_rules cursor key is invalid");
  return value;
}

function cursorNumber(keys: readonly unknown[], index: number) {
  const value = keys[index];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw Errors.badRequest("pricing_rules cursor key is invalid");
  }
  return value;
}

function assertTargetConfirmation(value: string, targetId: string) {
  if (value !== targetId) throw Errors.badRequest("Confirmation did not match target");
}

function pricingAuditSnapshot(rule: {
  ruleKey: string;
  mode: string;
  baseCost: number;
  multiplier: number;
  version: number;
  status: string;
}) {
  return {
    ruleKey: rule.ruleKey,
    mode: rule.mode,
    baseCost: rule.baseCost,
    multiplier: rule.multiplier,
    version: rule.version,
    status: rule.status,
  };
}
