import {
  adminInvariantReportSchema,
  setGauge,
  type AdminInvariantCheck,
} from "@idream/shared";
import { Prisma, type PrismaClient } from "@prisma/client";
import { MAIN_OUTBOX_TRANSPORT_EVENT_TYPES } from "@/server/events/main-outbox-transport";
import { prisma } from "@/server/lib/db";
import { ok } from "@/server/lib/http";
import { actorWithPermission } from "@/server/modules/admin-v2/shared/authority";
import { CHARACTER_RELEASE_POLICY_VERSION } from "../characters/release-validation";
import {
  characterReleaseSnapshotHash,
  characterVisualProfileSnapshotHash,
  referenceSetSnapshotHash,
} from "../characters/release-snapshot";
import { PUBLIC_CATALOG_EDITORIAL_IMPORT_POLICY_VERSION } from "@/server/modules/ourdream/public-catalog-qualification";

interface ViolationRow {
  id: string;
  total: number;
}

interface SqlInvariant {
  readonly key: string;
  readonly description: string;
  readonly evidence: string;
  readonly query: Prisma.Sql;
}

type InvariantDb = Pick<
  PrismaClient,
  | "$queryRaw"
  | "character"
  | "characterServing"
  | "characterRelease"
  | "publicCatalogQualification"
  | "characterProject"
  | "characterRevision"
  | "characterContentVersion"
  | "characterVisualProfile"
  | "referenceSetRevision"
>;

type ServingPointer = {
  readonly servingId: string;
  readonly characterId: string;
  readonly pointer: "current";
  readonly releaseId: string;
};

const sqlChecks: readonly SqlInvariant[] = [
  {
    key: "character_project_orphan",
    description: "Every CharacterProject must resolve to its Character authority",
    evidence: "character_projects.characterId joined to characters.id, excluding erased anonymisations",
    // INTENT: `erased:<sha256>` 不是孤儿，是账号擦除**故意**写入的匿名化值 ——
    //   已发布角色的 Project 带着不可变资质证据必须留存，但要与被删用户切断关联
    //   （account-deletion-authority.ts）。此前这条扫描不排除它，于是每完成一次
    //   带已发布角色的擦除，就报出一条永远修不掉的"违规"。
    // INVARIANT: 判据只排除这一个前缀。任何别的悬空 characterId 仍然是真孤儿 ——
    //   本表没有外键（2026-09-12 试加后撤回：外键会让上面那次匿名化写入失败），
    //   所以这条扫描是唯一的发现机制。
    query: Prisma.sql`
      SELECT p.id, count(*) OVER()::int AS total
      FROM character_projects p
      LEFT JOIN characters c ON c.id = p."characterId"
      WHERE c.id IS NULL
        AND p."characterId" NOT LIKE 'erased:%'
      ORDER BY p.id LIMIT 20
    `,
  },
  {
    key: "official_public_character_without_current_serving_release",
    description: "Official public Characters must have a current CharacterServing Release",
    evidence: "characters.source/visibility/status joined to character_serving.currentReleaseId",
    query: Prisma.sql`
      SELECT c.id, count(*) OVER()::int AS total
      FROM characters c
      LEFT JOIN character_serving s ON s."characterId" = c.id
      WHERE c.source = 'official' AND c.visibility = 'public' AND c.status = 'approved'
        AND c."deletedAt" IS NULL AND s."currentReleaseId" IS NULL
      ORDER BY c.id LIMIT 20
    `,
  },
  {
    key: "official_public_character_not_live",
    description: "Official public Characters with a current Release must be live in CharacterServing",
    evidence: "public visibility is derived from CharacterServing.state=live plus the current published Release pointer",
    query: Prisma.sql`
      SELECT c.id, count(*) OVER()::int AS total
      FROM characters c
      JOIN character_serving s ON s."characterId" = c.id
      WHERE c.source = 'official' AND c.visibility = 'public' AND c.status = 'approved'
        AND c."deletedAt" IS NULL AND s."currentReleaseId" IS NOT NULL
        AND s.state <> 'live'
      ORDER BY c.id LIMIT 20
    `,
  },
  {
    key: "live_serving_legacy_projection_mismatch",
    description: "Every live public Serving authority must match the runtime Character and Release avatar projection",
    evidence: "CharacterServing live pointer joined to Character status/visibility/avatar and the Release avatar manifest",
    query: Prisma.sql`
      SELECT c.id, count(*) OVER()::int AS total
      FROM character_serving s
      JOIN characters c ON c.id = s."characterId"
      JOIN character_releases r ON r.id = s."currentReleaseId"
      JOIN character_projects p ON p.id = r."projectId"
      LEFT JOIN users creator ON creator.id = c."creatorId"
      WHERE c."deletedAt" IS NULL AND s.state = 'live'
        AND c.visibility = 'public' AND c.status = 'approved'
        AND (
          c.source = 'official'
          OR (
            c.source = 'user'
            AND creator."dataClass" = 'customer'
            AND creator.role = 'user'
            AND creator.status = 'active'
            AND creator."deletedAt" IS NULL
          )
        )
        AND (
          p."characterId" IS DISTINCT FROM c.id
          OR c."imageAssetId" IS DISTINCT FROM (
            SELECT placement->>'assetId'
            FROM jsonb_array_elements(
              CASE
                WHEN jsonb_typeof(r."releasePlacementManifest"->'placements') = 'array'
                  THEN r."releasePlacementManifest"->'placements'
                ELSE '[]'::jsonb
              END
            ) AS placement
            WHERE placement->>'slotKey' = 'character_avatar'
            LIMIT 1
          )
        )
      ORDER BY c.id LIMIT 20
    `,
  },
  {
    key: "serving_validation_stale",
    description: "Current Releases require an exact, non-revoked public qualification",
    evidence: `PublicCatalogQualification plus ReleaseValidationRun snapshotHash + ${CHARACTER_RELEASE_POLICY_VERSION}, or the editorial import policy`,
    query: Prisma.sql`
      SELECT r.id, count(*) OVER()::int AS total
      FROM character_serving s
      JOIN character_releases r ON r.id = s."currentReleaseId"
      WHERE NOT EXISTS (
        SELECT 1
        FROM public_catalog_qualifications q
        WHERE q."releaseId" = r.id
          AND q."releaseSnapshotHash" = r."snapshotHash"
          AND q."revokedAt" IS NULL
          AND (
            (
              q.kind = 'generated_release'
              AND r.legacy = FALSE
              AND r.readiness = 'ready'
              AND EXISTS (
                SELECT 1 FROM release_validation_runs v
                WHERE v.id = q."validationRunId"
                  AND v."releaseId" = r.id
                  AND v."snapshotHash" = r."snapshotHash"
                  AND v."policyVersion" = ${CHARACTER_RELEASE_POLICY_VERSION}
                  AND v.result = 'passed'
                  AND v."finishedAt" IS NOT NULL
              )
            )
            OR (
              q.kind = 'editorial_import'
              AND r.legacy = TRUE
              AND r.status = 'published'
              AND r."publishedAt" IS NOT NULL
              AND r.readiness = 'ready'
              AND r."generationProvenance"->>'schemaVersion' =
                'character-release-editorial-import-v1'
              AND q."validationRunId" IS NULL
              AND q.evidence->>'schemaVersion' =
                'public-catalog-qualification-v1'
              AND q.evidence->>'policyVersion' =
                ${PUBLIC_CATALOG_EDITORIAL_IMPORT_POLICY_VERSION}
              AND r.id = s."currentReleaseId"
            )
          )
      )
      ORDER BY r.id LIMIT 20
    `,
  },
  {
    key: "live_public_current_release_not_ready",
    description: "Every live public Character current Release must be published and ready",
    evidence: "Character public projection joined to CharacterServing live current Release status/readiness",
    query: Prisma.sql`
      SELECT c.id, count(*) OVER()::int AS total
      FROM characters c
      JOIN character_serving s ON s."characterId" = c.id
      JOIN character_releases r ON r.id = s."currentReleaseId"
      WHERE c.visibility = 'public'
        AND c.status = 'approved'
        AND c."deletedAt" IS NULL
        AND s.state = 'live'
        AND (
          r.status <> 'published'
          OR r."publishedAt" IS NULL
          OR r.readiness <> 'ready'
        )
      ORDER BY c.id LIMIT 20
    `,
  },
  {
    key: "editorial_import_authority_mismatch",
    description: "Live official editorial imports require one exact qualification, provenance, avatar, and asset authority",
    evidence: "Current legacy Release strict editorial sum type joined to Character, qualification, manifest, and MediaAsset",
    query: Prisma.sql`
      SELECT r.id, count(*) OVER()::int AS total
      FROM character_serving s
      JOIN characters c ON c.id = s."characterId"
      JOIN character_releases r ON r.id = s."currentReleaseId"
      LEFT JOIN character_projects p ON p.id = r."projectId"
      LEFT JOIN character_revisions revision ON revision.id = r."revisionId"
      LEFT JOIN character_content_versions content
        ON content.id = r."characterContentVersionId"
      LEFT JOIN public_catalog_qualifications q ON q."releaseId" = r.id
      LEFT JOIN media_assets asset
        ON asset.id = r."generationProvenance"->>'sourceAssetId'
      WHERE c.source = 'official'
        AND c.visibility = 'public'
        AND c.status = 'approved'
        AND c."deletedAt" IS NULL
        AND s.state = 'live'
        AND r.legacy = TRUE
        AND (
          r.status <> 'published'
          OR r."publishedAt" IS NULL
          OR r.readiness <> 'ready'
          OR r."visualProfileId" IS NOT NULL
          OR r."visualProfileVersion" IS NOT NULL
          OR r."referenceSetRevisionId" IS NOT NULL
          OR p."characterId" IS DISTINCT FROM c.id
          OR revision."projectId" IS DISTINCT FROM r."projectId"
          OR revision."characterContentVersionId"
            IS DISTINCT FROM r."characterContentVersionId"
          OR content."characterId" IS DISTINCT FROM c.id
          OR r."generationProvenance"->>'schemaVersion'
            IS DISTINCT FROM 'character-release-editorial-import-v1'
          OR r."generationProvenance"->>'recordId' IS DISTINCT FROM c.id
          OR NULLIF(r."generationProvenance"->>'dataset', '') IS NULL
          OR q.kind IS DISTINCT FROM 'editorial_import'
          OR q."validationRunId" IS NOT NULL
          OR q."revokedAt" IS NOT NULL
          OR q."releaseSnapshotHash" IS DISTINCT FROM r."snapshotHash"
          OR q.evidence->>'schemaVersion'
            IS DISTINCT FROM 'public-catalog-qualification-v1'
          OR q.evidence->>'policyVersion'
            IS DISTINCT FROM ${PUBLIC_CATALOG_EDITORIAL_IMPORT_POLICY_VERSION}
          OR q.evidence->>'characterId' IS DISTINCT FROM c.id
          OR q.evidence->>'sourceAssetId' IS DISTINCT FROM asset.id
          OR q.evidence#>>'{checks,exactSeedRecord}' IS DISTINCT FROM 'true'
          OR q.evidence#>>'{checks,nonSynthetic}' IS DISTINCT FROM 'true'
          OR q.evidence#>>'{checks,safetyPassed}' IS DISTINCT FROM 'true'
          OR q.evidence#>>'{checks,publicPack}' IS DISTINCT FROM 'true'
          OR q.evidence#>>'{checks,imageAvailable}' IS DISTINCT FROM 'true'
          OR r."releasePlacementManifest"->>'schemaVersion'
            IS DISTINCT FROM '1'
          OR r."releasePlacementManifest"->>'kind'
            IS DISTINCT FROM 'editorial_import'
          OR 1 <> (
            SELECT count(*)
            FROM jsonb_array_elements(
              CASE
                WHEN jsonb_typeof(r."releasePlacementManifest"->'placements') = 'array'
                  THEN r."releasePlacementManifest"->'placements'
                ELSE '[]'::jsonb
              END
            ) placement
          )
          OR 1 <> (
            SELECT count(*)
            FROM jsonb_array_elements(
              CASE
                WHEN jsonb_typeof(r."releasePlacementManifest"->'placements') = 'array'
                  THEN r."releasePlacementManifest"->'placements'
                ELSE '[]'::jsonb
              END
            ) placement
            WHERE placement->>'slotKey' = 'character_avatar'
              AND placement->>'assetId' =
                r."generationProvenance"->>'sourceAssetId'
              AND placement->>'slotVersion' = '1'
          )
          OR c."imageAssetId" IS DISTINCT FROM asset.id
          OR asset."characterId" IS DISTINCT FROM c.id
          OR asset.type IS DISTINCT FROM 'image'
          OR asset."deletedAt" IS NOT NULL
          OR asset.visibility IS DISTINCT FROM 'public_pack'
          OR asset."safetyStatus" IS DISTINCT FROM 'passed'
          OR NULLIF(asset.url, '') IS NULL
          OR asset.metadata->>'seedSource'
            IS DISTINCT FROM r."generationProvenance"->>'dataset'
          OR COALESCE(asset.metadata->'synthetic', 'null'::jsonb)
            NOT IN ('false'::jsonb, 'null'::jsonb)
          OR LOWER(COALESCE(asset.metadata#>>'{platformAsset,status}', ''))
            IN ('archived', 'rejected', 'blocked')
        )
      ORDER BY r.id LIMIT 20
    `,
  },
  {
    key: "editorial_import_route_qualification_misclassified",
    description: "Editorial imports must not retain generation-route staleness as an open operational action",
    evidence: "Editorial current Release route monitor plus stale/repair event history",
    query: Prisma.sql`
      WITH violations AS (
        SELECT r.id
        FROM character_serving s
        JOIN character_releases r ON r.id = s."currentReleaseId"
        JOIN public_catalog_qualifications q ON q."releaseId" = r.id
        JOIN release_monitors monitor
          ON monitor."releaseId" = r.id
          AND monitor.window = 'route_qualification'
        WHERE r.legacy = TRUE
          AND q.kind = 'editorial_import'
          AND q."revokedAt" IS NULL
          AND monitor.status <> 'completed'
        UNION
        SELECT r.id
        FROM character_serving s
        JOIN character_releases r ON r.id = s."currentReleaseId"
        JOIN public_catalog_qualifications q ON q."releaseId" = r.id
        WHERE r.legacy = TRUE
          AND q.kind = 'editorial_import'
          AND q."revokedAt" IS NULL
          AND EXISTS (
            SELECT 1 FROM character_release_events stale_event
            WHERE stale_event."releaseId" = r.id
              AND stale_event.type =
                'generation_route_qualification_stale'
          )
          AND NOT EXISTS (
            SELECT 1 FROM character_release_events repair_event
            WHERE repair_event."releaseId" = r.id
              AND repair_event.type =
                'editorial_import_route_staleness_repaired'
          )
      )
      SELECT id, count(*) OVER()::int AS total
      FROM violations ORDER BY id LIMIT 20
    `,
  },
  {
    key: "official_seed_asset_character_mismatch",
    description: "Every official seed Character image asset must be attached to that exact Character",
    evidence: "Official Character imageAssetId joined to seedSource MediaAsset.characterId",
    query: Prisma.sql`
      SELECT c.id, count(*) OVER()::int AS total
      FROM characters c
      JOIN media_assets asset ON asset.id = c."imageAssetId"
      WHERE c.source = 'official'
        AND asset.metadata->>'seedSource' =
          'src/lib/official-cold-start-content.ts'
        AND asset."characterId" IS DISTINCT FROM c.id
      ORDER BY c.id LIMIT 20
    `,
  },
  {
    key: "serving_default_route_unqualified",
    description: "Current default generation routes must satisfy their current qualification",
    evidence: "Current Release generationProvenance.requiredReleaseRoute joined to non-expired qualification",
    // INVARIANT: 路由指纹住在 `generationProvenance.requiredReleaseRoute` 下，不在顶层。
    //   这段 SQL 此前取的是顶层 `->>'routeFingerprint'` / `->>'matrixKey'`，v2 provenance
    //   顶层根本没有这两个键，取出来恒为 NULL，于是 NOT EXISTS 永远成立 ——
    //   实测把 3 个路由**已经资质化**的 Release 报成违规。同一个文件里
    //   isEditorialLegacyVisualProfileProjection 走 TS 读的就是 requiredReleaseRoute，
    //   两处实现同一判据，SQL 这处漂了。
    query: Prisma.sql`
      SELECT r.id, count(*) OVER()::int AS total
      FROM character_serving s
      JOIN character_releases r ON r.id = s."currentReleaseId"
      WHERE r.legacy = FALSE
      AND NOT EXISTS (
        SELECT 1 FROM generation_route_qualifications q
        WHERE q."routeFingerprint" = r."generationProvenance"->'requiredReleaseRoute'->>'routeFingerprint'
          AND q."matrixKey" = r."generationProvenance"->'requiredReleaseRoute'->>'matrixKey'
          AND q.result = 'qualified'
          AND (
            (
              q."matrixKey" = 'operator-single-image-v1'
              AND q.evidence->>'authorityMode' = 'operator_single_image'
            )
            OR (q."sampleCount" >= 40 AND q."identityMatch" >= 0.9)
          )
          AND (q."expiresAt" IS NULL OR q."expiresAt" > now())
      )
      ORDER BY r.id LIMIT 20
    `,
  },
  {
    key: "terminal_attempt_without_unique_terminal_event",
    description: "Every terminal Attempt requires exactly one matching attempt-linked terminal event",
    evidence: "GenerationAttempt terminal status/terminalSequence joined to immutable GenerationAttemptEvent terminal authority",
    query: Prisma.sql`
      SELECT a.id, count(*) OVER()::int AS total
      FROM generation_attempts a
      WHERE a.status IN ('succeeded', 'failed', 'blocked', 'cancelled', 'unknown')
        AND NOT EXISTS (
          SELECT 1 FROM generation_attempt_events e
          WHERE e."attemptId" = a.id
            AND e."terminalScope" = 'terminal'
            AND e.outcome = a.status
            AND e.sequence = a."terminalSequence"
        )
      ORDER BY a.id LIMIT 20
    `,
  },
  {
    key: "succeeded_request_delivery_count_mismatch",
    description: "Succeeded generation Requests must deliver exactly their expected output count",
    evidence: "GenerationFulfillmentFact business outcome joined to GenerationJob expected count and delivered rows",
    query: Prisma.sql`
      SELECT f."requestId" AS id, count(*) OVER()::int AS total
      FROM generation_fulfillment_facts f
      JOIN generation_jobs j ON j.id = f."requestId"
      LEFT JOIN generation_deliveries d ON d."requestId" = f."requestId" AND d.status = 'delivered'
      WHERE f.outcome = 'succeeded'
      GROUP BY f."requestId", f."expectedOutputCount", f."deliveredOutputCount", j."outputCount", j."deliveredOutputCount"
      HAVING count(d.id) <> j."outputCount"
        OR f."expectedOutputCount" <> j."outputCount"
        OR f."deliveredOutputCount" <> count(d.id)
        OR j."deliveredOutputCount" <> count(d.id)
      ORDER BY f."requestId" LIMIT 20
    `,
  },
  {
    key: "partial_request_delivery_count_mismatch",
    description: "Partial generation Requests must deliver at least one but fewer than the expected outputs",
    evidence: "GenerationJob expected count and actual delivered rows reconciled to the partial GenerationFulfillmentFact",
    query: Prisma.sql`
      WITH request_counts AS (
        SELECT
          j.id,
          f."expectedOutputCount" AS fact_expected,
          f."deliveredOutputCount" AS fact_delivered,
          j."outputCount" AS request_expected,
          j."deliveredOutputCount" AS request_delivered,
          count(d.id)::int AS actual_delivered
        FROM generation_jobs j
        LEFT JOIN generation_fulfillment_facts f
          ON f."requestId" = j.id AND f.outcome = 'partial'
        LEFT JOIN generation_deliveries d
          ON d."requestId" = j.id AND d.status = 'delivered'
        GROUP BY j.id, f."expectedOutputCount", f."deliveredOutputCount", j."outputCount", j."deliveredOutputCount"
      ), violations AS (
        SELECT id FROM request_counts
        WHERE (
            greatest(request_delivered, actual_delivered) > 0
            AND greatest(request_delivered, actual_delivered) < request_expected
            AND fact_expected IS NULL
          )
          OR (
            fact_expected IS NOT NULL
            AND (
              fact_expected <> request_expected
              OR fact_delivered <> actual_delivered
              OR request_delivered <> actual_delivered
              OR NOT (actual_delivered > 0 AND actual_delivered < request_expected)
            )
          )
      )
      SELECT id, count(*) OVER()::int AS total
      FROM violations ORDER BY id LIMIT 20
    `,
  },
  {
    key: "refund_encoded_as_execution_outcome",
    description: "Refund must not replace the generation execution outcome",
    evidence: "legacy GenerationJob.status must not use refunded as an execution terminal",
    query: Prisma.sql`
      SELECT j.id, count(*) OVER()::int AS total
      FROM generation_jobs j WHERE j.status = 'refunded'
      ORDER BY j.id LIMIT 20
    `,
  },
  {
    key: "generation_refund_exceeds_captured_spend",
    description: "Generation refunds must not exceed the captured generation spend authority",
    evidence: "GenerationSettlementLink joined to append-only DreamcoinLedger captured/refund totals",
    query: Prisma.sql`
      WITH settlement AS (
        SELECT
          l."requestId" AS id,
          coalesce(sum(CASE
            WHEN l.kind = 'generation_spend' AND d.reason = 'generation_spend' AND d.delta < 0
              THEN -d.delta ELSE 0 END), 0)::bigint AS captured,
          coalesce(sum(CASE
            WHEN l.kind = 'refund' AND d.reason = 'refund' AND d.delta > 0
              THEN d.delta ELSE 0 END), 0)::bigint AS refunded
        FROM generation_settlement_links l
        JOIN dreamcoin_ledger d ON d.id = l."ledgerEntryId"
        GROUP BY l."requestId"
      ), violations AS (
        SELECT id FROM settlement WHERE refunded > captured
      )
      SELECT id, count(*) OVER()::int AS total
      FROM violations ORDER BY id LIMIT 20
    `,
  },
  {
    key: "generation_settlement_link_mismatch",
    description: "Every generation settlement link must match one append-only ledger authority and every captured/refund entry must be linked",
    evidence: "GenerationSettlementLink request/kind reconciled bidirectionally with DreamcoinLedger sourceId/reason/delta",
    query: Prisma.sql`
      WITH violations AS (
        SELECT concat(l."requestId", ':', l."ledgerEntryId") AS id
        FROM generation_settlement_links l
        LEFT JOIN dreamcoin_ledger d ON d.id = l."ledgerEntryId"
        LEFT JOIN generation_jobs j ON j.id = l."requestId"
        WHERE d.id IS NULL OR j.id IS NULL
          OR d."sourceId" IS DISTINCT FROM l."requestId"
          OR d.reason IS DISTINCT FROM l.kind
          OR (l.kind = 'generation_spend' AND d.delta >= 0)
          OR (l.kind = 'refund' AND d.delta <= 0)
          OR l.kind NOT IN ('generation_spend', 'refund')
        UNION
        SELECT concat(d."sourceId", ':', d.id) AS id
        FROM dreamcoin_ledger d
        JOIN generation_jobs j ON j.id = d."sourceId"
        WHERE d.reason IN ('generation_spend', 'refund')
          AND NOT EXISTS (
            SELECT 1 FROM generation_settlement_links l
            WHERE l."ledgerEntryId" = d.id
              AND l."requestId" = d."sourceId"
              AND l.kind = d.reason
          )
      )
      SELECT id, count(*) OVER()::int AS total
      FROM violations ORDER BY id LIMIT 20
    `,
  },
  {
    key: "voice_succeeded_delivery_mismatch",
    description: "Succeeded voice requests require delivery evidence and exact media ownership",
    evidence: "VoiceClipRequest joined to MediaAsset and historical VoiceUsageFact delivery receipts",
    // A restored clip can reuse an earlier attempt's receipt. Hard deletion
    // clears both media FKs; its surviving usage is evidence, not corruption.
    query: Prisma.sql`
      SELECT r.id, count(*) OVER()::int AS total
      FROM voice_clip_requests r
      LEFT JOIN media_assets m ON m.id = r."mediaAssetId"
      WHERE r.status = 'succeeded' AND (
        NOT EXISTS (SELECT 1 FROM voice_usage_facts u WHERE u."requestId" = r.id)
        OR (r."mediaAssetId" IS NOT NULL AND (
          m.id IS NULL OR m.type <> 'voice'
          OR m."ownerId" IS DISTINCT FROM r."userId"
          OR m."characterId" IS DISTINCT FROM r."characterId"
          OR m.metadata->>'requestId' IS DISTINCT FROM r.id
          OR m.metadata->>'messageId' IS DISTINCT FROM r."messageId"
          OR NOT EXISTS (
            SELECT 1 FROM voice_usage_facts u WHERE u."requestId" = r.id
              AND (u."mediaAssetId" IS NOT NULL OR u."costDreamcoins" > 0)
          )
        ))
      )
      ORDER BY r.id LIMIT 20
    `,
  },
  {
    key: "voice_usage_authority_mismatch",
    description: "Voice usage must belong to its request and delivered media authority",
    evidence: "VoiceUsageFact request/user/character/attempt joined to VoiceClipRequest and surviving MediaAsset",
    query: Prisma.sql`
      SELECT u.id, count(*) OVER()::int AS total
      FROM voice_usage_facts u
      JOIN voice_clip_requests r ON r.id = u."requestId"
      LEFT JOIN media_assets m ON m.id = u."mediaAssetId"
      WHERE u."userId" IS DISTINCT FROM r."userId"
        OR u."characterId" IS DISTINCT FROM r."characterId"
        OR u."attemptNo" > r."attemptNo"
        OR (m.id IS NOT NULL AND (
          m.type <> 'voice' OR m."ownerId" IS DISTINCT FROM u."userId"
          OR m."characterId" IS DISTINCT FROM u."characterId"
          OR m.metadata->>'requestId' IS DISTINCT FROM r.id
        ))
      ORDER BY u.id LIMIT 20
    `,
  },
  {
    key: "voice_usage_debit_mismatch",
    description: "Every paid voice usage must match exactly one debit and every surviving request debit must match usage",
    evidence: "VoiceUsageFact cost reconciled with DreamcoinLedger voice request/attempt idempotency key, owner, source and amount",
    // Scope reverse reconciliation to surviving requests: account/character
    // deletion cascades their usage, while accounting evidence may survive.
    query: Prisma.sql`
      WITH violations AS (
        SELECT u.id
        FROM voice_usage_facts u
        LEFT JOIN dreamcoin_ledger d ON d."idempotencyKey" =
          concat('voice:', u."requestId", ':attempt:', u."attemptNo", ':spend')
        WHERE (u."costDreamcoins" > 0 AND (
          d.id IS NULL OR d.reason <> 'generation_spend'
          OR d.delta IS DISTINCT FROM -u."costDreamcoins"
          OR d."userId" IS DISTINCT FROM u."userId"
          OR (u."mediaAssetId" IS NOT NULL AND d."sourceId" IS DISTINCT FROM u."mediaAssetId")
        )) OR (u."costDreamcoins" = 0 AND d.id IS NOT NULL)
        UNION
        SELECT d.id
        FROM dreamcoin_ledger d
        JOIN voice_clip_requests r ON starts_with(d."idempotencyKey", concat('voice:', r.id, ':attempt:'))
        WHERE right(d."idempotencyKey", 6) = ':spend' AND NOT EXISTS (
          SELECT 1 FROM voice_usage_facts u WHERE u."requestId" = r.id
            AND d."idempotencyKey" = concat('voice:', u."requestId", ':attempt:', u."attemptNo", ':spend')
        )
      )
      SELECT id, count(*) OVER()::int AS total FROM violations ORDER BY id LIMIT 20
    `,
  },
  {
    key: "creative_succeeded_without_successful_item",
    description: "Creative Runs must not report success with zero successful items",
    evidence: "legacy completed batch with zero completed/approved items is a cutover violation",
    query: Prisma.sql`
      SELECT b.id, count(*) OVER()::int AS total
      FROM content_production_batches b
      WHERE b.status = 'completed' AND greatest(b."completedItems", b."approvedItems") = 0
      ORDER BY b.id LIMIT 20
    `,
  },
  {
    key: "creative_run_child_projection_mismatch",
    description: "Creative Run counters and lifecycle projection must equal their child item facts",
    evidence: "ContentProductionBatch totals/status recomputed from ContentProductionItem states",
    query: Prisma.sql`
      WITH derived AS (
        SELECT
          b.id,
          count(i.id)::int AS total_items,
          count(i.id) FILTER (WHERE i.status IN ('generated', 'approved', 'published'))::int AS completed_items,
          count(i.id) FILTER (WHERE i.status = 'failed')::int AS failed_items,
          count(i.id) FILTER (WHERE i.status IN ('approved', 'published'))::int AS approved_items,
          count(i.id) FILTER (WHERE i.status IN ('approved', 'rejected', 'published', 'failed'))::int AS reviewed_items,
          count(i.id) FILTER (WHERE i.status IN ('queued', 'regenerate_requested'))::int AS active_items,
          count(i.id) FILTER (WHERE i.status = 'generated')::int AS generated_items,
          b."totalItems",
          b."completedItems",
          b."failedItems",
          b."approvedItems",
          b.status
        FROM content_production_batches b
        LEFT JOIN content_production_items i ON i."batchId" = b.id
        GROUP BY b.id
      ), violations AS (
        SELECT id FROM derived
        WHERE "totalItems" <> total_items
          OR "completedItems" <> completed_items
          OR "failedItems" <> failed_items
          OR "approvedItems" <> approved_items
          OR status <> CASE
            WHEN total_items > 0 AND reviewed_items = total_items
              THEN CASE WHEN completed_items > 0 THEN 'completed' ELSE 'failed' END
            WHEN generated_items > 0 OR reviewed_items > 0 THEN 'reviewing'
            WHEN active_items > 0 THEN 'queued'
            ELSE 'draft'
          END
      )
      SELECT id, count(*) OVER()::int AS total
      FROM violations ORDER BY id LIMIT 20
    `,
  },
  {
    key: "open_source_without_case",
    description: "Every open Report, Appeal, or Support Request source must have an active typed Case",
    evidence: "source records joined through immutable case_evidence to an active subtype-matched admin_case",
    query: Prisma.sql`
      WITH violations AS (
        SELECT ('report:' || r.id) AS id FROM content_reports r
        WHERE r.status = 'open' AND NOT EXISTS (
          SELECT 1 FROM case_evidence e
          JOIN admin_cases c ON c.id = e."caseId"
          WHERE e."sourceType" = 'content_report' AND e."sourceId" = r.id
            AND c.type = 'content_report' AND c.status NOT IN ('closed', 'resolved')
        )
        UNION ALL
        SELECT ('appeal:' || a.id) AS id FROM appeals a
        WHERE a.status = 'open' AND NOT EXISTS (
          SELECT 1 FROM case_evidence e
          JOIN admin_cases c ON c.id = e."caseId"
          WHERE e."sourceType" = 'appeal' AND e."sourceId" = a.id
            AND c.type = 'appeal' AND c.status NOT IN ('closed', 'resolved')
        )
        UNION ALL
        SELECT ('support_request:' || s.id) AS id FROM support_requests s
        WHERE s.status IN ('received', 'open', 'waiting_on_user') AND NOT EXISTS (
          SELECT 1 FROM case_evidence e
          JOIN admin_cases c ON c.id = e."caseId"
          WHERE e."sourceType" = 'support_request' AND e."sourceId" = s.id
            AND c.type IN ('support_request', 'billing_dispute')
            AND c.status NOT IN ('closed', 'resolved')
        )
      )
      SELECT id, count(*) OVER()::int AS total FROM violations ORDER BY id LIMIT 20
    `,
  },
  // SPEC: Active identity invalid states are rejected by CHECK + UNIQUE constraints.
  // INTENT: Query the authority itself; scanning for rows the database cannot store is constant-green theater.
  // INVARIANT: A validated constraint with the right name but a weaker expression is not the authority.
  {
    key: "active_identity_constraint_missing",
    description:
      "Case and Incident active identity lifecycle constraints must remain database-enforced",
    evidence:
      "validated CHECK constraints plus the admin_cases activeKey unique index",
    query: Prisma.sql`
      WITH expected_checks(id, tablename, constraint_name, expression_hash) AS (
        VALUES
          ('admin_cases:admin_cases_active_key_identity',
            'admin_cases', 'admin_cases_active_key_identity',
            'e599bd00e0c71ee2f3caaa64e31d8ea3'),
          ('ops_incidents:ops_incidents_terminal_releases_active_correlation_key',
            'ops_incidents', 'ops_incidents_terminal_releases_active_correlation_key',
            'b1ad33fd15ee005adfe3835aee69d83f')
      ),
      present AS (
        SELECT c.relname::text AS tablename, x.conname::text AS constraint_name,
          md5(pg_get_expr(x.conbin, x.conrelid)) AS expression_hash
        FROM pg_constraint x
        JOIN pg_class c ON c.oid = x.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE x.contype = 'c' AND x.convalidated
          AND n.nspname = current_schema()
          AND c.relname IN ('admin_cases', 'ops_incidents')
      ),
      expected_unique_indexes(id, tablename, columns) AS (
        VALUES
          ('admin_cases:activeKey_unique', 'admin_cases', ARRAY['activeKey'])
      ),
      present_unique_indexes AS (
        SELECT c.relname::text AS tablename,
          array_agg(a.attname::text ORDER BY k.ord) AS columns
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
        WHERE i.indisunique AND i.indisvalid AND i.indisready AND i.indislive
          AND i.indpred IS NULL
          AND n.nspname = current_schema()
          AND c.relname = 'admin_cases'
        GROUP BY i.indexrelid, c.relname
      ),
      violations AS (
        SELECT e.id FROM expected_checks e
        WHERE NOT EXISTS (
          SELECT 1 FROM present p
          WHERE p.tablename = e.tablename
            AND p.constraint_name = e.constraint_name
            AND p.expression_hash = e.expression_hash
        )
        UNION ALL
        SELECT e.id FROM expected_unique_indexes e
        WHERE NOT EXISTS (
          SELECT 1 FROM present_unique_indexes p
          WHERE p.tablename = e.tablename AND p.columns = e.columns
        )
      )
      SELECT id, count(*) OVER()::int AS total FROM violations ORDER BY id LIMIT 20
    `,
  },
  // SPEC: 每一条已到期的 outbox 事件都必须至少被投递器取过一次。
  // INTENT: main_outbox_events 是一张多路复用表——每个消费者按 eventType 各取各的
  //         （chat-outbox 只取 MAIN_TO_CHAT_EVENTS 那 14 种，event-consumer 只取
  //         product.event.persisted.v2……）。写入方新增一种事件却没人订阅时，行就永远躺在
  //         pending：没有失败、没有告警、没有任何一页显示它，表还在无界增长。
  //         实测 101 行 / 32 种类型、最早 2026-07-23，全部 attempts=0。
  // INVARIANT: 判据里没有时间阈值 —— attempts=0 且已过 nextRunAt，说明**一次都没被取过**，
  //            这是结构事实不是"积压多久算久"的口味问题。nextRunAt 仍在未来的不算：
  //            账号删除请求就是靠它实现 30 天宽限期，那批是正常等待，不是无人认领。
  {
    key: "outbox_event_never_dispatched",
    description: "Every due Main outbox transport event must have been attempted at least once",
    evidence: "main_outbox_events pending past nextRunAt with attempts = 0, limited to event types a dispatcher actually consumes",
    // INTENT: 判据此前不区分「有消费者」和「无消费者」的事件类型，于是把整张表
    //   当成传输队列来考核。实测 51 个事件类型触发违规，而 dispatcher 只按
    //   MAIN_OUTBOX_TRANSPORT_EVENT_TYPES 取件 —— 那是 25 个事件类型
    //   （chat 5 + legacy chat 13 + generation_dispatch 4 + product_event /
    //   terminal_record / incident_correlation 各 1），其余 261 条是
    //   admin.command.accepted.v2 / creative.review.decided.v2 / character.release.*
    //   这类领域事件，本就没有消费者，永远停在 pending 是它们的正常归宿。
    //   一条永远报红的不变式等于没有不变式：真正的投递故障会被淹没在噪音里。
    // INVARIANT: 这里收窄的是**考核范围**，不是标准 —— 传输事件漏投仍然立刻报出来。
    //   无消费者的领域事件现在有自己的终态 `recorded`（event-consumer 的 unrouted_outbox
    //   lane 按 MAIN_OUTBOX_TRANSPORT_QUEUES 收敛，见 MAIN_OUTBOX_RECORDED_STATUS），
    //   所以两边用的是同一张路由表：路由表里的类型要么被投递，要么在这里报红；
    //   路由表外的类型不会停在 pending。
    query: Prisma.sql`
      WITH violations AS (
        SELECT min(id) AS id
        FROM main_outbox_events
        WHERE status = 'pending'
          AND attempts = 0
          AND "nextRunAt" <= now()
          AND "eventType" IN (${Prisma.join([...MAIN_OUTBOX_TRANSPORT_EVENT_TYPES])})
        GROUP BY "eventType"
      )
      SELECT id, count(*) OVER()::int AS total FROM violations ORDER BY id LIMIT 20
    `,
  },
  // SPEC: 每一条案件证据都必须挂在一个真实存在的 Case 上。
  // INTENT: 与 attempt_without_request 同形 —— `case_evidence."caseId"` 同样没有外键。
  //         但这里的比例说明它不是偶发：实测 55 条证据里 33 条指向已不存在的 Case（60%）。
  //         成因在账号擦除：因为这些列没有 FK，级联删除只能手写（account-deletion-authority.ts
  //         的 90 行删除序列），而 case_evidence 与 admin_cases 既不在那份手写清单里，
  //         也没有 users 上的 onDelete: Cascade 兜底 —— 于是每擦除一个用户就稳定量产一批孤儿。
  //         这是"缺 FK → 必须手写级联 → 手写必然漏 → 量产孤儿"的自我强化循环。
  // INVARIANT: 判据只问「挂靠的 Case 在不在」。审核证据一旦与案件失联，就再也无法
  //            证明当初那个决定的依据 —— 对一个要处理举报与申诉的系统，这是审计链的断裂。
  {
    key: "case_evidence_without_case",
    description: "Every Case evidence row must reference a Case that exists",
    evidence: "case_evidence whose caseId has no admin_cases row",
    query: Prisma.sql`
      WITH violations AS (
        SELECT e.id
        FROM case_evidence e
        LEFT JOIN admin_cases c ON c.id = e."caseId"
        WHERE c.id IS NULL
      )
      SELECT id, count(*) OVER()::int AS total FROM violations ORDER BY id LIMIT 20
    `,
  },
  // SPEC: 一个已扣费的生成请求必须在有限时间内到达终态。
  // INTENT: 这是这条链上唯一一条 liveness 断言。24 条不变式里跟钱相关的那几条，
  //         判据全长成 `WHERE outcome = 'succeeded'` —— 检查的是「已终结的单结算对不对」，
  //         从不问「这单为什么还没终结」。于是一个永远开着的请求不违反任何一条：
  //         它对整套对账体系隐形，而用户那边是一个不报错、不能重试、不退币的「排队中」，
  //         还永久占着 MAX_INFLIGHT_JOBS_PER_USER 的名额（卡满就再也发不出生成）。
  //
  //         已知至少四类分支会走到这里，而两个 sweeper 拼起来正好漏掉它们：
  //         · terminal record 已接收但 finalize 没跑完 —— stale 隔离器显式要求
  //           `terminalRecordRef IS NULL`（local-pipeline.ts:174,283）把它排除，
  //           unknown 清扫器又只认 `status='unknown'`；此时唯一凭据只在 Redis 里
  //         · stale 隔离器自身四条无时限的 `return none`（源队列仍活、探针不可达、
  //           缺 dispatch 事实、重投活锁 —— 重投无次数上限且每次都刷新证据时间）
  //         · unknown 收到迟到成功证据后，confirm_failed 每 60 秒抛一次、永远
  //         · 零 Attempt 的 Request（reconcileStaleGenerationJobs 直接 return none）
  //
  // INVARIANT: 判据与失败原因无关 —— 只问「开了多久」，不枚举「为什么卡住」。
  //            与原因无关的断言才拦得住还没被想到的失败模式，上面四类无需逐条建规则。
  //            6 小时远超任何正常路径（图片 stale 阈值 10 分钟、视频 provider 上限
  //            30 分钟、unknown 宽限 30 分钟），所以这条不会因为「跑得慢」而误报。
  {
    key: "open_request_exceeds_settlement_deadline",
    description: "Every charged generation Request must reach a terminal state",
    evidence: "generation_jobs still in a non-terminal status long past any provider deadline",
    query: Prisma.sql`
      WITH violations AS (
        SELECT j.id
        FROM generation_jobs j
        WHERE j.status IN ('queued', 'moderating_input', 'running', 'moderating_output')
          AND j."updatedAt" < now() - interval '6 hours'
      )
      SELECT id, count(*) OVER()::int AS total FROM violations ORDER BY id LIMIT 20
    `,
  },
  // SPEC: 每一条执行记录都必须指向一个真实存在的 Generation Request。
  // INTENT: generation_attempts."requestId" 是裸 String —— 没有 Prisma relation，
  //         也没有数据库外键。所以「删掉 Request 但留下 Attempt」是一个合法写入，
  //         数据库不拦、应用层没人查。实测 3 条 status='running'、finishedAt 为 null、
  //         创建于 2026-07-25，对应的 generation_jobs 行根本不存在。
  //         它们对收口机制是双重隐形：stale-unknown-dispatcher 只查 status='unknown'
  //         （这些是 running），而且要按 requestId 反查 Request（查不到就被过滤掉）。
  //         于是系统至今认为有三次执行正在进行中。
  // INVARIANT: 判据只问「指向的 Request 在不在」，不问「为什么卡住」——
  //            与失败原因无关的断言才拦得住还没被想到的失败模式。
  {
    key: "attempt_without_request",
    description: "Every Generation Attempt must reference a Request that exists",
    evidence: "generation_attempts whose requestId has no generation_jobs row",
    query: Prisma.sql`
      WITH violations AS (
        SELECT a.id
        FROM generation_attempts a
        LEFT JOIN generation_jobs j ON j.id = a."requestId"
        WHERE j.id IS NULL
      )
      SELECT id, count(*) OVER()::int AS total FROM violations ORDER BY id LIMIT 20
    `,
  },
  {
    key: "occurrence_in_multiple_active_incidents",
    description: "One occurrence identity must not belong to multiple active Incidents",
    evidence: "active incident occurrences grouped by request/attempt/transport identity",
    query: Prisma.sql`
      WITH violations AS (
        SELECT min(o.id) AS id
        FROM ops_incident_occurrences o
        JOIN ops_incidents i ON i.id = o."incidentId"
        WHERE i.status NOT IN ('resolved', 'closed')
        GROUP BY coalesce(o."transportExecutionId", o."attemptId", o."requestId", o."occurrenceKey")
        HAVING count(DISTINCT o."incidentId") > 1
      )
      SELECT id, count(*) OVER()::int AS total FROM violations ORDER BY id LIMIT 20
    `,
  },
  // SPEC: 投影去重不是靠事后数重复行守住的，是靠唯一索引 —— 所以这里查的是"那些索引还在吗"。
  // INTENT: 原先两条检查（duplicate_canonical_source_effect / chat_replay_duplicate_fact）分别
  //         GROUP BY 已有唯一索引覆盖的列 HAVING count(*) > 1。有索引在，它们**永远返回零行**：
  //         查的是一个已经不可表示的状态，报告里那两个 passed 是恒真的，不构成任何证据。
  //         真正会漂移的是索引本身被删/被改名。改成集合相等：期望的唯一约束集合必须恰好存在。
  {
    key: "projection_dedupe_constraint_missing",
    description:
      "Projector dedupe identities must stay database-enforced by unique constraints",
    evidence:
      "pg_indexes over metric_projection_receipts and chat_exchange_facts unique dedupe indexes",
    query: Prisma.sql`
      WITH expected(id, tablename, columns) AS (
        VALUES
          ('metric_projection_receipts:sourceService,sourceEventId',
            'metric_projection_receipts', ARRAY['sourceService', 'sourceEventId']),
          ('chat_exchange_facts:exchangeId', 'chat_exchange_facts', ARRAY['exchangeId']),
          ('chat_exchange_facts:sourceService,sourceEventId',
            'chat_exchange_facts', ARRAY['sourceService', 'sourceEventId'])
      ),
      present AS (
        SELECT c.relname::text AS tablename,
          array_agg(a.attname::text ORDER BY k.ord) AS columns
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
        WHERE i.indisunique AND i.indpred IS NULL
          AND n.nspname = current_schema()
          AND c.relname IN ('metric_projection_receipts', 'chat_exchange_facts')
        GROUP BY i.indexrelid, c.relname
      ),
      violations AS (
        SELECT e.id FROM expected e
        WHERE NOT EXISTS (
          SELECT 1 FROM present p
          WHERE p.tablename = e.tablename AND p.columns = e.columns
        )
      )
      SELECT id, count(*) OVER()::int AS total FROM violations ORDER BY id LIMIT 20
    `,
  },
  // SPEC: 宽限期一过，账号擦除必须在机器时间内走完，不能停在半路。
  // INTENT: 这条链路横跨两个服务四个阶段（等宽限 → Chat 擦除 → 删存储对象 → 主库硬删），
  //         而它的起点是一条 30 天后才到期的延迟 outbox。按下擦除的那个人早就不在了，
  //         完成时也不写任何审计 —— 请求那行审计的 targetId 还会在完成时被改写成不可逆的
  //         subject ref。于是「卡在第二阶段」这件事在这条不变式出现之前没有任何一页会说。
  //         注意 outbox_event_never_dispatched 拦不到它：那条只看 attempts=0，而投递成功
  //         之后 Chat 不回执、Blob 删不动、legal hold 挡住 finalize，都是 attempts≥1 的卡住。
  // INVARIANT: 判据里没有时间阈值 —— `graceEndsAt` 是产品自己承诺给用户的日子，
  //            过了还没 completed 就是欠着，这是结构事实不是「积压多久算久」的口味问题。
  //            正常路径实测从到期到完成约 8.5 秒，所以它不会因为「跑得慢」而误报。
  {
    key: "account_erasure_past_grace_not_completed",
    description: "Every account erasure must complete once its grace period ends",
    evidence: "account_deletions past graceEndsAt that are not completed",
    query: Prisma.sql`
      WITH violations AS (
        SELECT d.id
        FROM account_deletions d
        WHERE d.status <> 'completed' AND d."graceEndsAt" <= now()
      )
      SELECT id, count(*) OVER()::int AS total FROM violations ORDER BY id LIMIT 20
    `,
  },
  // SPEC: 系统自己下架的角色，要么被放回目录，要么有人明确决定让它留在目录外。
  // INTENT: `dispatchStaleReleaseRoutes` 在把 Release 打成 stale 的同一个事务里，
  //   会把正在服务它的公开角色降为 unlisted（release-monitor.ts:174-195）。
  //   Release 变 stale 会进 Today 队列（work-severity.ts:110），**下架这件事本身不会**：
  //   `live_public_current_release_not_ready` 只看 visibility='public'，降级之后它就不看了；
  //   `serving_default_route_unqualified` 又不检查资质背后的 profile 还在不在。
  //   于是修好 Release、队列清空之后，角色仍然在目录外，而没有任何一处会再提起它。
  //   实测库里这件事真发生过一次（alexa-reeves，2026-08-31，reason=generation_workflow_unavailable）。
  // INVARIANT: 判据不是「unlisted 就不对」—— 下架是合法的运营决定。判据是
  //   「系统降的级 + 角色现在已经健康 + 之后没有人对可见性做过决定」。最后那一条靠
  //   `content.visibility.write` 审计行排除：运营看过并决定继续隐藏，这条就不该再响。
  {
    key: "system_delisted_character_not_restored",
    description: "A Character the system delisted must be restored once it is healthy again",
    evidence: "character_release_events catalogVisibility=unlisted joined to a live, published, ready current Release with no later operator visibility decision",
    query: Prisma.sql`
      WITH delisted AS (
        SELECT e."characterId" AS character_id, max(e."occurredAt") AS at
        FROM character_release_events e
        WHERE e."toState"->>'catalogVisibility' = 'unlisted'
        GROUP BY e."characterId"
      )
      SELECT c.id, count(*) OVER()::int AS total
      FROM delisted d
      JOIN characters c ON c.id = d.character_id
      JOIN character_serving s ON s."characterId" = c.id
      JOIN character_releases r ON r.id = s."currentReleaseId"
      WHERE c.visibility = 'unlisted'
        AND c.status = 'approved'
        AND c."deletedAt" IS NULL
        AND s.state = 'live'
        AND r.status = 'published'
        AND r.readiness = 'ready'
        AND NOT EXISTS (
          SELECT 1 FROM admin_audit_logs a
          WHERE a.action = 'content.visibility.write'
            AND a."targetId" = c.id
            AND a."createdAt" > d.at
        )
      ORDER BY c.id LIMIT 20
    `,
  },
  {
    key: "payload_hash_conflict_not_quarantined",
    description: "Conflicting payload reuse must be quarantined",
    evidence: "InboundEventReceipt payload_hash_conflict requires processingState=quarantined",
    query: Prisma.sql`
      SELECT r.id, count(*) OVER()::int AS total
      FROM inbound_event_receipts r
      WHERE r.error->>'code' = 'payload_hash_conflict' AND r."processingState" <> 'quarantined'
      ORDER BY r.id LIMIT 20
    `,
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function hasCompleteGenerationProvenance(value: unknown) {
  if (!isRecord(value)) return false;
  if (value.schemaVersion === "character-release-generation-provenance-v2") {
    if (!isRecord(value.requiredReleaseRoute) || !isRecord(value.visualAuthority)) return false;
    const route = value.requiredReleaseRoute;
    const visual = value.visualAuthority;
    return isNonEmptyString(route.routeFingerprint)
      && isNonEmptyString(route.matrixKey)
      && isNonEmptyString(route.generationProfileKey)
      && isPositiveInteger(route.generationProfileVersion)
      && isNonEmptyString(route.workflowKey)
      && isPositiveInteger(route.workflowVersion)
      && isNonEmptyString(visual.visualProfileId)
      && isPositiveInteger(visual.visualProfileVersion)
      && isNonEmptyString(visual.visualProfileHash)
      && isNonEmptyString(visual.referenceSetRevisionId)
      && isNonEmptyString(visual.referenceSetHash);
  }
  return isNonEmptyString(value.routeFingerprint)
    && isNonEmptyString(value.matrixKey)
    && isNonEmptyString(value.generationProfileKey)
    && isPositiveInteger(value.generationProfileVersion)
    && isNonEmptyString(value.workflowKey)
    && isPositiveInteger(value.workflowVersion);
}

function hasCompletePlacementManifest(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.placements) || value.placements.length === 0) {
    return false;
  }
  const placementsAreComplete = value.placements.every((placement) =>
    isRecord(placement)
      && isNonEmptyString(placement.slotKey)
      && isNonEmptyString(placement.assetId)
      && isPositiveInteger(placement.slotVersion),
  );
  return placementsAreComplete && value.placements.some((placement) =>
    isRecord(placement) && placement.slotKey === "character_avatar",
  );
}

interface ViolationAccumulator {
  count: number;
  sampleIds: string[];
}

interface ServingRow {
  readonly id: string;
  readonly characterId: string;
  readonly currentReleaseId: string | null;
}

interface ServingReleaseViolations {
  readonly characterOrphan: ViolationAccumulator;
  readonly releaseOrphan: ViolationAccumulator;
  readonly crossCharacter: ViolationAccumulator;
  readonly joinInvalid: ViolationAccumulator;
  readonly currentIdentityInvalid: ViolationAccumulator;
  readonly currentManifestInvalid: ViolationAccumulator;
}

function emptyAccumulator(): ViolationAccumulator {
  return { count: 0, sampleIds: [] };
}

function recordViolation(accumulator: ViolationAccumulator, id: string) {
  accumulator.count += 1;
  if (accumulator.sampleIds.includes(id)) return;
  accumulator.sampleIds.push(id);
  accumulator.sampleIds.sort();
  if (accumulator.sampleIds.length > 20) accumulator.sampleIds.pop();
}

function invariantCheck(
  key: string,
  description: string,
  evidence: string,
  violations: ViolationAccumulator,
): AdminInvariantCheck {
  return {
    key,
    description,
    status: violations.count === 0 ? "passed" : "failed",
    violationCount: violations.count,
    sampleIds: violations.sampleIds,
    evidence,
  };
}

async function inspectServingReleaseBatch(
  db: InvariantDb,
  servingRows: readonly ServingRow[],
  violations: ServingReleaseViolations,
) {
  const characterIds = [...new Set(servingRows.map((serving) => serving.characterId))];
  const characters = await db.character.findMany({
    where: { id: { in: characterIds } },
    select: { id: true },
  });
  const existingCharacterIds = new Set(characters.map((character) => character.id));
  for (const serving of servingRows) {
    if (!existingCharacterIds.has(serving.characterId)) {
      recordViolation(violations.characterOrphan, `${serving.id}:${serving.characterId}`);
    }
  }
  const pointers: ServingPointer[] = servingRows.flatMap((serving) => {
    const result: ServingPointer[] = [];
    if (serving.currentReleaseId) {
      result.push({
        servingId: serving.id,
        characterId: serving.characterId,
        pointer: "current",
        releaseId: serving.currentReleaseId,
      });
    }
    return result;
  });
  const releaseIds = [...new Set(pointers.map((pointer) => pointer.releaseId))];
  const releases = await db.characterRelease.findMany({
    where: { id: { in: releaseIds } },
  });
  const releaseById = new Map(releases.map((release) => [release.id, release]));
  const publicQualifications = await db.publicCatalogQualification.findMany({
    where: { releaseId: { in: releaseIds } },
  });
  const publicQualificationByReleaseId = new Map(
    publicQualifications.map((qualification) => [
      qualification.releaseId,
      qualification,
    ]),
  );
  const projectIds = [...new Set(releases.map((release) => release.projectId))];
  const revisionIds = [...new Set(releases.map((release) => release.revisionId))];
  const contentIds = [...new Set(releases.map((release) => release.characterContentVersionId))];
  const profileIds = [...new Set(releases.flatMap((release) =>
    release.visualProfileId ? [release.visualProfileId] : [],
  ))];
  const referenceSetIds = [...new Set(releases.flatMap((release) =>
    release.referenceSetRevisionId ? [release.referenceSetRevisionId] : [],
  ))];
  const [projects, revisions, contents, profiles, referenceSets] = await Promise.all([
    db.characterProject.findMany({ where: { id: { in: projectIds } } }),
    db.characterRevision.findMany({ where: { id: { in: revisionIds } } }),
    db.characterContentVersion.findMany({ where: { id: { in: contentIds } } }),
    db.characterVisualProfile.findMany({ where: { id: { in: profileIds } } }),
    db.referenceSetRevision.findMany({
      where: { id: { in: referenceSetIds } },
      include: {
        references: {
          include: { mediaAsset: { select: { deletedAt: true } } },
          orderBy: { position: "asc" },
        },
      },
    }),
  ]);
  const projectById = new Map(projects.map((row) => [row.id, row]));
  const revisionById = new Map(revisions.map((row) => [row.id, row]));
  const contentById = new Map(contents.map((row) => [row.id, row]));
  const profileById = new Map(profiles.map((row) => [row.id, row]));
  const referenceSetById = new Map(referenceSets.map((row) => [row.id, row]));

  for (const pointer of pointers) {
    const release = releaseById.get(pointer.releaseId);
    if (!release) {
      recordViolation(
        violations.releaseOrphan,
        `${pointer.servingId}:${pointer.pointer}:${pointer.releaseId}`,
      );
      continue;
    }
    const project = projectById.get(release.projectId);
    const revision = revisionById.get(release.revisionId);
    const content = contentById.get(release.characterContentVersionId);
    if (project && project.characterId !== pointer.characterId) {
      recordViolation(violations.crossCharacter, release.id);
    }
    if (
      !project
      || !revision
      || !content
      || revision.projectId !== release.projectId
      || revision.characterContentVersionId !== release.characterContentVersionId
      || content.characterId !== project.characterId
    ) {
      recordViolation(violations.joinInvalid, release.id);
    }
    const provenance = isRecord(release.generationProvenance)
      ? release.generationProvenance
      : {};
    const publicQualification =
      publicQualificationByReleaseId.get(release.id);
    const editorialQualificationIsExact = Boolean(
      pointer.pointer === "current" &&
      release.legacy &&
      release.status === "published" &&
      release.publishedAt !== null &&
      release.readiness === "ready" &&
      release.visualProfileId === null &&
      release.visualProfileVersion === null &&
      release.referenceSetRevisionId === null &&
      provenance.schemaVersion === "character-release-editorial-import-v1" &&
      publicQualification?.kind === "editorial_import" &&
      publicQualification.validationRunId === null &&
      publicQualification.releaseSnapshotHash === release.snapshotHash &&
      publicQualification.revokedAt === null &&
      isRecord(publicQualification.evidence) &&
      publicQualification.evidence.schemaVersion ===
        "public-catalog-qualification-v1" &&
      publicQualification.evidence.policyVersion ===
        PUBLIC_CATALOG_EDITORIAL_IMPORT_POLICY_VERSION,
    );

    const profile = release.visualProfileId
      ? profileById.get(release.visualProfileId)
      : undefined;
    const referenceSet = release.referenceSetRevisionId
      ? referenceSetById.get(release.referenceSetRevisionId)
      : undefined;
    const currentVisualHash = profile
      ? characterVisualProfileSnapshotHash(profile)
      : null;
    const currentReferenceHash = referenceSet
      ? referenceSetSnapshotHash({
          visualProfileId: referenceSet.visualProfileId,
          revision: referenceSet.revision,
          selectorVersion: referenceSet.selectorVersion,
          references: referenceSet.references,
        })
      : null;
    const profileIsExact = Boolean(
      project
      && profile
      && release.visualProfileVersion === profile.version
      && profile.characterId === project.characterId
      && isNonEmptyString(profile.immutableHash)
      && profile.immutableHash === currentVisualHash,
    );
    const referenceIsExact = Boolean(
      profile
      && referenceSet
      && referenceSet.visualProfileId === profile.id
      && referenceSet.references.length > 0
      && referenceSet.references.every((reference) => reference.mediaAsset.deletedAt === null)
      && isNonEmptyString(referenceSet.snapshotHash)
      && referenceSet.snapshotHash === currentReferenceHash,
    );
    if (
      !editorialQualificationIsExact &&
      (!profileIsExact || !referenceIsExact)
    ) {
      recordViolation(violations.currentIdentityInvalid, release.id);
    }

    const snapshotHash = characterReleaseSnapshotHash({
      projectId: release.projectId,
      revisionId: release.revisionId,
      characterContentVersionId: release.characterContentVersionId,
      visualProfileId: release.visualProfileId,
      visualProfileVersion: release.visualProfileVersion,
      referenceSetRevisionId: release.referenceSetRevisionId,
      generationProvenance: release.generationProvenance,
      releasePlacementManifest: release.releasePlacementManifest,
    });
    const manifestIsComplete = editorialQualificationIsExact
      ? hasCompletePlacementManifest(release.releasePlacementManifest) &&
        isNonEmptyString(release.snapshotHash) &&
        release.snapshotHash === snapshotHash
      : hasCompleteGenerationProvenance(release.generationProvenance) &&
        hasCompletePlacementManifest(release.releasePlacementManifest) &&
        isNonEmptyString(release.snapshotHash) &&
        release.snapshotHash === snapshotHash &&
        release.status === "published";
    if (!manifestIsComplete) {
      recordViolation(violations.currentManifestInvalid, release.id);
    }
  }
}

async function runServingReleaseChecks(db: InvariantDb): Promise<AdminInvariantCheck[]> {
  const violations: ServingReleaseViolations = {
    characterOrphan: emptyAccumulator(),
    releaseOrphan: emptyAccumulator(),
    crossCharacter: emptyAccumulator(),
    joinInvalid: emptyAccumulator(),
    currentIdentityInvalid: emptyAccumulator(),
    currentManifestInvalid: emptyAccumulator(),
  };
  let afterId: string | undefined;
  while (true) {
    const servingRows = await db.characterServing.findMany({
      where: afterId ? { id: { gt: afterId } } : undefined,
      orderBy: { id: "asc" },
      take: 250,
      select: {
        id: true,
        characterId: true,
        currentReleaseId: true,
      },
    });
    if (servingRows.length === 0) break;
    await inspectServingReleaseBatch(db, servingRows, violations);
    afterId = servingRows.at(-1)?.id;
  }

  return [
    invariantCheck(
      "serving_character_pointer_orphan",
      "Every CharacterServing row must resolve to an existing Character",
      "CharacterServing.characterId existence required before validating its NOT VALID foreign key",
      violations.characterOrphan,
    ),
    invariantCheck(
      "serving_release_pointer_orphan",
      "Serving pointers must resolve to an existing CharacterRelease",
      "CharacterServing current pointer existence checked without inner-join elision",
      violations.releaseOrphan,
    ),
    invariantCheck(
      "serving_release_cross_character",
      "Serving pointers must not reference another Character's Release",
      "CharacterServing pointer -> CharacterRelease -> CharacterProject.characterId",
      violations.crossCharacter,
    ),
    invariantCheck(
      "serving_release_revision_content_join_invalid",
      "Serving Releases require exact Project, Revision, and CharacterContentVersion joins",
      "Release revision/project/content IDs and Character ownership checked as one authority chain",
      violations.joinInvalid,
    ),
    invariantCheck(
      "current_release_missing_exact_identity_or_reference",
      "Current Releases require exact immutable Identity and non-empty ReferenceSet snapshots",
      "VisualProfile character/version/canonical immutableHash and ReferenceSet canonical snapshotHash",
      violations.currentIdentityInvalid,
    ),
    invariantCheck(
      "current_release_incomplete_manifest",
      "Current Releases must be published immutable snapshots with complete provenance and placement manifests",
      "Canonical Release snapshotHash plus required provenance, avatar placement, and slot identity",
      violations.currentManifestInvalid,
    ),
  ];
}

async function runSqlCheck(db: InvariantDb, check: SqlInvariant): Promise<AdminInvariantCheck> {
  const rows = await db.$queryRaw<ViolationRow[]>(check.query);
  const count = rows[0]?.total ?? 0;
  return {
    key: check.key,
    description: check.description,
    status: count === 0 ? "passed" : "failed",
    violationCount: count,
    sampleIds: rows.map((row) => row.id),
    evidence: check.evidence,
  };
}

export async function auditAdminCutoverInvariants(db: InvariantDb, asOf = new Date()) {
  const [sqlResults, releaseResults] = await Promise.all([
    Promise.all([...sqlChecks, {
      key: "voice_request_requires_recovery",
      description: "Unknown provider outcomes and expired voice leases require operational attention",
      evidence: "VoiceClipRequest provider_outcome_unknown or running lease expired at report asOf",
      query: Prisma.sql`
        SELECT r.id, count(*) OVER()::int AS total
        FROM voice_clip_requests r
        WHERE r."errorCode" = 'provider_outcome_unknown'
          OR (r.status = 'running' AND (r."leaseExpiresAt" IS NULL OR r."leaseExpiresAt" <= ${asOf}))
        ORDER BY r.id LIMIT 20
      `,
    }].map((check) => runSqlCheck(db, check))),
    runServingReleaseChecks(db),
  ]);
  const checks = [...sqlResults, ...releaseResults];
  const totalViolations = checks.reduce((sum, check) => sum + (check.violationCount ?? 0), 0);
  const unavailableChecks = checks.filter((check) => check.status === "unavailable").length;
  const qualityState = totalViolations === 0 && unavailableChecks === 0 ? "certified" as const : "invalid" as const;
  for (const check of checks) {
    setGauge(
      "admin_state_invariant_violation_total",
      "Current Admin cutover invariant violations",
      { invariant: check.key },
      check.violationCount ?? 0,
    );
  }
  setGauge(
    "admin_state_invariant_violation_total",
    "Current Admin cutover invariant violations",
    { invariant: "all" },
    totalViolations,
  );
  return adminInvariantReportSchema.parse({
    asOf: asOf.toISOString(),
    qualityState,
    decisionUse: qualityState === "certified" ? "allowed" : "blocked",
    totalViolations,
    unavailableChecks,
    checks,
  });
}

export async function getAdminCutoverInvariantReport(request: Request) {
  await actorWithPermission(request, "analytics.metric.read");
  return ok(await auditAdminCutoverInvariants(prisma), { headers: { "cache-control": "no-store" } });
}
