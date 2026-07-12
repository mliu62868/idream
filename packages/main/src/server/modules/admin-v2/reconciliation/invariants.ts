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
import {
  characterReleaseSnapshotHash,
  characterVisualProfileSnapshotHash,
  referenceSetSnapshotHash,
} from "../characters/release-snapshot";

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
  | "characterProject"
  | "characterRevision"
  | "characterContentVersion"
  | "characterVisualProfile"
  | "referenceSetRevision"
>;

type ServingPointer = {
  readonly servingId: string;
  readonly characterId: string;
  readonly pointer: "current" | "scheduled";
  readonly releaseId: string;
};

const sqlChecks: readonly SqlInvariant[] = [
  {
    key: "character_project_orphan",
    description: "Every CharacterProject must resolve to its Character authority",
    evidence: "character_projects.characterId joined to characters.id",
    query: Prisma.sql`
      SELECT p.id, count(*) OVER()::int AS total
      FROM character_projects p
      LEFT JOIN characters c ON c.id = p."characterId"
      WHERE c.id IS NULL
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
      WHERE NOT EXISTS (
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
            WHEN total_items > 0 AND reviewed_items = total_items THEN 'completed'
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
  if (!isRecord(value) || !isRecord(value.characterQa)) return false;
  return isNonEmptyString(value.routeFingerprint)
    && isNonEmptyString(value.matrixKey)
    && isNonEmptyString(value.generationProfileKey)
    && isPositiveInteger(value.generationProfileVersion)
    && isNonEmptyString(value.workflowKey)
    && isPositiveInteger(value.workflowVersion)
    && value.characterQa.status === "passed"
    && isNonEmptyString(value.characterQa.evidenceRef);
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
  readonly scheduledReleaseId: string | null;
}

interface ServingReleaseViolations {
  readonly characterOrphan: ViolationAccumulator;
  readonly releaseOrphan: ViolationAccumulator;
  readonly crossCharacter: ViolationAccumulator;
  readonly joinInvalid: ViolationAccumulator;
  readonly currentIdentityInvalid: ViolationAccumulator;
  readonly scheduledIdentityInvalid: ViolationAccumulator;
  readonly currentManifestInvalid: ViolationAccumulator;
  readonly scheduledManifestInvalid: ViolationAccumulator;
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
    if (serving.scheduledReleaseId) {
      result.push({
        servingId: serving.id,
        characterId: serving.characterId,
        pointer: "scheduled",
        releaseId: serving.scheduledReleaseId,
      });
    }
    return result;
  });
  const releaseIds = [...new Set(pointers.map((pointer) => pointer.releaseId))];
  const releases = await db.characterRelease.findMany({
    where: { id: { in: releaseIds } },
  });
  const releaseById = new Map(releases.map((release) => [release.id, release]));
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

    {
      const profile = release.visualProfileId
        ? profileById.get(release.visualProfileId)
        : undefined;
      const referenceSet = release.referenceSetRevisionId
        ? referenceSetById.get(release.referenceSetRevisionId)
        : undefined;
      const profileIsExact = Boolean(
        project
        && profile
        && release.visualProfileVersion === profile.version
        && profile.characterId === project.characterId
        && isNonEmptyString(profile.immutableHash)
        && profile.immutableHash === characterVisualProfileSnapshotHash(profile),
      );
      const referenceIsExact = Boolean(
        profile
        && referenceSet
        && referenceSet.visualProfileId === profile.id
        && referenceSet.references.length > 0
        && referenceSet.references.every((reference) => reference.mediaAsset.deletedAt === null)
        && isNonEmptyString(referenceSet.snapshotHash)
        && referenceSet.snapshotHash === referenceSetSnapshotHash({
          visualProfileId: referenceSet.visualProfileId,
          revision: referenceSet.revision,
          selectorVersion: referenceSet.selectorVersion,
          references: referenceSet.references,
        }),
      );
      if (!profileIsExact || !referenceIsExact) {
        recordViolation(
          pointer.pointer === "current"
            ? violations.currentIdentityInvalid
            : violations.scheduledIdentityInvalid,
          release.id,
        );
      }
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
    const manifestIsComplete = hasCompleteGenerationProvenance(release.generationProvenance)
      && hasCompletePlacementManifest(release.releasePlacementManifest)
      && isNonEmptyString(release.snapshotHash)
      && release.snapshotHash === snapshotHash
      && (pointer.pointer === "current"
        ? release.status === "published"
        : release.status === "approved");
    if (!manifestIsComplete) {
      recordViolation(
        pointer.pointer === "current"
          ? violations.currentManifestInvalid
          : violations.scheduledManifestInvalid,
        release.id,
      );
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
    scheduledIdentityInvalid: emptyAccumulator(),
    currentManifestInvalid: emptyAccumulator(),
    scheduledManifestInvalid: emptyAccumulator(),
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
        scheduledReleaseId: true,
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
      "CharacterServing current/scheduled pointer existence checked without inner-join elision",
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
      "scheduled_release_missing_exact_identity_or_reference",
      "Scheduled Releases require exact immutable Identity and non-empty ReferenceSet snapshots",
      "VisualProfile character/version/canonical immutableHash and ReferenceSet canonical snapshotHash",
      violations.scheduledIdentityInvalid,
    ),
    invariantCheck(
      "current_release_incomplete_manifest",
      "Current Releases must be published immutable snapshots with complete provenance and placement manifests",
      "Canonical Release snapshotHash plus required provenance, QA, avatar placement, and slot identity",
      violations.currentManifestInvalid,
    ),
    invariantCheck(
      "scheduled_release_incomplete_manifest",
      "Scheduled Releases must be immutable snapshots with complete provenance and placement manifests",
      "Canonical Release snapshotHash plus required provenance, QA, avatar placement, and slot identity",
      violations.scheduledManifestInvalid,
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
    Promise.all(sqlChecks.map((check) => runSqlCheck(db, check))),
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
