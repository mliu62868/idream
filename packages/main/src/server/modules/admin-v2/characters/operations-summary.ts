import {
  characterOperationsSummarySchema,
  type CharacterOperationsSummary,
  type CharacterPerformanceWindow,
} from "@idream/shared/admin";
import { Prisma, type PrismaClient } from "@prisma/client";
import { effectiveCharacterIdsForPermission } from "@/server/admin/effective-permissions";
import { prisma } from "@/server/lib/db";
import { ok } from "@/server/lib/http";
import {
  actorWithPermission,
  queryParams,
} from "@/server/modules/admin-v2/shared/authority";
import { characterCommandCoordinationKey } from "./command-coordination";
import { completedUtcCharacterPerformanceWindow } from "./performance";
import { operationalPortfolioCharacterSql } from "./portfolio";
import { characterProductionPurposes } from "./production-journey";

type Medians = { medianHours: number | null; sampleSize: number };

// SPEC: 运营效能（CHARACTER_ASSET_STUDIO_OPERATIONS_GUIDE 末段）只读现有事实，不新增写入或事件。
// INVARIANT: 无证据返回 null，不是 0。成本只有在窗口内每次调用都有真实成本时才给值。
export async function characterOperationsSummary(
  db: PrismaClient,
  input: {
    readonly window: CharacterPerformanceWindow;
    readonly asOf?: Date;
    readonly authorizedCharacterIds?: readonly string[] | null;
  },
): Promise<CharacterOperationsSummary> {
  const { start, end } = completedUtcCharacterPerformanceWindow({
    asOf: input.asOf ?? new Date(),
    window: input.window,
  });
  const scopeIds = input.authorizedCharacterIds ?? null;
  const scoped = scopeIds === null
    ? Prisma.empty
    : Prisma.sql`AND c.id = ANY(${[...scopeIds]}::text[])`;
  const purposes = [...characterProductionPurposes];
  const median = (rows: readonly Medians[]) => ({
    medianHours: rows[0]?.medianHours === null || rows[0] === undefined ? null : Number(rows[0].medianHours),
    sampleSize: Number(rows[0]?.sampleSize ?? 0),
  });
  const [firstImage, firstPublish, adoption, cost, publishFailures, operations] = await Promise.all([
    db.$queryRaw<Medians[]>(Prisma.sql`
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY hours) AS "medianHours", COUNT(*)::int AS "sampleSize"
      FROM (
        SELECT GREATEST(EXTRACT(EPOCH FROM (MIN(asset."createdAt") - p."createdAt")) / 3600, 0)::float8 AS hours
        FROM "character_projects" p
        JOIN "characters" c ON c.id = p."characterId"
        JOIN "media_assets" asset ON asset."characterId" = c.id
          AND asset.type = 'image' AND asset."safetyStatus" = 'passed' AND asset."deletedAt" IS NULL
        WHERE ${operationalPortfolioCharacterSql} ${scoped}
        GROUP BY p.id, p."createdAt"
        HAVING MIN(asset."createdAt") >= ${start} AND MIN(asset."createdAt") < ${end}
      ) AS firsts
    `),
    db.$queryRaw<Medians[]>(Prisma.sql`
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY hours) AS "medianHours", COUNT(*)::int AS "sampleSize"
      FROM (
        SELECT GREATEST(EXTRACT(EPOCH FROM (MIN(release."publishedAt") - p."createdAt")) / 3600, 0)::float8 AS hours
        FROM "character_projects" p
        JOIN "characters" c ON c.id = p."characterId"
        JOIN "character_releases" release ON release."projectId" = p.id
        WHERE ${operationalPortfolioCharacterSql} ${scoped} AND release."publishedAt" IS NOT NULL
        GROUP BY p.id, p."createdAt"
        HAVING MIN(release."publishedAt") >= ${start} AND MIN(release."publishedAt") < ${end}
      ) AS firsts
    `),
    // Cohort: images generated in the window; adoption is any later placement selection.
    db.$queryRaw<Array<{ generated: number; adopted: number }>>(Prisma.sql`
      SELECT COUNT(DISTINCT item."mediaAssetId")::int AS generated,
        COUNT(DISTINCT item."mediaAssetId") FILTER (WHERE EXISTS (
          SELECT 1 FROM "admin_audit_logs" audit
          WHERE audit.action = 'character.project.image_placement_selected'
            AND audit.after ->> 'assetId' = item."mediaAssetId"
        ))::int AS adopted
      FROM "content_production_items" item
      JOIN "content_production_batches" batch ON batch.id = item."batchId"
      JOIN "characters" c ON c.id = batch."targetId"
      WHERE ${operationalPortfolioCharacterSql} ${scoped}
        AND batch."targetType" = 'character' AND batch.purpose = ANY(${purposes}::text[])
        AND item."mediaAssetId" IS NOT NULL
        AND item."createdAt" >= ${start} AND item."createdAt" < ${end}
    `),
    db.$queryRaw<Array<{ calls: number; priced: number; micros: bigint | null }>>(Prisma.sql`
      SELECT COUNT(*)::int AS calls, COUNT(transport."costMicros")::int AS priced,
        COALESCE(SUM(transport."costMicros"), 0)::bigint AS micros
      FROM "content_production_items" item
      JOIN "content_production_batches" batch ON batch.id = item."batchId"
      JOIN "characters" c ON c.id = batch."targetId"
      JOIN "generation_attempts" attempt ON attempt."requestId" = item."jobId"
      JOIN "generation_transport_executions" transport ON transport."attemptId" = attempt.id
      WHERE ${operationalPortfolioCharacterSql} ${scoped}
        AND batch."targetType" = 'character' AND batch.purpose = ANY(${purposes}::text[])
        AND item."createdAt" >= ${start} AND item."createdAt" < ${end}
    `),
    db.controlPlaneCommand.count({
      where: {
        commandType: "character.release.publish",
        status: { in: ["failed", "cancelled"] },
        createdAt: { gte: start, lt: end },
        ...(scopeIds === null
          ? {}
          : { coordinationKey: { in: scopeIds.map(characterCommandCoordinationKey) } }),
      },
    }),
    db.$queryRaw<Array<{ count: number }>>(Prisma.sql`
      SELECT COUNT(*)::int AS count FROM "admin_audit_logs" audit
      WHERE audit.action LIKE 'character.%'
        AND audit."createdAt" >= ${start} AND audit."createdAt" < ${end}
        ${scopeIds === null ? Prisma.empty : Prisma.sql`AND (
          audit."targetId" = ANY(${[...scopeIds]}::text[])
          OR audit."targetId" IN (SELECT id FROM "character_projects" WHERE "characterId" = ANY(${[...scopeIds]}::text[]))
        )`}
    `),
  ]);
  const generated = adoption[0]?.generated ?? 0;
  const adopted = adoption[0]?.adopted ?? 0;
  const calls = cost[0]?.calls ?? 0;
  const priced = cost[0]?.priced ?? 0;
  const coverage = priced === 0 ? "none" as const : priced === calls ? "complete" as const : "partial" as const;
  return characterOperationsSummarySchema.parse({
    window: input.window,
    windowStart: start.toISOString(),
    windowEnd: end.toISOString(),
    firstUsableImage: median(firstImage),
    createToFirstPublish: median(firstPublish),
    imageAdoption: { adopted, generated, rate: generated > 0 ? adopted / generated : null },
    adoptedImageCost: {
      microsPerAdoptedImage:
        coverage === "complete" && adopted > 0 ? Number(cost[0]?.micros ?? 0) / adopted : null,
      currency: "USD",
      coverage,
    },
    publishFailures: { count: publishFailures, coverage: "committed_commands_only" },
    operationCount: operations[0]?.count ?? 0,
  });
}

export async function getCharacterOperationsSummary(request: Request) {
  const actor = await actorWithPermission(request, "character.performance.read");
  const query = queryParams(request, "GET /api/v2/admin/characters/performance/operations-summary");
  const scope = await effectiveCharacterIdsForPermission(actor.id, actor.role, "character.performance.read");
  return ok(
    await characterOperationsSummary(prisma, {
      window: query.window,
      authorizedCharacterIds: scope === null ? null : [...scope],
    }),
    { headers: { "cache-control": "no-store" } },
  );
}
