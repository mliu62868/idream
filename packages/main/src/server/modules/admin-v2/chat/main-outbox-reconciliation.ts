import {
  MAIN_TO_CHAT_EVENTS,
  durableEnvelopeHash,
  durableEventEnvelopeSchema,
  resolveMainToChatTarget,
  type DurableEventEnvelope,
} from "@idream/shared/contracts";

const CHAT_EVENT_TYPES = Object.values(MAIN_TO_CHAT_EVENTS);
const CHAT_EVENT_TYPE_SET = new Set<string>(CHAT_EVENT_TYPES);

export type MainToChatReceiverReceipt = {
  readonly sourceEventId: string;
  readonly payloadHash: string;
  readonly eventType: string;
  readonly status: string;
  readonly attempts: number;
};

export type MainToChatReceiverTarget = {
  readonly kind: "attachment" | "session";
  readonly id: string;
  readonly status: string;
};

export type MainToChatOutboxAuditRow = {
  readonly id: string;
  readonly eventType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payload: unknown;
};

export type MainToChatTargetIdentity = {
  readonly kind: "attachment" | "session";
  readonly id: string;
};

export type MainToChatEnvelopeValidation =
  | {
      readonly valid: true;
      readonly envelope: DurableEventEnvelope;
      readonly envelopeHash: string;
      readonly target: MainToChatTargetIdentity | null;
    }
  | {
      readonly valid: false;
      readonly reason: "invalid_envelope" | "invalid_payload";
      readonly target: null;
    };

export type MainToChatReplayDisposition =
  | "replay_exact_receiver_receipt"
  | "replay_receiver_target_present"
  | "replay_no_receiver_target_required"
  | "reconcile_receiver_target_missing"
  | "reconcile_receiver_discarded_target_missing"
  | "reconcile_receiver_hash_conflict"
  | "reconcile_receiver_quarantined"
  | "invalid_envelope"
  | "invalid_payload";

/**
 * INVARIANT: an event is replay-selectable only when both its immutable durable
 * envelope and the event-specific payload consumed by Chat are parseable.
 * A generic envelope alone is not enough: Chat would persist its receipt first,
 * then fail forever while applying a malformed payload.
 */
export function validateMainToChatOutboxEnvelope(
  row: MainToChatOutboxAuditRow,
): MainToChatEnvelopeValidation {
  if (!CHAT_EVENT_TYPE_SET.has(row.eventType)) {
    return { valid: false, reason: "invalid_envelope", target: null };
  }
  const parsed = durableEventEnvelopeSchema.safeParse(row.payload);
  if (
    !parsed.success ||
    parsed.data.sourceService !== "main" ||
    parsed.data.sourceEventId !== row.id ||
    parsed.data.eventType !== row.eventType ||
    parsed.data.aggregateType !== row.aggregateType ||
    parsed.data.aggregateId !== row.aggregateId
  ) {
    return { valid: false, reason: "invalid_envelope", target: null };
  }

  const target = resolveMainToChatTarget(parsed.data);
  if (!target.valid) {
    return { valid: false, reason: "invalid_payload", target: null };
  }
  return {
    valid: true,
    envelope: parsed.data,
    envelopeHash: durableEnvelopeHash(parsed.data),
    target: target.target,
  };
}

/**
 * SPEC: classify a replay without mutating Main, Chat, or Redis.
 *
 * INTENT: a missing receiver target is not silently called replay-safe. The
 * transport can ACK a no-op, but that would hide whether the target was
 * intentionally deleted or lost. An operator must reconcile that authority
 * first. Exact durable receipts and extant targets remain safe replay paths.
 */
export function classifyMainToChatReplay(input: {
  readonly row: MainToChatOutboxAuditRow;
  readonly receipt: MainToChatReceiverReceipt | null;
  readonly target: MainToChatReceiverTarget | null;
}): {
  readonly disposition: MainToChatReplayDisposition;
  readonly validation: MainToChatEnvelopeValidation;
} {
  const validation = validateMainToChatOutboxEnvelope(input.row);
  if (!validation.valid) {
    return { disposition: validation.reason, validation };
  }

  if (input.receipt) {
    if (input.receipt.status === "quarantined") {
      return { disposition: "reconcile_receiver_quarantined", validation };
    }
    if (
      input.receipt.payloadHash !== validation.envelopeHash ||
      input.receipt.eventType !== validation.envelope.eventType
    ) {
      return { disposition: "reconcile_receiver_hash_conflict", validation };
    }
    // Chat writes the terminal receipt before Main commits its matching status.
    // If Main rolls back, this exact receipt is evidence to retry the audited
    // terminal command, never evidence that a user-visible replay is safe.
    if (input.receipt.status === "discarded_target_missing") {
      return {
        disposition: "reconcile_receiver_discarded_target_missing",
        validation,
      };
    }
    return { disposition: "replay_exact_receiver_receipt", validation };
  }

  if (!validation.target) {
    return { disposition: "replay_no_receiver_target_required", validation };
  }
  if (
    input.target &&
    input.target.kind === validation.target.kind &&
    input.target.id === validation.target.id
  ) {
    return { disposition: "replay_receiver_target_present", validation };
  }
  return { disposition: "reconcile_receiver_target_missing", validation };
}
