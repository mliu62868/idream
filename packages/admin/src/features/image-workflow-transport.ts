import type {
  CharacterIdentityBootstrapRequest,
  CharacterQaRunCreateRequest,
  CharacterReleaseProposalRequest,
  CharacterReleaseReviewRequest,
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

export type CharacterWorkspaceTab = typeof characterWorkspaceTabs[number];

export function characterWorkspaceTabFromSearch(search: string): CharacterWorkspaceTab {
  const requested = new URLSearchParams(search).get("tab");
  return characterWorkspaceTabs.includes(requested as CharacterWorkspaceTab)
    ? requested as CharacterWorkspaceTab
    : "project";
}

export function characterQaMutation(
  characterId: string,
  entityVersion: number,
  checks: CharacterQaRunCreateRequest["checks"],
  reason: string,
  idempotencyKey: string,
): AdminV2OperationRequest<"POST /api/v2/admin/characters/:id/qa-runs"> {
  const body: CharacterQaRunCreateRequest = {
    entityVersion,
    checks,
    reason,
  };
  return {
    operationId: "POST /api/v2/admin/characters/:id/qa-runs",
    options: {
      path: { id: characterId },
      idempotencyKey,
      ifMatch: entityVersion,
      body,
    },
  };
}

export function characterIdentityBootstrapMutation(
  characterId: string,
  entityVersion: number,
  runId: string,
  itemId: string,
  assetId: string,
  reviewDecisionId: string,
  reason: string,
  idempotencyKey: string,
): AdminV2OperationRequest<"POST /api/v2/admin/characters/:id/identity-bootstrap"> {
  const body: CharacterIdentityBootstrapRequest = {
    entityVersion,
    runId,
    itemId,
    assetId,
    reviewDecisionId,
    reason,
    confirmation: `BOOTSTRAP IDENTITY ${characterId}`,
  };
  return {
    operationId: "POST /api/v2/admin/characters/:id/identity-bootstrap",
    options: {
      path: { id: characterId },
      idempotencyKey,
      ifMatch: entityVersion,
      body,
    },
  };
}

export function characterReleaseProposalMutation(
  characterId: string,
  entityVersion: number,
  qaRunId: string,
  reason: string,
  confirmation: string,
  idempotencyKey: string,
): AdminV2OperationRequest<"POST /api/v2/admin/characters/:id/releases"> {
  const body: CharacterReleaseProposalRequest = {
    entityVersion,
    qaRunId,
    reason,
    confirmation,
  };
  return {
    operationId: "POST /api/v2/admin/characters/:id/releases",
    options: {
      path: { id: characterId },
      idempotencyKey,
      ifMatch: entityVersion,
      body,
    },
  };
}

export function characterReleaseReviewMutation(
  characterId: string,
  releaseId: string,
  entityVersion: number,
  decision: "approved" | "changes_requested",
  reason: string,
  confirmation: string,
  idempotencyKey: string,
): AdminV2OperationRequest<"POST /api/v2/admin/characters/:id/releases/:releaseId/review"> {
  const body: CharacterReleaseReviewRequest = {
    entityVersion,
    decision,
    reason,
    confirmation,
  };
  return {
    operationId: "POST /api/v2/admin/characters/:id/releases/:releaseId/review",
    options: {
      path: { id: characterId, releaseId },
      idempotencyKey,
      ifMatch: entityVersion,
      body,
    },
  };
}

export function creativeRetryFailedMutation(
  runId: string,
  entityVersion: number,
  idempotencyKey: string,
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
      idempotencyKey,
      body,
    },
  };
}
