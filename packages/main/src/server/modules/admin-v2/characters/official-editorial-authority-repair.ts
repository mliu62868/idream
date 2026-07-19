import { Prisma, type PrismaClient } from "@prisma/client";
import { canonicalSha256 } from "../shared/canonical-json";
import { toInputJson } from "../shared/prisma-json";
import {
  evaluateEditorialReleaseAuthority,
  evaluateEditorialReleaseAuthorityInTransaction,
  type EditorialReleaseAuthorityResult,
} from "@/server/modules/ourdream/public-release-authority";

export const OFFICIAL_EDITORIAL_AUTHORITY_REPAIR_DOMAIN =
  "official_editorial_release_v1";

type RepairMode = "dry_run" | "apply";

interface RepairSummary {
  readonly scanned: number;
  readonly valid: number;
  readonly repairable: number;
  readonly applied: number;
  readonly rejected: number;
}

export interface OfficialEditorialAuthorityRepairResult {
  readonly runId: string;
  readonly mode: RepairMode;
  readonly status: "completed";
  readonly summary: RepairSummary;
  readonly reportHash: string;
  readonly candidates: readonly {
    readonly releaseId: string;
    readonly characterId: string | null;
    readonly assetId: string | null;
    readonly classification: "valid" | "repairable" | "rejected";
    readonly failureCodes: readonly string[];
  }[];
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function persistedResult(
  run: Awaited<ReturnType<PrismaClient["adminBackfillRun"]["findUniqueOrThrow"]>>,
): OfficialEditorialAuthorityRepairResult {
  const summary = record(run.summary);
  const report = record(run.report);
  const candidates = Array.isArray(report.candidates)
    ? report.candidates as OfficialEditorialAuthorityRepairResult["candidates"]
    : [];
  return {
    runId: run.id,
    mode: run.mode === "apply" ? "apply" : "dry_run",
    status: "completed",
    summary: {
      scanned: numberValue(summary.scanned),
      valid: numberValue(summary.valid),
      repairable: numberValue(summary.repairable),
      applied: numberValue(summary.applied),
      rejected: numberValue(summary.rejected),
    },
    reportHash: run.reportHash ?? "",
    candidates,
  };
}

async function listCandidateReleaseIds(
  db: PrismaClient,
  releaseIds?: readonly string[],
) {
  const servings = await db.characterServing.findMany({
    where: {
      state: "live",
      currentReleaseId: { not: null },
      character: {
        is: {
          source: "official",
          status: "approved",
          visibility: "public",
          deletedAt: null,
        },
      },
      currentRelease: {
        is: {
          legacy: true,
          status: "published",
          generationProvenance: {
            path: ["schemaVersion"],
            equals: "character-release-editorial-import-v1",
          },
        },
      },
      ...(releaseIds ? { currentReleaseId: { in: [...releaseIds] } } : {}),
    },
    select: { currentReleaseId: true },
    orderBy: { characterId: "asc" },
  });
  return servings.flatMap((serving) =>
    serving.currentReleaseId ? [serving.currentReleaseId] : [],
  );
}

async function hasExactFalseStalenessEvidence(
  tx: Prisma.TransactionClient,
  authority: EditorialReleaseAuthorityResult,
) {
  const staleEvent = await tx.characterReleaseEvent.findFirst({
    where: {
      releaseId: authority.releaseId,
      type: "generation_route_qualification_stale",
      reason: "missing_qualification",
    },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
  });
  const monitor = await tx.releaseMonitor.findUnique({
    where: {
      releaseId_window: {
        releaseId: authority.releaseId,
        window: "route_qualification",
      },
    },
  });
  const observed = record(monitor?.observed);
  return {
    eligible: Boolean(
      staleEvent &&
        monitor &&
        monitor.status === "action_required" &&
        observed.reason === "missing_qualification",
    ),
    staleEvent,
    monitor,
  };
}

async function applyExactRepair(
  db: PrismaClient,
  input: {
    readonly runId: string;
    readonly releaseId: string;
    readonly now: Date;
  },
) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw(
      Prisma.sql`
        SELECT id
        FROM character_releases
        WHERE id = ${input.releaseId}
        FOR UPDATE
      `,
    );
    const authority =
      await evaluateEditorialReleaseAuthorityInTransaction(tx, {
        releaseId: input.releaseId,
      });
    const evidence = await hasExactFalseStalenessEvidence(tx, authority);
    if (
      !authority.repairable ||
      !authority.characterId ||
      !authority.assetId ||
      !evidence.eligible ||
      !evidence.monitor
    ) {
      return {
        applied: false,
        authority,
        action: "rejected_after_lock",
      } as const;
    }
    const release = await tx.characterRelease.findUniqueOrThrow({
      where: { id: authority.releaseId },
      select: { readiness: true, version: true },
    });
    const asset = await tx.mediaAsset.findUniqueOrThrow({
      where: { id: authority.assetId },
      select: { characterId: true },
    });
    if (asset.characterId === null) {
      const assetAttached = await tx.mediaAsset.updateMany({
        where: {
          id: authority.assetId,
          characterId: null,
        },
        data: { characterId: authority.characterId },
      });
      if (assetAttached.count !== 1) {
        throw new Error(
          `Editorial asset ${authority.assetId} changed during authority repair`,
        );
      }
    } else if (asset.characterId !== authority.characterId) {
      throw new Error(
        `Editorial asset ${authority.assetId} belongs to another Character`,
      );
    }
    const releaseRestored = await tx.characterRelease.updateMany({
      where: {
        id: authority.releaseId,
        readiness: "stale",
        version: release.version,
      },
      data: {
        readiness: "ready",
        version: { increment: 1 },
      },
    });
    if (releaseRestored.count !== 1) {
      throw new Error(
        `Editorial Release ${authority.releaseId} changed during authority repair`,
      );
    }
    const previousVerification = record(evidence.monitor.verification);
    await tx.releaseMonitor.update({
      where: { id: evidence.monitor.id },
      data: {
        status: "completed",
        verification: toInputJson({
          ...previousVerification,
          classification: "not_applicable",
          repairDomain: OFFICIAL_EDITORIAL_AUTHORITY_REPAIR_DOMAIN,
          repairRunId: input.runId,
          repairedAt: input.now.toISOString(),
          reason:
            "editorial_imports_do_not_use_generation_route_qualification",
        }),
        leaseOwner: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
        lastError: Prisma.DbNull,
        finishedAt: input.now,
      },
    });
    await tx.characterReleaseEvent.create({
      data: {
        releaseId: authority.releaseId,
        characterId: authority.characterId,
        type: "editorial_import_route_staleness_repaired",
        actorId: "system:official-editorial-authority-repair",
        reason:
          "editorial_imports_do_not_use_generation_route_qualification",
        fromState: toInputJson({
          readiness: release.readiness,
          releaseVersion: release.version,
          assetCharacterId: asset.characterId,
          routeMonitorStatus: evidence.monitor.status,
        }),
        toState: toInputJson({
          readiness: "ready",
          releaseVersion: release.version + 1,
          assetCharacterId: authority.characterId,
          routeMonitorStatus: "completed",
        }),
        evidence: toInputJson({
          repairDomain: OFFICIAL_EDITORIAL_AUTHORITY_REPAIR_DOMAIN,
          repairRunId: input.runId,
          staleEventId: evidence.staleEvent?.id ?? null,
          routeMonitorId: evidence.monitor.id,
          qualificationKind: "editorial_import",
        }),
        occurredAt: input.now,
      },
    });
    await tx.adminAuditLog.create({
      data: {
        actorId: "system:official-editorial-authority-repair",
        actorRole: "system",
        action: "character.editorial_authority.repaired",
        targetType: "character_release",
        targetId: authority.releaseId,
        reason:
          "Restore exact editorial authority after route-monitor misclassification",
        before: toInputJson({
          readiness: release.readiness,
          releaseVersion: release.version,
          assetCharacterId: asset.characterId,
        }),
        after: toInputJson({
          readiness: "ready",
          releaseVersion: release.version + 1,
          assetCharacterId: authority.characterId,
        }),
        requestId: input.runId,
      },
    });
    await tx.mainOutboxEvent.create({
      data: {
        eventType: "character.editorial_authority_repaired.v1",
        aggregateType: "character_release",
        aggregateId: authority.releaseId,
        status: "delivered",
        deliveredAt: input.now,
        payload: toInputJson({
          releaseId: authority.releaseId,
          characterId: authority.characterId,
          assetId: authority.assetId,
          repairRunId: input.runId,
          occurredAt: input.now.toISOString(),
        }),
      },
    });
    const verified =
      await evaluateEditorialReleaseAuthorityInTransaction(tx, {
        releaseId: input.releaseId,
      });
    if (!verified.valid) {
      throw new Error(
        `Editorial Release ${input.releaseId} failed post-repair authority verification: ${verified.failures
          .map((item) => item.code)
          .join(",")}`,
      );
    }
    return {
      applied: true,
      authority: verified,
      action: "restored_exact_editorial_authority",
    } as const;
  });
}

export async function runOfficialEditorialAuthorityRepair(
  db: PrismaClient,
  input: {
    readonly mode: RepairMode;
    readonly runId?: string;
    readonly now?: Date;
    readonly releaseIds?: readonly string[];
  },
): Promise<OfficialEditorialAuthorityRepairResult> {
  if (input.runId) {
    const existing = await db.adminBackfillRun.findUnique({
      where: { id: input.runId },
    });
    if (existing) {
      if (
        existing.domain !== OFFICIAL_EDITORIAL_AUTHORITY_REPAIR_DOMAIN ||
        existing.mode !== input.mode ||
        existing.status !== "completed"
      ) {
        throw new Error(
          `Backfill run ${input.runId} does not match a completed ${input.mode} editorial repair`,
        );
      }
      return persistedResult(existing);
    }
  }

  const now = input.now ?? new Date();
  const releaseIds = await listCandidateReleaseIds(db, input.releaseIds);
  const before = {
    liveOfficialEditorialReleases: releaseIds.length,
  };
  const run = await db.adminBackfillRun.create({
    data: {
      ...(input.runId ? { id: input.runId } : {}),
      domain: OFFICIAL_EDITORIAL_AUTHORITY_REPAIR_DOMAIN,
      mode: input.mode,
      status: "running",
      batchSize: Math.max(1, releaseIds.length),
      optionsHash: canonicalSha256({
        domain: OFFICIAL_EDITORIAL_AUTHORITY_REPAIR_DOMAIN,
        mode: input.mode,
        releaseIds,
      }),
      before: toInputJson(before),
      after: toInputJson({}),
      summary: toInputJson({
        scanned: 0,
        valid: 0,
        repairable: 0,
        applied: 0,
        rejected: 0,
      }),
    },
  });

  let valid = 0;
  let repairable = 0;
  let applied = 0;
  let rejected = 0;
  const candidates: Array<
    OfficialEditorialAuthorityRepairResult["candidates"][number]
  > = [];

  for (const releaseId of releaseIds) {
    const authority = await evaluateEditorialReleaseAuthority(db, {
      releaseId,
    });
    const falseStaleness = await db.$transaction((tx) =>
      hasExactFalseStalenessEvidence(tx, authority),
    );
    const eligible = authority.repairable && falseStaleness.eligible;
    let action = authority.valid
      ? "no_change"
      : eligible
        ? input.mode === "dry_run"
          ? "would_restore_exact_editorial_authority"
          : "restore_exact_editorial_authority"
        : "manual_review_required";
    let finalAuthority = authority;
    let itemApplied = false;

    if (authority.valid) {
      valid += 1;
    } else if (eligible) {
      repairable += 1;
      if (input.mode === "apply") {
        const repaired = await applyExactRepair(db, {
          runId: run.id,
          releaseId,
          now,
        });
        action = repaired.action;
        finalAuthority = repaired.authority;
        itemApplied = repaired.applied;
        if (repaired.applied) {
          applied += 1;
          valid += 1;
        } else {
          rejected += 1;
        }
      }
    } else {
      rejected += 1;
    }

    const classification = finalAuthority.valid
      ? "valid"
      : eligible
        ? "repairable"
        : "rejected";
    const candidate = {
      releaseId,
      characterId: finalAuthority.characterId,
      assetId: finalAuthority.assetId,
      classification,
      failureCodes: finalAuthority.failures.map((item) => item.code),
    } as const;
    candidates.push(candidate);
    const beforeItem = {
      valid: authority.valid,
      repairable: eligible,
      failures: authority.failures,
      falseStalenessEventId: falseStaleness.staleEvent?.id ?? null,
      routeMonitorId: falseStaleness.monitor?.id ?? null,
    };
    const afterItem = {
      valid: finalAuthority.valid,
      failures: finalAuthority.failures,
    };
    await db.adminBackfillItem.create({
      data: {
        runId: run.id,
        entityType: "character_release",
        entityId: releaseId,
        classification,
        action,
        before: toInputJson(beforeItem),
        after: toInputJson(afterItem),
        mismatches: toInputJson(
          finalAuthority.failures.map((item) => ({
            code: item.code,
            evidence: item.evidence,
          })),
        ),
        checksum: canonicalSha256({
          releaseId,
          classification,
          action,
          beforeItem,
          afterItem,
          itemApplied,
        }),
        applied: itemApplied,
      },
    });
  }

  const summary: RepairSummary = {
    scanned: releaseIds.length,
    valid,
    repairable,
    applied,
    rejected,
  };
  const report = {
    domain: OFFICIAL_EDITORIAL_AUTHORITY_REPAIR_DOMAIN,
    mode: input.mode,
    candidates,
  };
  const reportHash = canonicalSha256(report);
  const validAfter = await Promise.all(
    releaseIds.map((releaseId) =>
      evaluateEditorialReleaseAuthority(db, { releaseId }),
    ),
  );
  await db.adminBackfillRun.update({
    where: { id: run.id },
    data: {
      status: "completed",
      cursor: releaseIds.at(-1) ?? null,
      summary: toInputJson(summary),
      after: toInputJson({
        liveOfficialEditorialReleases: releaseIds.length,
        validEditorialAuthorities: validAfter.filter(
          (authority) => authority.valid,
        ).length,
      }),
      report: toInputJson(report),
      reportHash,
      finishedAt: now,
    },
  });
  return {
    runId: run.id,
    mode: input.mode,
    status: "completed",
    summary,
    reportHash,
    candidates,
  };
}
