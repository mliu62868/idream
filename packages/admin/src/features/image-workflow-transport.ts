import type {
  CharacterIdentityBootstrapRequest,
  CharacterReleaseCreateRequest,
  CreativeRunRetryFailedCommandRequest,
} from "@idream/shared/admin";
import type { AdminV2OperationRequest } from "@/lib/admin-v2-operation";

// SPEC: 上线之后的证据只有一个 tab —— 线上表现、组合决策和发布护栏是同一件事的三面。
// 旧的 ?tab=portfolio 深链会回落到概览（characterWorkspaceTabFromSearch 的缺省）。
export const characterWorkspaceTabs = [
  "project",
  "soul",
  "visual",
  "assets",
  "video",
  "voice",
  "preview",
  "release",
  "monitor",
] as const;

export type CharacterWorkspaceTab = (typeof characterWorkspaceTabs)[number];

export function characterWorkspaceTabFromSearch(
  search: string,
): CharacterWorkspaceTab {
  const requested = new URLSearchParams(search).get("tab");
  return characterWorkspaceTabs.includes(requested as CharacterWorkspaceTab)
    ? (requested as CharacterWorkspaceTab)
    : "project";
}

export function characterIdentityBootstrapMutation(
  characterId: string,
  entityVersion: number,
  runId: string,
  itemId: string,
  assetId: string,
  reviewDecisionId: string | undefined,
  reason: string,
  /** 来自 durable mutation intent 的落盘键——刷新后要认同一笔账，只能原样重放。 */
  replayIdempotencyKey: string,
): AdminV2OperationRequest<"POST /api/v2/admin/characters/:id/identity-bootstrap"> {
  const body: CharacterIdentityBootstrapRequest = {
    entityVersion,
    runId,
    itemId,
    assetId,
    ...(reviewDecisionId ? { reviewDecisionId } : {}),
    reason,
    confirmation: `BOOTSTRAP IDENTITY ${characterId}`,
  };
  return {
    operationId: "POST /api/v2/admin/characters/:id/identity-bootstrap",
    options: {
      path: { id: characterId },
      replayIdempotencyKey,
      ifMatch: entityVersion,
      body,
    },
  };
}

export function characterReleaseCreateMutation(
  characterId: string,
  entityVersion: number,
  reason: string,
  confirmation: string,
): AdminV2OperationRequest<"POST /api/v2/admin/characters/:id/releases"> {
  const body: CharacterReleaseCreateRequest = {
    entityVersion,
    reason,
    confirmation,
  };
  return {
    operationId: "POST /api/v2/admin/characters/:id/releases",
    options: {
      path: { id: characterId },
      ifMatch: entityVersion,
      body,
    },
  };
}

export function creativeRetryFailedMutation(
  runId: string,
  entityVersion: number,
  /** 来自本地落盘的重试命令状态——刷新后继续认同一笔账，只能原样重放。 */
  replayIdempotencyKey: string,
): AdminV2OperationRequest<"POST /api/v2/admin/creative/runs/:id/commands/retry-failed"> {
  const body: CreativeRunRetryFailedCommandRequest = {
    entityVersion,
    reason: {
      code: "operator_retry_failed",
      summary: "Retry only eligible failed Creative Run items",
    },
    confirmation: `${runId}:retry-failed`,
  };
  return {
    operationId: "POST /api/v2/admin/creative/runs/:id/commands/retry-failed",
    options: {
      path: { id: runId },
      replayIdempotencyKey,
      body,
    },
  };
}
