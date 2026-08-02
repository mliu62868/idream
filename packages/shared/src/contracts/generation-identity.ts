// SPEC: the wire identifiers that Main and Gen must agree on byte-for-byte to
// recognize the same generation Attempt across process boundaries.
//
// INTENT: builders, not bare template literals. Every one of these was previously
// duplicated as a string literal in both packages, where the two sides are never
// type-checked against each other: a change on one side compiles, passes CI, and
// only shows up in production as evidence that no longer matches — terminal
// records quarantined wholesale, or worse, a dedupe key that stops colliding and
// lets the same Attempt be billed to the provider twice.
//
// INVARIANT: changing any format here is a cross-service migration, not a
// refactor. In-flight payloads carry the old format, so a change needs a
// compatibility read on the consuming side for the length of the drain window.

/** The provider-facing idempotency key for one Attempt's invocation. */
export function generationProviderIdempotencyKey(attemptId: string): string {
  return `generation:${attemptId}:provider`;
}

/** The requestId Main stamps on an Attempt's dispatch envelope. */
export function generationDispatchRequestId(attemptId: string): string {
  return `generation_dispatch_${attemptId}`;
}

/** Blob storage ref for the immutable terminal record Gen writes per Attempt. */
export function generationTerminalRecordRef(attemptId: string): string {
  return `gen/terminal-records/${attemptId}/terminal.json`;
}

/** Blob storage ref for the provider invocation evidence Gen writes per Attempt. */
export function generationProviderInvocationRef(attemptId: string): string {
  return `gen/terminal-records/${attemptId}/provider-invocation.json`;
}

/**
 * Dedupe key for the finalize job Main enqueues once a terminal record lands.
 * INVARIANT: keyed on Attempt, not Request — a retried Request finalizes once
 * per Attempt.
 */
export function generationTerminalFinalizeDedupeKey(attemptId: string): string {
  return `generation-terminal-record-finalize:${attemptId}`;
}
