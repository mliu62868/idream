import type { AdminV2OperationId } from "./api-manifest";

export type AdminV2ImplementedMutationTransport =
  | {
      readonly status: "implemented";
      readonly kind: "idempotency_key";
      readonly replay: "same_result";
      readonly collision: "reject_payload_mismatch";
      readonly failure: "retryable_without_double_apply";
    }
  | {
      readonly status: "implemented";
      readonly kind: "if_match";
      readonly staleWrite: "reject";
    };

export type AdminV2PendingMutationTransport = {
  readonly status: "pending";
  readonly owner: string;
  readonly reason: string;
  readonly requiredTransport: "Idempotency-Key" | "If-Match";
};

export type AdminV2MutationTransport =
  | AdminV2ImplementedMutationTransport
  | AdminV2PendingMutationTransport;

const idempotencyKey = (): AdminV2ImplementedMutationTransport => ({
  status: "implemented",
  kind: "idempotency_key",
  replay: "same_result",
  collision: "reject_payload_mismatch",
  failure: "retryable_without_double_apply",
});

const ifMatch = (): AdminV2ImplementedMutationTransport => ({
  status: "implemented",
  kind: "if_match",
  staleWrite: "reject",
});

const pending = (
  owner: string,
  reason: string,
  requiredTransport: AdminV2PendingMutationTransport["requiredTransport"] = "Idempotency-Key",
): AdminV2PendingMutationTransport => ({
  status: "pending",
  owner,
  reason,
  requiredTransport,
});

/**
 * Fail-closed transport inventory for every state-changing Admin v2 operation.
 *
 * `implemented` means the public contract and handler both expose the stated
 * transport invariant. `pending` is deliberately not treated as an exception:
 * release gates can enumerate these exact owners and block closure.
 */
export const ADMIN_V2_MUTATION_TRANSPORT = {
  "POST /api/v2/admin/cases/backfill": pending("case-platform", "Backfill can be retried after a timeout and has no request deduplication."),
  "POST /api/v2/admin/cases/backfill/customer": pending("case-platform", "Customer backfill can be retried after a timeout and has no request deduplication."),
  "POST /api/v2/admin/cases/:id/actions": idempotencyKey(),
  "POST /api/v2/admin/cases/:id/assignment": idempotencyKey(),
  "POST /api/v2/admin/cases/:id/commands/close": idempotencyKey(),
  "POST /api/v2/admin/cases/:id/commands/reopen": idempotencyKey(),
  "POST /api/v2/admin/cases/:id/commands/wait": idempotencyKey(),
  "POST /api/v2/admin/cases/:id/decisions": idempotencyKey(),
  "POST /api/v2/admin/cases/:id/verification": idempotencyKey(),

  "POST /api/v2/admin/characters": idempotencyKey(),
  "POST /api/v2/admin/characters/performance/backfill": pending("character-platform", "Performance backfill has no replay identity across client retries."),
  "POST /api/v2/admin/characters/route-qualifications/commands/evaluate": pending("character-platform", "Qualification evaluation is a command without deduplicated replay semantics."),
  "POST /api/v2/admin/characters/:id/commands/pause": idempotencyKey(),
  "POST /api/v2/admin/characters/:id/commands/resume": idempotencyKey(),
  "POST /api/v2/admin/characters/:id/commands/retire": idempotencyKey(),
  "POST /api/v2/admin/characters/:id/portfolio-decisions": pending("character-platform", "Portfolio decisions have no collision-safe request identity."),
  "PATCH /api/v2/admin/characters/:id/project": ifMatch(),
  "POST /api/v2/admin/characters/:id/qa-runs": pending("character-release", "QA run creation can enqueue duplicate work after an ambiguous failure."),
  "POST /api/v2/admin/characters/:id/releases": pending("character-release", "Release proposal retries can create duplicate release records."),
  "POST /api/v2/admin/characters/:id/releases/:releaseId/commands/publish": idempotencyKey(),
  "POST /api/v2/admin/characters/:id/releases/:releaseId/commands/rollback": idempotencyKey(),
  "POST /api/v2/admin/characters/:id/releases/:releaseId/commands/schedule": idempotencyKey(),
  "POST /api/v2/admin/characters/:id/releases/:releaseId/monitors/:window/refresh": pending("character-release", "Monitor refresh lacks a stable retry identity for generated observations."),
  "POST /api/v2/admin/characters/:id/releases/:releaseId/review": pending("character-release", "Review submission retries can duplicate review and audit effects."),
  "POST /api/v2/admin/characters/:id/releases/:releaseId/validation": pending("character-release", "Validation submission retries can duplicate validation and audit effects."),

  "POST /api/v2/admin/chat/sessions/:sessionId/commands/migrate-release": idempotencyKey(),
  "POST /api/v2/admin/collaboration/:targetType/:targetId/activity": idempotencyKey(),
  "PUT /api/v2/admin/collaboration/:targetType/:targetId/watch": idempotencyKey(),

  "POST /api/v2/admin/creative/runs": idempotencyKey(),
  "POST /api/v2/admin/creative/runs/:id/commands/attach-incident": pending("creative-operations", "Incident attachment retries can repeat cross-domain linkage events."),
  "POST /api/v2/admin/creative/runs/:id/commands/retry-failed": idempotencyKey(),
  "POST /api/v2/admin/creative/runs/:id/items/:itemId/decisions": pending("creative-operations", "Review decision retries can duplicate item decision audit events."),
  "POST /api/v2/admin/creative/runs/:id/placements": pending("creative-operations", "Placement publication has no collision-safe request identity."),
  "POST /api/v2/admin/creative/runs/:id/placements/:placementId/verification": pending("creative-operations", "Placement verification retries can duplicate evidence records."),

  "POST /api/v2/admin/experiments": idempotencyKey(),
  "POST /api/v2/admin/experiments/:id/commands/start": idempotencyKey(),
  "POST /api/v2/admin/experiments/:id/commands/stop": idempotencyKey(),
  "POST /api/v2/admin/generation/requests/:id/commands/cancel": idempotencyKey(),

  "POST /api/v2/admin/incidents/backfill": pending("incident-platform", "Incident backfill has no request identity for safe replay."),
  "PATCH /api/v2/admin/incidents/:id": ifMatch(),
  "POST /api/v2/admin/incidents/:id/action-plans/preview": idempotencyKey(),
  "POST /api/v2/admin/incidents/:id/action-plans/:planId/execute": idempotencyKey(),
  "POST /api/v2/admin/incidents/:id/commands/close": idempotencyKey(),
  "POST /api/v2/admin/incidents/:id/commands/merge": idempotencyKey(),
  "POST /api/v2/admin/incidents/:id/commands/resolve": idempotencyKey(),
  "POST /api/v2/admin/incidents/:id/commands/split": idempotencyKey(),
  "POST /api/v2/admin/incidents/:id/verification": idempotencyKey(),

  "POST /api/v2/admin/jobs/:id/commands/retry": idempotencyKey(),
  "POST /api/v2/admin/saved-views": idempotencyKey(),
  "PATCH /api/v2/admin/saved-views/:id": ifMatch(),
  "DELETE /api/v2/admin/saved-views/:id": ifMatch(),
  "POST /api/v2/admin/today/claim": idempotencyKey(),
  "PUT /api/v2/admin/today/preferences": ifMatch(),
  "POST /api/v2/admin/users/:id/grant-bundles": pending("identity-access", "Grant retries can duplicate authorization audit events."),
  "DELETE /api/v2/admin/users/:id/grant-bundles/:bundleKey": pending("identity-access", "Grant revocation has no optimistic concurrency precondition.", "If-Match"),
} as const satisfies Partial<Record<AdminV2OperationId, AdminV2MutationTransport>>;

export const ADMIN_V2_PENDING_MUTATION_TRANSPORT = Object.fromEntries(
  Object.entries(ADMIN_V2_MUTATION_TRANSPORT).filter(
    (entry): entry is [string, AdminV2PendingMutationTransport] =>
      entry[1].status === "pending",
  ),
) as Readonly<Record<string, AdminV2PendingMutationTransport>>;
