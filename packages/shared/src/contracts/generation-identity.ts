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

/**
 * Written into the invocation guard by a transport that submitted under
 * `generationRunnerPromptId`. Only a guard carrying it proves the earlier
 * submission can be looked up: a guard from before this scheme existed has a
 * runner-minted prompt id, and asking for the derived id would report a live
 * prompt as gone.
 */
export const GENERATION_RUNNER_PROMPT_ID_SCHEME = "attempt-output-uuid5-v1";

const GENERATION_RUNNER_PROMPT_NAMESPACE = "6f1d2a9e-3c47-5b8e-9a10-7d2c4e8b1f36";

/**
 * SPEC: the runner-side prompt id for one output of one Attempt, a canonical
 * lowercase RFC 4122 UUIDv5 (ComfyUI's `validate_job_id` rejects anything else).
 * INTENT: a retry has to ask the runner about the earlier submission, and the
 * crashed worker took any runner-minted id with it. Deriving the id means the
 * retry already knows it.
 * INVARIANT: the id only identifies. ComfyUI does not deduplicate `POST /prompt`,
 * so resending it queues a second render; a retry may read it, never submit it.
 */
export function generationRunnerPromptId(attemptId: string, outputIndex: number): string {
  if (!attemptId || !Number.isSafeInteger(outputIndex) || outputIndex < 0) {
    throw new Error("Runner prompt id requires an attempt id and a non-negative output index");
  }
  const namespace = Uint8Array.from(
    GENERATION_RUNNER_PROMPT_NAMESPACE.replaceAll("-", "").match(/../g)!,
    (byte) => Number.parseInt(byte, 16),
  );
  const name = new TextEncoder().encode(`${attemptId}:${outputIndex}`);
  const message = new Uint8Array(namespace.length + name.length);
  message.set(namespace);
  message.set(name, namespace.length);
  const bytes = sha1(message).slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// INTENT: browser bundles import this module through the contracts barrel and
// cannot load node:crypto (see browser-entrypoints.test.ts), and WebCrypto is
// async. SHA-1 here is UUIDv5's naming function, not a security boundary.
function sha1(message: Uint8Array): Uint8Array {
  const paddedLength = (((message.length + 8) >> 6) << 6) + 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(message);
  padded[message.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(message.length / 0x20000000));
  view.setUint32(paddedLength - 4, message.length << 3);
  const state = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const rotl = (value: number, bits: number) => (value << bits) | (value >>> (32 - bits));
  const words = new Int32Array(80);
  for (let block = 0; block < paddedLength; block += 64) {
    for (let t = 0; t < 16; t += 1) words[t] = view.getInt32(block + t * 4);
    for (let t = 16; t < 80; t += 1) words[t] = rotl(words[t - 3]! ^ words[t - 8]! ^ words[t - 14]! ^ words[t - 16]!, 1);
    let [a, b, c, d, e] = state as [number, number, number, number, number];
    for (let t = 0; t < 80; t += 1) {
      const [mix, constant] = t < 20 ? [(b & c) | (~b & d), 0x5a827999]
        : t < 40 ? [b ^ c ^ d, 0x6ed9eba1]
        : t < 60 ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc]
        : [b ^ c ^ d, 0xca62c1d6];
      const next = (rotl(a, 5) + mix + e + constant! + words[t]!) | 0;
      e = d; d = c; c = rotl(b, 30); b = a; a = next;
    }
    state[0] = (state[0]! + a) | 0;
    state[1] = (state[1]! + b) | 0;
    state[2] = (state[2]! + c) | 0;
    state[3] = (state[3]! + d) | 0;
    state[4] = (state[4]! + e) | 0;
  }
  const digest = new Uint8Array(20);
  const digestView = new DataView(digest.buffer);
  state.forEach((word, index) => digestView.setUint32(index * 4, word >>> 0));
  return digest;
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
