import {
  characterQaAuthorityMatches,
  latestCharacterQaAuthorityRun,
  type CharacterWorkspaceDetail,
} from "@idream/shared/admin";

/**
 * SPEC: 「这次 QA 还代表当前草稿吗」的唯一判定 —— 上线预览（记录 QA）与发布页（授权发布）
 *       必须给出同一个答案。
 * INTENT: 两个面板各自重推一次时，只要有一处漏掉一个 pin，就会出现「预览说证据过期、发布页
 *         仍允许提案」这种自相矛盾的组合。
 */

export type CharacterWorkspaceQaAuthorityRun = Pick<
  CharacterWorkspaceDetail["qaRuns"][number],
  | "id"
  | "status"
  | "createdAt"
  | "characterId"
  | "projectId"
  | "projectVersion"
  | "characterContentVersionId"
  | "visualProfileId"
  | "visualProfileVersion"
  | "visualProfileHash"
  | "referenceSetRevisionId"
  | "referenceSetRevision"
  | "referenceSetHash"
  | "draftAssetPackHash"
>;

export type CharacterWorkspaceQaAuthority = {
  readonly character: {
    readonly id: string;
  };
  readonly project: {
    readonly id: string;
    readonly version: number;
    readonly draftAssetPackHash: string;
    readonly draftAssetRouteAuthority?: {
      readonly status: "empty" | "current" | "stale" | "route_unavailable";
      readonly qaReady?: boolean;
    };
  };
  readonly preview: {
    readonly draft: {
      readonly contentVersionId: string | null;
      readonly assetPackReady?: boolean;
    };
  };
  readonly visual: {
    readonly activeIdentity: {
      readonly id: string;
      readonly version: number;
      readonly immutableHash: string | null;
    } | null;
    readonly activeReferenceSet: {
      readonly id: string;
      readonly revision: number;
      readonly snapshotHash: string | null;
    } | null;
  };
};

export function currentWorkspaceQaAuthority(data: CharacterWorkspaceQaAuthority) {
  return {
    characterId: data.character.id,
    projectId: data.project.id,
    characterContentVersionId: data.preview.draft.contentVersionId,
    projectVersion: data.project.version,
    visualProfileId: data.visual.activeIdentity?.id ?? null,
    visualProfileVersion: data.visual.activeIdentity?.version ?? null,
    visualProfileHash: data.visual.activeIdentity?.immutableHash ?? null,
    referenceSetRevisionId: data.visual.activeReferenceSet?.id ?? null,
    referenceSetRevision: data.visual.activeReferenceSet?.revision ?? null,
    referenceSetHash: data.visual.activeReferenceSet?.snapshotHash ?? null,
    draftAssetPackHash: data.project.draftAssetPackHash,
  };
}

export function qaRunMatchesCurrentWorkspaceAuthority(
  run: Omit<CharacterWorkspaceQaAuthorityRun, "id" | "createdAt">,
  data: CharacterWorkspaceQaAuthority,
) {
  return (
    data.project.draftAssetRouteAuthority?.qaReady !== false &&
    data.project.draftAssetRouteAuthority?.status !== "stale" &&
    data.project.draftAssetRouteAuthority?.status !== "route_unavailable" &&
    data.preview.draft.assetPackReady !== false &&
    run.status === "passed" &&
    characterQaAuthorityMatches(run, currentWorkspaceQaAuthority(data))
  );
}

export function latestQaRunForCurrentWorkspaceAuthority<
  T extends CharacterWorkspaceQaAuthorityRun,
>(runs: readonly T[], data: CharacterWorkspaceQaAuthority) {
  if (
    data.project.draftAssetRouteAuthority?.qaReady === false ||
    data.project.draftAssetRouteAuthority?.status === "stale" ||
    data.project.draftAssetRouteAuthority?.status === "route_unavailable" ||
    data.preview.draft.assetPackReady === false
  )
    return null;
  return latestCharacterQaAuthorityRun(runs, currentWorkspaceQaAuthority(data));
}

export function releasableQaRunForCurrentWorkspaceAuthority<
  T extends CharacterWorkspaceQaAuthorityRun,
>(runs: readonly T[], data: CharacterWorkspaceQaAuthority) {
  const latest = latestQaRunForCurrentWorkspaceAuthority(runs, data);
  return latest?.status === "passed" ? latest : null;
}
