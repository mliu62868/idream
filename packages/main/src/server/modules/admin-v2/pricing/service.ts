import type { Prisma, PricingRule } from "@prisma/client";
import type {
  AdminPricingRuleCreateRequest,
  AdminPricingRulePatchRequest,
  AdminPricingRulePublishRequest,
  AdminPricingRuleRollbackRequest,
} from "@idream/shared/admin";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import {
  adminRequestId,
  adminRequestIpHash,
  adminRequestUserAgent,
} from "@/server/modules/admin-v2/shared/audit-request";
import { executeAtomicIdempotentMutation } from "@/server/modules/admin-v2/shared/atomic-mutation";
import {
  actorWithPermission,
  queryParams,
  type AdminActor,
} from "@/server/modules/admin-v2/shared/authority";
import { enforceApproval } from "@/server/modules/admin-v2/shared/dual-approval";
import {
  decodeAdminListCursor,
  encodeAdminListCursor,
} from "@/server/modules/admin-v2/shared/list-cursor";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";

export async function listPricingRules(request: Request) {
  await actorWithPermission(request, "billing.read");
  const query = queryParams(request, "GET /api/v2/admin/pricing/rules");
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
  const hasNextPage = limit !== null && rules.length > limit;
  return {
    items: page.map(pricingRuleDTO),
    pageInfo: {
      endCursor: hasNextPage && last
        ? encodeAdminListCursor("pricing_rules", queryIdentity, [last.ruleKey, last.version, last.id])
        : null,
      hasNextPage,
    },
  };
}

export async function createPricingRule(
  request: Request,
  actor: AdminActor,
  body: AdminPricingRuleCreateRequest,
  idempotencyKey: string,
) {
  if (body.confirmation !== body.ruleKey) throw Errors.badRequest("Confirmation did not match pricing rule key");
  const requestId = adminRequestId(request);
  return executeAtomicIdempotentMutation({
    environment: env.APP_ENV,
    actor,
    idempotencyKey,
    requestId,
    commandType: "config.pricing.create",
    target: { type: "pricing_rule", id: body.ruleKey },
    payload: body,
    mutate: async (tx) => {
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
      await persistPricingMutation(tx, request, actor, requestId, {
        audit: {
          action: "config.pricing.create",
          targetId: created.id,
          reason: body.reason,
          after,
        },
        event: {
          eventType: "config.pricing.rule.created.v2",
          aggregateId: created.id,
          payload: { ruleId: created.id, ...after },
        },
      });
      return { rule: pricingRuleDTO(created) };
    },
  });
}

export async function patchPricingRule(
  request: Request,
  actor: AdminActor,
  id: string,
  body: AdminPricingRulePatchRequest,
  idempotencyKey: string,
) {
  const requestId = adminRequestId(request);
  return executeAtomicIdempotentMutation({
    environment: env.APP_ENV,
    actor,
    idempotencyKey,
    requestId,
    commandType: "config.pricing.update",
    target: { type: "pricing_rule", id },
    payload: body,
    mutate: async (tx) => {
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
      const after = pricingAuditSnapshot(changed);
      await persistPricingMutation(tx, request, actor, requestId, {
        audit: {
          action: "config.pricing.update",
          targetId: id,
          before: pricingAuditSnapshot(before),
          after,
        },
        event: {
          eventType: "config.pricing.rule.updated.v2",
          aggregateId: id,
          payload: { ruleId: id, ...after },
        },
      });
      return { rule: pricingRuleDTO(changed) };
    },
  });
}

export async function publishPricingRule(
  request: Request,
  actor: AdminActor,
  id: string,
  body: AdminPricingRulePublishRequest,
  idempotencyKey: string,
) {
  const requestId = adminRequestId(request);
  return executeAtomicIdempotentMutation({
    environment: env.APP_ENV,
    actor,
    idempotencyKey,
    requestId,
    commandType: "config.pricing.publish",
    target: { type: "pricing_rule", id },
    payload: body,
    mutate: async (tx) => {
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
      const after = pricingAuditSnapshot(published);
      await persistPricingMutation(tx, request, actor, requestId, {
        audit: {
          action: "config.pricing.publish",
          targetId: id,
          reason: body.reason,
          before: previous ? pricingAuditSnapshot(previous) : null,
          after,
        },
        event: {
          eventType: "config.pricing.rule.published.v2",
          aggregateId: id,
          payload: { ruleId: id, previousActiveId: previous?.id ?? null, ...after },
        },
      });
      return { rule: pricingRuleDTO(published), previousActiveId: previous?.id ?? null };
    },
  });
}

export async function rollbackPricingRule(
  request: Request,
  actor: AdminActor,
  id: string,
  body: AdminPricingRuleRollbackRequest,
  idempotencyKey: string,
) {
  const requestId = adminRequestId(request);
  return executeAtomicIdempotentMutation({
    environment: env.APP_ENV,
    actor,
    idempotencyKey,
    requestId,
    commandType: "config.pricing.rollback",
    target: { type: "pricing_rule", id },
    payload: body,
    mutate: async (tx) => {
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
      await persistPricingMutation(tx, request, actor, requestId, {
        audit: {
          action: "config.pricing.rollback",
          targetId: current.id,
          reason: body.reason,
          before: pricingAuditSnapshot(current),
          after: pricingAuditSnapshot(restored),
        },
        event: {
          eventType: "config.pricing.rule.rolled_back.v2",
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
      return {
        rule: pricingRuleDTO(restored),
        fromVersion: current.version,
        toVersion: restored.version,
      };
    },
  });
}

/**
 * SPEC: 一次定价变更的 Audit 行与 Outbox 事件，与规则写同事务落库。
 * INTENT: 四个定价命令写的是同一对记录，就地展开四遍只会让它们各自漂移；
 * 这个函数不出本文件，所以它不是又一个跨领域的通用写原语。
 */
async function persistPricingMutation(
  tx: Prisma.TransactionClient,
  request: Request,
  actor: AdminActor,
  requestId: string,
  input: {
    audit: {
      action: string;
      targetId: string;
      reason?: string;
      before?: unknown;
      after: unknown;
    };
    event: {
      eventType: string;
      aggregateId: string;
      payload: Record<string, unknown>;
    };
  },
) {
  await tx.adminAuditLog.create({
    data: {
      actorId: actor.id,
      actorRole: actor.role,
      action: input.audit.action,
      targetType: "pricing_rule",
      targetId: input.audit.targetId,
      reason: input.audit.reason,
      before: input.audit.before === undefined ? undefined : toInputJson(input.audit.before),
      after: toInputJson(input.audit.after),
      requestId,
      ipHash: adminRequestIpHash(request),
      userAgent: adminRequestUserAgent(request),
    },
  });
  await tx.mainOutboxEvent.create({
    data: {
      eventType: input.event.eventType,
      aggregateType: "pricing_rule",
      aggregateId: input.event.aggregateId,
      payload: toInputJson({
        ...input.event.payload,
        actorId: actor.id,
        actorRole: actor.role,
        requestId,
      }),
    },
  });
}

function pricingRuleDTO(rule: PricingRule) {
  return {
    id: rule.id,
    ruleKey: rule.ruleKey,
    label: rule.label,
    mode: rule.mode,
    baseCost: rule.baseCost,
    multiplier: rule.multiplier,
    status: rule.status as "draft" | "active" | "archived",
    version: rule.version,
    effectiveFrom: rule.effectiveFrom?.toISOString() ?? null,
    publishedAt: rule.publishedAt?.toISOString() ?? null,
    archivedAt: rule.archivedAt?.toISOString() ?? null,
  };
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

function pricingAuditSnapshot(rule: PricingRule) {
  return {
    ruleKey: rule.ruleKey,
    mode: rule.mode,
    baseCost: rule.baseCost,
    multiplier: rule.multiplier,
    version: rule.version,
    status: rule.status,
  };
}
