import {
  ADMIN_V2_API_OPERATIONS,
  type AdminV2MutationTransportKind,
  type AdminV2OperationId,
} from "./api-manifest";

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
    }
  | {
      readonly status: "implemented";
      readonly kind: "idempotency_key_and_if_match";
      readonly replay: "same_result";
      readonly collision: "reject_payload_mismatch";
      readonly failure: "retryable_without_double_apply";
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

function implemented(kind: AdminV2MutationTransportKind): AdminV2ImplementedMutationTransport {
  if (kind === "if_match") {
    return { status: "implemented", kind, staleWrite: "reject" };
  }
  if (kind === "idempotency_key") {
    return {
      status: "implemented",
      kind,
      replay: "same_result",
      collision: "reject_payload_mismatch",
      failure: "retryable_without_double_apply",
    };
  }
  return {
    status: "implemented",
    kind,
    replay: "same_result",
    collision: "reject_payload_mismatch",
    failure: "retryable_without_double_apply",
    staleWrite: "reject",
  };
}

// Derived compatibility projection. Operation identity and transport now live
// only in ADMIN_V2_API_OPERATIONS.
export const ADMIN_V2_MUTATION_TRANSPORT = Object.fromEntries(
  ADMIN_V2_API_OPERATIONS.flatMap((operation) =>
    operation.mutation
      ? [[operation.id, implemented(operation.mutation.transport)]]
      : []
  ),
) as Readonly<Partial<Record<AdminV2OperationId, AdminV2ImplementedMutationTransport>>>;

export const ADMIN_V2_PENDING_MUTATION_TRANSPORT: Readonly<
  Record<string, AdminV2PendingMutationTransport>
> = {};
