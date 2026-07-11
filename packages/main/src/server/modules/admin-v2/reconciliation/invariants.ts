import {
  adminInvariantReportSchema,
  setGauge,
  type AdminInvariantCheck,
} from "@idream/shared";
import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { ok } from "@/server/lib/http";
import { actorWithPermission } from "@/server/modules/admin/service";
import { CHARACTER_RELEASE_POLICY_VERSION } from "../characters/release-executor";

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

const sqlChecks: readonly SqlInvariant[] = [
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
    key: "serving_release_cross_character",
    description: "Serving pointers must not reference another Character's Release",
    evidence: "CharacterServing pointer -> CharacterRelease -> CharacterProject.characterId",
    query: Prisma.sql`
      SELECT (s.id || ':' || r.id) AS id, count(*) OVER()::int AS total
      FROM character_serving s
      JOIN character_releases r ON r.id IN (s."currentReleaseId", s."scheduledReleaseId")
      JOIN character_projects p ON p.id = r."projectId"
      WHERE p."characterId" <> s."characterId"
      ORDER BY s.id LIMIT 20
    `,
  },
  {
    key: "current_release_incomplete_manifest",
    description: "Current Releases must be published immutable snapshots with complete manifests",
    evidence: "current CharacterRelease required snapshot/content/visual/reference/placement fields",
    query: Prisma.sql`
      SELECT r.id, count(*) OVER()::int AS total
      FROM character_serving s
      JOIN character_releases r ON r.id = s."currentReleaseId"
      WHERE r.status <> 'published' OR length(r."snapshotHash") = 0
        OR r."characterContentVersionId" IS NULL
        OR r."visualProfileId" IS NULL OR r."visualProfileVersion" IS NULL
        OR r."referenceSetRevisionId" IS NULL
        OR jsonb_typeof(r."generationProvenance") <> 'object'
        OR jsonb_typeof(r."releasePlacementManifest") <> 'object'
      ORDER BY r.id LIMIT 20
    `,
  },
  {
    key: "serving_validation_stale",
    description: "Current and scheduled Releases require a passing validation for the exact snapshot and policy",
    evidence: `ReleaseValidationRun snapshotHash + ${CHARACTER_RELEASE_POLICY_VERSION}`,
    query: Prisma.sql`
      SELECT r.id, count(*) OVER()::int AS total
      FROM character_serving s
      JOIN character_releases r ON r.id IN (s."currentReleaseId", s."scheduledReleaseId")
      WHERE NOT EXISTS (
        SELECT 1 FROM release_validation_runs v
        WHERE v."releaseId" = r.id AND v."snapshotHash" = r."snapshotHash"
          AND v."policyVersion" = ${CHARACTER_RELEASE_POLICY_VERSION}
          AND v.result = 'passed' AND v."finishedAt" IS NOT NULL
      )
      ORDER BY r.id LIMIT 20
    `,
  },
  {
    key: "serving_default_route_unqualified",
    description: "A live default generation route must satisfy its current qualification",
    evidence: "Release generationProvenance routeFingerprint/matrixKey joined to non-expired qualification",
    query: Prisma.sql`
      SELECT r.id, count(*) OVER()::int AS total
      FROM character_serving s
      JOIN character_releases r ON r.id = s."currentReleaseId"
      WHERE r.legacy = false AND NOT EXISTS (
        SELECT 1 FROM generation_route_qualifications q
        WHERE q."routeFingerprint" = r."generationProvenance"->>'routeFingerprint'
          AND q."matrixKey" = r."generationProvenance"->>'matrixKey'
          AND q.result = 'qualified' AND q."sampleCount" >= 40 AND q."identityMatch" >= 0.9
          AND (q."expiresAt" IS NULL OR q."expiresAt" > now())
      )
      ORDER BY r.id LIMIT 20
    `,
  },
  {
    key: "current_release_missing_exact_identity_or_reference",
    description: "Current non-legacy Releases require exact Identity and ReferenceSet revisions",
    evidence: "CharacterRelease immutable visualProfile version and referenceSetRevisionId",
    query: Prisma.sql`
      SELECT r.id, count(*) OVER()::int AS total
      FROM character_serving s
      JOIN character_releases r ON r.id = s."currentReleaseId"
      WHERE r.legacy = false AND (
        r."visualProfileId" IS NULL OR r."visualProfileVersion" IS NULL OR r."referenceSetRevisionId" IS NULL
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
      WHERE a.status IN ('succeeded', 'failed', 'cancelled', 'unknown')
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
    evidence: "latest succeeded GenerationAttempt requestId joined to GenerationJob.outputCount and delivered rows",
    query: Prisma.sql`
      SELECT a."requestId" AS id, count(*) OVER()::int AS total
      FROM generation_attempts a
      JOIN generation_jobs j ON j.id = a."requestId"
      LEFT JOIN generation_deliveries d ON d."requestId" = a."requestId" AND d.status = 'delivered'
      WHERE a.status = 'succeeded'
      GROUP BY a."requestId", j."outputCount"
      HAVING count(d.id) <> j."outputCount"
      ORDER BY a."requestId" LIMIT 20
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
  {
    key: "duplicate_active_case",
    description: "A Case identity may have at most one active aggregate",
    evidence: "active admin_cases grouped by type/target/caseKey",
    query: Prisma.sql`
      WITH violations AS (
        SELECT min(id) AS id FROM admin_cases
        WHERE status NOT IN ('closed', 'resolved')
        GROUP BY type, "targetType", "targetId", "caseKey" HAVING count(*) > 1
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
  {
    key: "duplicate_canonical_source_effect",
    description: "A canonical source event may produce at most one projector effect",
    evidence: "metric_projection_receipts grouped by sourceService/sourceEventId",
    query: Prisma.sql`
      WITH violations AS (
        SELECT min(id) AS id FROM metric_projection_receipts
        GROUP BY "sourceService", "sourceEventId" HAVING count(*) > 1
      )
      SELECT id, count(*) OVER()::int AS total FROM violations ORDER BY id LIMIT 20
    `,
  },
  {
    key: "chat_replay_duplicate_fact",
    description: "Chat event replay must not create duplicate exchange facts",
    evidence: "chat_exchange_facts grouped independently by exchangeId and canonical source identity",
    query: Prisma.sql`
      WITH violations AS (
        SELECT min(id) AS id FROM chat_exchange_facts GROUP BY "exchangeId" HAVING count(*) > 1
        UNION ALL
        SELECT min(id) AS id FROM chat_exchange_facts
        GROUP BY "sourceService", "sourceEventId" HAVING count(*) > 1
      )
      SELECT id, count(*) OVER()::int AS total FROM violations ORDER BY id LIMIT 20
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

async function runSqlCheck(db: PrismaClient, check: SqlInvariant): Promise<AdminInvariantCheck> {
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

export async function auditAdminCutoverInvariants(db: PrismaClient, asOf = new Date()) {
  const checks = await Promise.all(sqlChecks.map((check) => runSqlCheck(db, check)));
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
