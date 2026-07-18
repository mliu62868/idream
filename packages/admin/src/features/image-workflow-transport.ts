import type {
  CharacterIdentityBootstrapRequest,
  CharacterQaRunCreateRequest,
  CharacterReleaseProposalRequest,
  CharacterReleaseReviewRequest,
  CreativeRunRetryFailedCommandRequest,
} from "@idream/shared/admin";

export const characterWorkspaceTabs = [
  "project",
  "visual",
  "assets",
  "preview",
  "release",
  "monitor",
  "portfolio",
] as const;

export type CharacterWorkspaceTab = typeof characterWorkspaceTabs[number];

type MutationOptions<TBody> = {
  method: "POST";
  body: TBody;
  idempotencyKey?: string;
  ifMatch?: number;
};

export type ImageWorkflowMutation<TBody> = {
  path: string;
  options: MutationOptions<TBody>;
};

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
): ImageWorkflowMutation<CharacterQaRunCreateRequest> {
  const body: CharacterQaRunCreateRequest = { entityVersion, checks, reason };
  return {
    path: `/api/v2/admin/characters/${characterId}/qa-runs`,
    options: {
      method: "POST",
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
): ImageWorkflowMutation<CharacterIdentityBootstrapRequest> {
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
    path: `/api/v2/admin/characters/${characterId}/identity-bootstrap`,
    options: {
      method: "POST",
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
): ImageWorkflowMutation<CharacterReleaseProposalRequest> {
  const body: CharacterReleaseProposalRequest = {
    entityVersion,
    qaRunId,
    reason,
    confirmation,
  };
  return {
    path: `/api/v2/admin/characters/${characterId}/releases`,
    options: {
      method: "POST",
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
): ImageWorkflowMutation<CharacterReleaseReviewRequest> {
  const body: CharacterReleaseReviewRequest = {
    entityVersion,
    decision,
    reason,
    confirmation,
  };
  return {
    path: `/api/v2/admin/characters/${characterId}/releases/${releaseId}/review`,
    options: {
      method: "POST",
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
): ImageWorkflowMutation<CreativeRunRetryFailedCommandRequest> {
  const body: CreativeRunRetryFailedCommandRequest = {
    entityVersion,
    reason: {
      code: "operator_retry_failed",
      summary: "Retry only eligible failed Creative Run items",
    },
    confirmation: `${runId}:retry-failed`,
  };
  return {
    path: `/api/v2/admin/creative/runs/${runId}/commands/retry-failed`,
    options: {
      method: "POST",
      idempotencyKey,
      body,
    },
  };
}
