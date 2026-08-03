import {
  experimentDefinitionListQuerySchema,
  experimentDefinitionListSchema,
  experimentDefinitionSchema,
} from "@idream/shared/admin";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import { actorWithPermission, jsonBody } from "@/server/modules/admin-v2/shared/authority";
import { canonicalJsonEqual, requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";
import { transitionExperiment } from "./transition";

function definitionDto(row: Awaited<ReturnType<typeof prisma.experimentDefinition.findFirstOrThrow>>) {
  const rawMetrics = row.metrics !== null && typeof row.metrics === "object" && !Array.isArray(row.metrics) ? row.metrics : {};
  const controlVariant = typeof rawMetrics.controlVariant === "string" ? rawMetrics.controlVariant : "control";
  const metrics = {
    primary: "relationship.qce_activation.v1" as const,
    controlVariant,
    minimumMaturePerArm: typeof rawMetrics.minimumMaturePerArm === "number" ? rawMetrics.minimumMaturePerArm : 100,
    guardrails: Array.isArray(rawMetrics.guardrails) && rawMetrics.guardrails.length > 0
      ? rawMetrics.guardrails
      : [{ metricKey: "relationship.qce_activation.v1" as const, maxAbsoluteRegression: 0 }],
  };
  return experimentDefinitionSchema.parse({
    id: row.id,
    key: row.key,
    version: row.version,
    hypothesis: row.hypothesis,
    eligibility: row.eligibility,
    variants: row.variants,
    metrics,
    status: row.status,
    stateVersion: row.stateVersion,
    startedAt: row.startedAt?.toISOString() ?? null,
    stoppedAt: row.stoppedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

export function knownExperimentSurfaceBlockers(input: {
  key: string;
  eligibility: Prisma.JsonValue;
  variants: Prisma.JsonValue;
}): string[] {
  if (input.key !== "community.character-ranking.v1") return [];
  const eligibility = input.eligibility !== null && typeof input.eligibility === "object" && !Array.isArray(input.eligibility)
    ? input.eligibility as Record<string, Prisma.JsonValue | undefined>
    : {};
  const variantKeys = Array.isArray(input.variants)
    ? input.variants.flatMap((variant) => {
        if (variant === null || typeof variant !== "object" || Array.isArray(variant)) return [];
        const key = (variant as Record<string, Prisma.JsonValue | undefined>).key;
        return typeof key === "string" ? [key] : [];
      })
    : [];
  const blockers: string[] = [];
  if (eligibility.surface !== "community.leaderboard" || Object.keys(eligibility).some((key) => key !== "surface")) {
    blockers.push("community_ranking_eligibility_must_match_runtime_surface");
  }
  if (variantKeys.length !== 2 || !variantKeys.includes("control") || !variantKeys.includes("relationship_first")) {
    blockers.push("community_ranking_variants_must_match_runtime_behavior");
  }
  return blockers;
}

export async function listExperimentDefinitions(request: Request) {
  await actorWithPermission(request, "experiment.manage");
  const url = new URL(request.url);
  const query = experimentDefinitionListQuerySchema.parse(Object.fromEntries(url.searchParams));
  const rows = await prisma.experimentDefinition.findMany({
    where: {
      ...(query.status ? { status: query.status } : {}),
      ...(query.search ? { OR: [{ key: { contains: query.search, mode: "insensitive" } }, { hypothesis: { contains: query.search, mode: "insensitive" } }] } : {}),
      ...(query.cursor ? { id: { lt: query.cursor } } : {}),
    },
    orderBy: { id: "desc" },
    take: query.limit + 1,
  });
  const items = rows.slice(0, query.limit).map(definitionDto);
  return ok(experimentDefinitionListSchema.parse({
    items,
    pageInfo: {
      hasNextPage: rows.length > query.limit,
      endCursor: rows.length > query.limit ? items.at(-1)?.id ?? null : null,
    },
    asOf: new Date().toISOString(),
  }));
}

export async function getExperimentDefinition(request: Request, id: string) {
  await actorWithPermission(request, "experiment.manage");
  const row = await prisma.experimentDefinition.findUnique({ where: { id } });
  if (!row) throw Errors.notFound("Experiment definition not found");
  return ok({ experiment: definitionDto(row) });
}

export async function createExperimentDefinition(request: Request) {
  const actor = await actorWithPermission(request, "experiment.manage");
  const input = await jsonBody(request, "POST /api/v2/admin/experiments");
  const idempotencyKey = requireIdempotencyKey(request);
  const existing = await prisma.experimentDefinition.findUnique({ where: { createdById_createIdempotencyKey: { createdById: actor.id, createIdempotencyKey: idempotencyKey } } });
  if (existing) {
    if (existing.key !== input.key || existing.hypothesis !== input.hypothesis || existing.salt !== input.salt || !canonicalJsonEqual(existing.eligibility, input.eligibility) || !canonicalJsonEqual(existing.variants, input.variants) || !canonicalJsonEqual(existing.metrics, input.metrics)) {
      throw Errors.conflict("Idempotency key was reused with a different experiment definition");
    }
    return ok({ experiment: definitionDto(existing), duplicate: true });
  }
  const created = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${actor.id}:${idempotencyKey}`}))`;
    const replay = await tx.experimentDefinition.findUnique({ where: { createdById_createIdempotencyKey: { createdById: actor.id, createIdempotencyKey: idempotencyKey } } });
    if (replay) {
      if (replay.key !== input.key || replay.hypothesis !== input.hypothesis || replay.salt !== input.salt || !canonicalJsonEqual(replay.eligibility, input.eligibility) || !canonicalJsonEqual(replay.variants, input.variants) || !canonicalJsonEqual(replay.metrics, input.metrics)) {
        throw Errors.conflict("Idempotency key was reused with a different experiment definition");
      }
      return { row: replay, duplicate: true };
    }
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.key}))`;
    const latest = await tx.experimentDefinition.findFirst({ where: { key: input.key }, orderBy: { version: "desc" }, select: { version: true } });
    const row = await tx.experimentDefinition.create({
      data: {
        ...input,
        eligibility: input.eligibility as Prisma.InputJsonValue,
        variants: input.variants as Prisma.InputJsonValue,
        metrics: input.metrics as Prisma.InputJsonValue,
        version: (latest?.version ?? 0) + 1,
        createdById: actor.id,
        createIdempotencyKey: idempotencyKey,
      },
    });
    await tx.adminAuditLog.create({ data: { actorId: actor.id, actorRole: actor.role, action: "experiment.create_draft", targetType: "experiment_definition", targetId: row.id, after: { key: row.key, version: row.version, status: row.status }, requestId: request.headers.get("x-request-id") } });
    await tx.mainOutboxEvent.create({ data: { eventType: "experiment.definition.created.v2", aggregateType: "experiment_definition", aggregateId: row.id, payload: { experimentId: row.id, key: row.key, version: row.version, status: row.status, actorId: actor.id } } });
    return { row, duplicate: false };
  });
  return ok({ experiment: definitionDto(created.row), duplicate: created.duplicate }, { status: created.duplicate ? 200 : 201 });
}

async function applyExperimentLifecycle(request: Request, id: string, transition: "start" | "stop") {
  const actor = await actorWithPermission(request, "experiment.manage");
  const input = await jsonBody(
    request,
    `POST /api/v2/admin/experiments/:id/commands/${transition}` as const,
  );
  const idempotencyKey = requireIdempotencyKey(request);
  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${actor.id}:${idempotencyKey}`}))`;
    const receipt = await tx.adminAuditLog.findFirst({ where: { actorId: actor.id, requestId: idempotencyKey, action: { startsWith: "experiment." } }, orderBy: { createdAt: "desc" } });
    if (receipt) {
      const before = receipt.before !== null && typeof receipt.before === "object" && !Array.isArray(receipt.before) ? receipt.before as Record<string, unknown> : {};
      if (receipt.action !== `experiment.${transition}` || receipt.targetId !== id || receipt.reason !== input.reason || before.stateVersion !== input.expectedStateVersion) {
        throw Errors.conflict("Idempotency key was reused with a different experiment command");
      }
      return { row: await tx.experimentDefinition.findUniqueOrThrow({ where: { id } }), duplicate: true };
    }
    const candidate = await tx.experimentDefinition.findUnique({ where: { id } });
    if (!candidate) throw Errors.notFound("Experiment definition not found");
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${candidate.key}))`;
    const current = await tx.experimentDefinition.findUniqueOrThrow({ where: { id } });
    const expectedStatus = transition === "start" ? "draft" : "running";
    const nextStatus = transition === "start" ? "running" : "stopped";
    if (
      current.status !== expectedStatus ||
      current.stateVersion !== input.expectedStateVersion
    ) throw Errors.conflict("Experiment lifecycle changed; reload before retrying");
    if (transition === "start") {
      const blockers = knownExperimentSurfaceBlockers(current);
      if (blockers.length > 0) {
        throw Errors.badRequest("Experiment definition does not match its implemented product surface", { blockers });
      }
      const running = await tx.experimentDefinition.findFirst({ where: { key: current.key, status: "running", id: { not: id } } });
      if (running) throw Errors.conflict("Another version of this experiment is already running");
    }
    const now = new Date();
    const updated = await transitionExperiment(tx, {
      experimentId: id,
      to: nextStatus,
      expected: { from: expectedStatus, stateVersion: input.expectedStateVersion },
      data: transition === "start"
        ? { startedAt: now, startedById: actor.id }
        : { stoppedAt: now, stoppedById: actor.id },
    });
    await tx.adminAuditLog.create({ data: { actorId: actor.id, actorRole: actor.role, action: `experiment.${transition}`, targetType: "experiment_definition", targetId: id, reason: input.reason, before: { status: current.status, stateVersion: current.stateVersion }, after: { status: updated.status, stateVersion: updated.stateVersion }, requestId: idempotencyKey } });
    await tx.mainOutboxEvent.create({ data: { eventType: `experiment.definition.${transition === "start" ? "started" : "stopped"}.v2`, aggregateType: "experiment_definition", aggregateId: id, payload: { experimentId: id, key: updated.key, version: updated.version, stateVersion: updated.stateVersion, actorId: actor.id, reason: input.reason } } });
    return { row: updated, duplicate: false };
  });
  return ok({ experiment: definitionDto(result.row), duplicate: result.duplicate });
}

export function startExperiment(request: Request, id: string) { return applyExperimentLifecycle(request, id, "start"); }
export function stopExperiment(request: Request, id: string) { return applyExperimentLifecycle(request, id, "stop"); }
