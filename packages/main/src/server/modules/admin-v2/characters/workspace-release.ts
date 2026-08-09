import type { Prisma } from "@prisma/client";
import { jsonRecord as record } from "../shared/prisma-json";

type WorkspaceRelease = {
  id: string;
  projectId: string;
  revisionId: string;
  characterContentVersionId: string;
  visualProfileId: string | null;
  visualProfileVersion: number | null;
  referenceSetRevisionId: string | null;
  generationProvenance: Prisma.JsonValue;
  releasePlacementManifest: Prisma.JsonValue;
  snapshotHash: string;
  readiness: string;
  legacy: boolean;
  status: string;
  publishedAt: Date | null;
  supersedesId: string | null;
  rollbackOfReleaseId: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

function releaseDto(release: WorkspaceRelease) {
  return {
    ...release,
    generationProvenance: record(release.generationProvenance),
    releasePlacementManifest: record(release.releasePlacementManifest),
    publishedAt: release.publishedAt?.toISOString() ?? null,
    createdAt: release.createdAt.toISOString(),
    updatedAt: release.updatedAt.toISOString(),
  };
}

export function servingDto(serving: {
  characterId: string;
  state: string;
  currentReleaseId: string | null;
  scheduledReleaseId: string | null;
  scheduledAt: Date | null;
  version: number;
  updatedAt: Date;
} | null) {
  return serving ? {
    characterId: serving.characterId,
    state: serving.state,
    currentReleaseId: serving.currentReleaseId,
    scheduledReleaseId: serving.scheduledReleaseId,
    scheduledAt: serving.scheduledAt?.toISOString() ?? null,
    version: serving.version,
    updatedAt: serving.updatedAt.toISOString(),
  } : null;
}

// INVARIANT: validationRuns 按 startedAt 倒序传入——每个 Release 只投影最新那次校验的
// checks，靠的就是 find 命中第一条。
export function characterWorkspaceReleaseProjection(input: {
  readonly releases: readonly WorkspaceRelease[];
  readonly validationRuns: readonly { id: string; releaseId: string }[];
  readonly checks: readonly {
    validationRunId: string;
    checkKey: string;
    result: string;
    evidence: Prisma.JsonValue;
    checkedAt: Date;
  }[];
  readonly monitors: readonly {
    id: string;
    releaseId: string;
    window: string;
    status: string;
    baseline: Prisma.JsonValue;
    observed: Prisma.JsonValue;
    verification: Prisma.JsonValue;
    startedAt: Date;
    finishedAt: Date | null;
  }[];
}) {
  return input.releases.map((release) => {
    const validation = input.validationRuns.find((run) => run.releaseId === release.id);
    return {
      release: releaseDto(release),
      checks: validation ? input.checks.filter((check) => check.validationRunId === validation.id).map((check) => ({
        checkKey: check.checkKey,
        result: check.result,
        evidence: record(check.evidence),
        checkedAt: check.checkedAt.toISOString(),
      })) : [],
      monitors: input.monitors.filter((monitor) => monitor.releaseId === release.id).map((monitor) => ({
        id: monitor.id,
        window: monitor.window,
        status: monitor.status,
        baseline: record(monitor.baseline),
        observed: record(monitor.observed),
        verification: record(monitor.verification),
        startedAt: monitor.startedAt.toISOString(),
        finishedAt: monitor.finishedAt?.toISOString() ?? null,
      })),
    };
  });
}
