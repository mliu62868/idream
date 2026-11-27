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
    // SPEC: 只看当前 Release stale/blocked。legacy 不算受阻：线上照常，卡片上提示可重新发布即可。
    // INTENT: 候选不进这个队列。发布校验失败现在会当场撤回候选；历史遗留的 approved + blocked
    //         候选仍由 candidate_unpublished 收（处置是放弃候选），一个角色只进一个队列。
    db.$queryRaw<Array<{ characterId: string }>>(Prisma.sql`
      SELECT DISTINCT p."characterId"
      FROM "character_projects" p
      JOIN "character_serving" s ON s."characterId" = p."characterId"
      JOIN "character_releases" release ON release.id = s."currentReleaseId"
      WHERE s.state <> 'retired'
        AND release."projectId" = p.id
        AND release.readiness IN ('stale', 'blocked')
    `),
  ]);
  const journeys = await projectCharacterProductionJourneys(
    db,
    candidates.map((row) => row.characterId),
    asOf,
  );
  const currentReleaseUnhealthy = new Set(unhealthy.map((row) => row.characterId));
  const queues = {
    pending_changes: new Set<string>(),
    candidate_unpublished: new Set<string>(),
    publish_blocked: new Set<string>(),
    recent_generation_failed: new Set<string>(),
    ready_to_publish: new Set<string>(),
  };
  for (const [characterId, journey] of journeys) {
    if (journey.hasPendingChanges) {
      queues.pending_changes.add(characterId);
    }
    if (journey.release.candidateReleaseId) {
      queues.candidate_unpublished.add(characterId);
    }
    if (journey.imageRunNeedsAttention) {
      queues.recent_generation_failed.add(characterId);
    }
    if (journey.status === "ready" && !currentReleaseUnhealthy.has(characterId)) {
      queues.ready_to_publish.add(characterId);
    }
  }
  // INVARIANT: candidate_unpublished 与 publish_blocked 互斥。有候选时处置是发布或放弃这个候选
  //            （发布本身会重验并替换当前 Release），不是另一条「修复当前 Release」的路。
  for (const characterId of currentReleaseUnhealthy) {
    if (!queues.candidate_unpublished.has(characterId)) {
      queues.publish_blocked.add(characterId);
    }
  }
  return queues;
}
