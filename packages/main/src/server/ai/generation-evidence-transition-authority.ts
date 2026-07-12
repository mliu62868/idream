import {
  generationArtifactArchiveStateSchema,
  generationArtifactValidationStateSchema,
  generationDeliveryStatusSchema,
  generationTransportExecutionStatusSchema,
} from "@idream/shared/admin";

type StateOf<States extends readonly string[]> = States[number];
type TransitionRows<States extends readonly string[]> = {
  readonly [State in StateOf<States>]: readonly StateOf<States>[];
};

function defineAuthority<const States extends readonly string[]>(
  states: States,
  transitions: TransitionRows<States>,
) {
  const known = new Set<string>(states);
  return (from: string, to: string) =>
    known.has(from) && known.has(to) &&
    transitions[from as StateOf<States>].some((candidate) => candidate === to);
}

export const GENERATION_TRANSPORT_EXECUTION_STATES = generationTransportExecutionStatusSchema.options;
export const GENERATION_ARTIFACT_VALIDATION_STATES = generationArtifactValidationStateSchema.options;
export const GENERATION_ARTIFACT_ARCHIVE_STATES = generationArtifactArchiveStateSchema.options;
export const GENERATION_DELIVERY_STATES = generationDeliveryStatusSchema.options;

export const isGenerationTransportExecutionTransitionAllowed = defineAuthority(
  GENERATION_TRANSPORT_EXECUTION_STATES,
  {
    running: ["running", "succeeded", "failed", "unknown"],
    succeeded: ["succeeded"],
    failed: ["failed"],
    unknown: ["unknown"],
  },
);

export const isGenerationArtifactValidationTransitionAllowed = defineAuthority(
  GENERATION_ARTIFACT_VALIDATION_STATES,
  {
    produced: ["produced", "valid", "invalid", "rejected", "late_after_failed", "late_after_blocked", "late_after_cancel", "late_after_cancelled", "late_after_refunded"],
    valid: ["valid", "late_after_failed", "late_after_blocked", "late_after_cancel", "late_after_cancelled", "late_after_refunded"],
    invalid: ["invalid"],
    rejected: ["rejected"],
    late_after_failed: ["late_after_failed"],
    late_after_blocked: ["late_after_blocked"],
    late_after_cancel: ["late_after_cancel"],
    late_after_cancelled: ["late_after_cancelled"],
    late_after_refunded: ["late_after_refunded"],
  },
);

export const isGenerationArtifactArchiveTransitionAllowed = defineAuthority(
  GENERATION_ARTIFACT_ARCHIVE_STATES,
  { active: ["active", "archived"], archived: ["archived"] },
);

export const isGenerationDeliveryTransitionAllowed = defineAuthority(
  GENERATION_DELIVERY_STATES,
  {
    pending: ["pending", "delivered", "failed", "suppressed"],
    delivered: ["delivered"],
    failed: ["failed"],
    suppressed: ["suppressed"],
  },
);
