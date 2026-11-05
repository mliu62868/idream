import { Prisma, type PrismaClient } from "@prisma/client";
import type { CharacterPortfolioQuery } from "@idream/shared/admin";
import {
  characterProductionPurposes,
  projectCharacterProductionJourneys,
} from "./production-journey";

type ComputedQueue = Exclude<
  NonNullable<CharacterPortfolioQuery["workQueue"]>,
  "live_asset_pack_incomplete"
>;

// SPEC: 工作队列在分页前精确筛，判定直接读 Journey，卡片说什么队列就收什么。
// INTENT: 只投影可能入队的角色（有线上/暂停 Release、草稿包齐、有候选、或有未出图的 Run），
//         规模跟运营中的角色数走，不跟全部用户角色走。不再写第二份判定 SQL。
export async function workQueueCharacterIds(
  db: PrismaClient,
  asOf: Date,
): Promise<Record<ComputedQueue, ReadonlySet<string>>> {
  const purposes = [...characterProductionPurposes];
  const [candidates, unhealthy] = await Promise.all([
    db.$queryRaw<Array<{ characterId: string }>>(Prisma.sql`
      SELECT p."characterId"
      FROM "character_projects" p
      LEFT JOIN "character_serving" s ON s."characterId" = p."characterId"
      WHERE COALESCE(s.state, 'inactive') <> 'retired' AND (
        s."currentReleaseId" IS NOT NULL
        OR p."draftAssetPack" ?& ${purposes}::text[]
        OR EXISTS (
          SELECT 1 FROM "character_releases" release
          WHERE release."projectId" = p.id AND release.status = 'approved'
        )
        OR EXISTS (
          SELECT 1 FROM "content_production_batches" batch
          WHERE batch."targetType" = 'character' AND batch."targetId" = p."characterId"
            AND batch.purpose = ANY(${purposes}::text[])
            AND batch."lifecycleState" <> 'archived'
            AND NOT EXISTS (
              SELECT 1 FROM "content_production_items" item
              WHERE item."batchId" = batch.id AND item."mediaAssetId" IS NOT NULL
            )
        )
      )
    `),
    // SPEC: 当前 Release 或候选 stale/blocked。legacy 不算受阻：线上照常，卡片上提示可重新发布即可。
    db.$queryRaw<Array<{ characterId: string }>>(Prisma.sql`
      SELECT DISTINCT p."characterId"
      FROM "character_projects" p
      JOIN "character_serving" s ON s."characterId" = p."characterId"
      JOIN "character_releases" release ON release."projectId" = p.id
      WHERE s.state <> 'retired'
        AND release.readiness IN ('stale', 'blocked')
        AND (
          release.id = s."currentReleaseId"
          OR (release.status = 'approved' AND release.id IS DISTINCT FROM s."currentReleaseId")
        )
    `),
  ]);
  const journeys = await projectCharacterProductionJourneys(
    db,
    candidates.map((row) => row.characterId),
    asOf,
  );
  const publishBlocked = new Set(unhealthy.map((row) => row.characterId));
  const queues = {
    pending_changes: new Set<string>(),
    candidate_unpublished: new Set<string>(),
    publish_blocked: publishBlocked,
    recent_generation_failed: new Set<string>(),
    ready_to_publish: new Set<string>(),
  };
  for (const [characterId, journey] of journeys) {
    const code = journey.primaryAction.code;
    if (
      journey.release.currentReleaseId &&
      (journey.release.pendingRevision !== null || code === "preview_character")
    ) {
      queues.pending_changes.add(characterId);
    }
    if (journey.release.candidateReleaseId) {
      queues.candidate_unpublished.add(characterId);
    }
    if (code === "retry_failed_image_run" || code === "resolve_unknown_image_run") {
      queues.recent_generation_failed.add(characterId);
    }
    if (journey.status === "ready" && !publishBlocked.has(characterId)) {
      queues.ready_to_publish.add(characterId);
    }
  }
  return queues;
}
