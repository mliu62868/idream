import { isRecord } from "./workspace-helpers";

// SPEC: hands an anonymous visitor's in-progress draft across the sign-in bounce.
// stash() parks the draft under a one-shot nonce and returns the URL to come back
// to; claim() hands it over once, to the signed-in viewer, and scrubs the nonce
// out of the address bar.
// INTENT: the create wizard, the generator preset editor and the help desk each
// grew their own copy of this. Hardening one copy never reached the others, so
// there is now exactly one — new surfaces add a channel, not a protocol.
// INVARIANTS:
//   - only an anonymous scope may stash; only a user scope may claim
//   - the URL nonce must match the stored envelope, which expires after the TTL
//   - a successful claim consumes the envelope and the query parameter, so a
//     replayed URL yields nothing
//   - browser storage is best-effort: every failure degrades to null, never throws

export const DRAFT_TRANSFER_TTL_MS = 20 * 60 * 1_000;

const ANONYMOUS_SCOPE_PREFIX = "anonymous:";
const USER_SCOPE_PREFIX = "user:";

type DraftTransferChannel = Readonly<{
  /** Query parameter carrying the nonce on the way back from sign-in. */
  param: string;
  /** Route the viewer returns to. */
  path: string;
  /** sessionStorage key holding the pending envelope. */
  storageKey: string;
}>;

// Storage keys and parameters are the ones already in the wild — changing them
// would strand transfers that are mid-flight in a real browser.
const CHANNELS = {
  create: {
    param: "draftResume",
    path: "/create",
    storageKey: "ourdream.create.draft.transfer.v1",
  },
  generatorPreset: {
    param: "presetResume",
    path: "/generate",
    storageKey: "idream.generatePresetDraftTransfer.v1",
  },
  helpdesk: {
    param: "resume",
    path: "/helpdesk",
    storageKey: "ourdream.helpdesk.resume.v1",
  },
} as const satisfies Record<string, DraftTransferChannel>;

export type DraftTransferKind = keyof typeof CHANNELS;

export type ClaimedDraftTransfer = {
  payload: unknown;
  /** Scope the draft was stashed from, so the caller can drop its old copy. */
  sourceScope: string;
};

export function isAnonymousScope(scope: string) {
  return scope.startsWith(ANONYMOUS_SCOPE_PREFIX);
}

export function isUserScope(scope: string) {
  return scope.startsWith(USER_SCOPE_PREFIX);
}

/** Return URL for a channel when no draft could be parked. */
export function draftTransferPath(kind: DraftTransferKind) {
  return CHANNELS[kind].path;
}

/**
 * Parks `payload` for the signed-in viewer to pick up and returns the URL to send
 * the visitor back to. Returns null when the caller is already signed in or when
 * session storage is unavailable — callers fall back to a plain route.
 */
export function stashDraftTransfer(
  kind: DraftTransferKind,
  options: Readonly<{ payload: unknown; sourceScope: string }>,
): string | null {
  const channel = CHANNELS[kind];
  if (typeof window === "undefined" || !isAnonymousScope(options.sourceScope)) {
    return null;
  }
  try {
    const nonce = crypto.randomUUID();
    window.sessionStorage.setItem(
      channel.storageKey,
      JSON.stringify({
        expiresAt: Date.now() + DRAFT_TRANSFER_TTL_MS,
        nonce,
        payload: options.payload,
        sourceScope: options.sourceScope,
      }),
    );
    return `${channel.path}?${channel.param}=${encodeURIComponent(nonce)}`;
  } catch {
    return null;
  }
}

/**
 * Hands over a parked draft exactly once. Returns null unless the viewer is
 * signed in, the URL carries the matching nonce, and the envelope is still live.
 */
export function claimDraftTransfer(
  kind: DraftTransferKind,
  options: Readonly<{ targetScope: string }>,
): ClaimedDraftTransfer | null {
  const channel = CHANNELS[kind];
  if (typeof window === "undefined" || !isUserScope(options.targetScope)) {
    return null;
  }
  try {
    const nonce = new URLSearchParams(window.location.search).get(channel.param);
    if (!nonce) return null;
    const raw = window.sessionStorage.getItem(channel.storageKey);
    if (!raw) return null;

    const envelope = JSON.parse(raw) as unknown;
    if (
      !isRecord(envelope) ||
      typeof envelope.expiresAt !== "number" ||
      typeof envelope.sourceScope !== "string" ||
      !isAnonymousScope(envelope.sourceScope)
    ) {
      window.sessionStorage.removeItem(channel.storageKey);
      return null;
    }
    if (envelope.expiresAt <= Date.now()) {
      window.sessionStorage.removeItem(channel.storageKey);
      return null;
    }
    // A mismatched nonce is a stale/forged link, not a stale envelope — leave the
    // pending transfer alone so the genuine return trip can still claim it.
    if (envelope.nonce !== nonce) return null;

    window.sessionStorage.removeItem(channel.storageKey);
    clearTransferParam(channel.param);
    return { payload: envelope.payload, sourceScope: envelope.sourceScope };
  } catch {
    return null;
  }
}

function clearTransferParam(param: string) {
  const url = new URL(window.location.href);
  url.searchParams.delete(param);
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}
