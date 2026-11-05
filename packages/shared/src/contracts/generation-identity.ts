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

// SPEC: the only asset names Gen writes under an Attempt's output prefix.
// Historical keys (no `attempts/` segment) and every non-generation key do not
// match, so they have no derivative and can never gain a delete capability here.
const GENERATION_DERIVATIVE_SOURCE_KEY =
  /^(gen\/[^/]+\/attempts\/[^/]+\/(?:image-[1-4](?=\.(?:png|jpg|webp)$)|video(?=\.mp4$)))\.[a-z0-9]+$/;

/**
 * Blob key of an asset's display derivative (WebP preview or video poster).
 * INVARIANT: pure, and the only construction of this name. Erasure derives it
 * from the asset key instead of reading a stored pointer, so a derivative stays
 * reachable even when its record says "failed" after a lost put acknowledgement;
 * there is no second key column that could drift from storageKey or be forgotten
 * beside it. A derivative key returns null: derivatives have no derivatives.
 */
export function generationAssetDerivativeKey(assetKey: string): string | null {
  const match = GENERATION_DERIVATIVE_SOURCE_KEY.exec(assetKey);
  return match ? `${match[1]}.preview.webp` : null;
}
