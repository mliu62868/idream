// SPEC: derives whether a Generation Request may be retried, from the facts that outlive its
//       legacy `status` column — valid artifacts, terminal events, and refund ledger entries.
// INTENT: moved here from `modules/admin/generation-job-state.ts` during the v2 migration. The
//         dead-letter authority is now its only caller; the detail timeline that used to share
//         this file is served by the `/api/v2/admin/jobs/:id` projection instead.
// INVARIANT: a request with a valid artifact is never retryable, whatever its status says — a
//            second run would bill a second time for work the customer already received.
export interface GenerationJobEventFact {
  createdAt: Date;
  type: string;
  message?: string | null;
  metadata?: unknown;
}

export interface GenerationLedgerFact {
  createdAt?: Date;
  reason: string;
  delta: number;
  balanceAfter?: number;
}

export type GenerationExecutionOutcome =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked"
  | "cancelled"
  | "unknown";

const TERMINAL_EVENT_OUTCOMES: Readonly<Record<string, GenerationExecutionOutcome>> = {
  completed: "succeeded",
  succeeded: "succeeded",
  failed: "failed",
  blocked: "blocked",
  cancelled: "cancelled",
};

function hasValidArtifact(asset: { safetyStatus: string; deletedAt?: Date | null }) {
  return !asset.deletedAt && asset.safetyStatus === "passed";
}

export function deriveGenerationJobState(input: {
  status: string;
  completedAt: Date | null;
  finishedAt?: Date | null;
  errorCode: string | null;
  assets: ReadonlyArray<{ id: string; safetyStatus: string; deletedAt?: Date | null }>;
  events: ReadonlyArray<GenerationJobEventFact>;
  ledgerEntries: ReadonlyArray<GenerationLedgerFact>;
}) {
  const validArtifacts = input.assets.filter(hasValidArtifact);
  const terminalEvents = input.events.filter((event) => TERMINAL_EVENT_OUTCOMES[event.type]);
  const terminalOutcomes = Array.from(
    new Set(terminalEvents.map((event) => TERMINAL_EVENT_OUTCOMES[event.type])),
  );
  const latestTerminalEvent = terminalEvents.at(-1) ?? null;
  const hasTerminalConflict = terminalOutcomes.length > 1;

  let executionOutcome: GenerationExecutionOutcome;
  let terminalSource: "artifact" | "event" | "legacy_status" | "none";
  if (validArtifacts.length > 0) {
    executionOutcome = "succeeded";
    terminalSource = "artifact";
  } else if (hasTerminalConflict) {
    executionOutcome = "unknown";
    terminalSource = "event";
  } else if (latestTerminalEvent) {
    const eventOutcome = TERMINAL_EVENT_OUTCOMES[latestTerminalEvent.type];
    executionOutcome = eventOutcome === "succeeded" ? "unknown" : eventOutcome!;
    terminalSource = "event";
  } else if (["failed", "blocked", "cancelled"].includes(input.status)) {
    executionOutcome = input.status as "failed" | "blocked" | "cancelled";
    terminalSource = "legacy_status";
  } else if (["queued", "moderating_input"].includes(input.status)) {
    executionOutcome = "pending";
    terminalSource = "none";
  } else if (["running", "moderating_output"].includes(input.status)) {
    executionOutcome = "running";
    terminalSource = "none";
  } else {
    executionOutcome = "unknown";
    terminalSource = "legacy_status";
  }

  const refunded = input.ledgerEntries.some((entry) => entry.reason === "refund" && entry.delta > 0);
  const retryEligibility =
    validArtifacts.length > 0
      ? { eligible: false as const, reason: "successful_artifact_exists" as const }
      : executionOutcome !== "failed"
        ? { eligible: false as const, reason: "not_failed" as const }
        : refunded
          ? { eligible: false as const, reason: "refunded" as const }
          : { eligible: true as const, reason: "retryable_failure" as const };

  return {
    executionOutcome,
    finishedAt: latestTerminalEvent?.createdAt ?? input.finishedAt ??
      (input.status === "completed" ? input.completedAt : null),
    terminalSource,
    terminalConflict: hasTerminalConflict,
    validArtifactCount: validArtifacts.length,
    errorCode: input.errorCode,
    retryEligibility,
  };
}
