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
  version: number;
  updatedAt: Date;
} | null) {
  return serving ? {
    characterId: serving.characterId,
    state: serving.state,
    currentReleaseId: serving.currentReleaseId,
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

/**
 * SPEC: 上一次发布被自动撤回的候选及其原因 —— 仅当撤回事件标记为自动、且当前草稿仍是那份内容
 *       （内容版本与三张展示图逐位一致）时返回，否则 null。
 * INTENT: publish 失败的证据持久在自动撤回事件里（失败码 + 阻塞项）。运营刷新后仍要看到「上次为什么
 *         没发出去」和修复入口；人工放弃的候选没有自动标记，不会被说成发布失败；草稿一改即不再下发。
 *         推导留在服务端：前端不自己比对展示图（deep-module-authority-boundaries）。
 */
export function characterWorkspaceLastFailedPublish(input: {
  readonly latestRelease: { id: string; status: string; characterContentVersionId: string } | null;
  readonly latestReleasePack: Readonly<Record<string, string | undefined>>;
  readonly draftContentVersionId: string | null;
  readonly draftPack: Readonly<Record<string, string | undefined>>;
  readonly withdrawal: { readonly toState: Prisma.JsonValue; readonly occurredAt: Date } | null;
  readonly validationRuns: readonly { id: string; releaseId: string }[];
  readonly checks: readonly { validationRunId: string; checkKey: string; result: string }[];
}): { releaseId: string; failureCode: string; blockers: string[]; failedAt: string } | null {
  const release = input.latestRelease;
  if (!release || release.status !== "withdrawn" || !input.withdrawal) return null;
  const facts = record(input.withdrawal.toState);
  if (facts.automatic !== true || typeof facts.failureCode !== "string") return null;
  if (release.characterContentVersionId !== input.draftContentVersionId) return null;
  const purposes = new Set([...Object.keys(input.latestReleasePack), ...Object.keys(input.draftPack)]);
  for (const purpose of purposes) {
    if ((input.latestReleasePack[purpose] ?? null) !== (input.draftPack[purpose] ?? null)) return null;
  }
  const recorded = Array.isArray(facts.blockers)
    ? facts.blockers.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
  const validation = input.validationRuns.find((run) => run.releaseId === release.id);
  const failedChecks = validation
    ? input.checks.filter((check) => check.validationRunId === validation.id && check.result === "failed").map((check) => check.checkKey)
    : [];
  return {
    releaseId: release.id,
    failureCode: facts.failureCode,
    blockers: [...new Set(recorded.length > 0 ? recorded : failedChecks)],
    failedAt: input.withdrawal.occurredAt.toISOString(),
  };
}
