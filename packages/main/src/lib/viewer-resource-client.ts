"use client";

// SPEC: one viewer-scoped read, start to finish — fetch, decode the JSON
// envelope, decide whether the answer still matters, and report a verdict.
//
// INTENT: every `refreshX` in the ourdream workspaces used to open-code the same
// ~35 lines (no-store fetch → `json().catch(() => null)` → staleness check →
// `!ok` throw → parse → authority transition → swallow AbortError → re-check
// staleness → failed status). Open-coding it meant each copy could forget a
// step, and they did: GeneratorWorkspace's `refreshMedia` guarded against
// out-of-order responses with a request serial while `refreshJobs` and
// `refreshPresets` — same file, same hazard — did not. Centralising the
// lifecycle makes that class of fix land once for every caller.
//
// INTENT: no React here on purpose. The lifecycle is plain async code, so it is
// testable with an injected `fetcher` and no DOM; `useViewerResource` is the
// thin hook that binds it to component state.

/**
 * The three things that can happen to a viewer-scoped read.
 *
 * INVARIANT: `discarded` means the caller MUST NOT touch state — the response is
 * either aborted or superseded. Making it a distinct variant (rather than, say,
 * a null return that reads like "empty") is the whole point: callers cannot
 * silently skip the staleness question the way the open-coded copies did.
 */
export type ViewerResourceOutcome<T> =
  | { kind: "loaded"; data: T }
  | { kind: "failed"; error: string }
  | { kind: "discarded" };

export type ViewerResourceRequest<T> = {
  /** Request URL, already query-encoded by the caller. */
  path: string;
  /**
   * Turns the decoded envelope into the value the caller stores. Throwing is a
   * supported way to reject a malformed payload: it lands on the same failure
   * path as a non-2xx response.
   */
  parse: (raw: unknown) => T;
  /** Message used when the response carries no `error.message` of its own. */
  fallbackError: string;
  /**
   * Passed through verbatim. Deliberately not defaulted — callers differ on
   * `cache: "no-store"` and on whether they attach an abort signal, and
   * inventing a default here would silently change their HTTP behaviour.
   */
  init?: RequestInit;
  /**
   * Re-checked after every await. `false` ⇒ the outcome is `discarded`.
   * Defaults to "always current" for callers with no staleness notion.
   */
  isCurrent?: () => boolean;
  /**
   * Where a failing response's message comes from. `"envelope"` (default)
   * prefers the server's `error.message`; `"fallback"` always shows the
   * caller's own sentence.
   *
   * INTENT: an explicit knob because the workspaces genuinely disagree —
   * ProfileWorkspace surfaces the server's message for media collections but a
   * fixed sentence for library, preferences, and tags. Defaulting one way and
   * migrating everyone onto it would have quietly rewritten user-visible error
   * text on three screens.
   */
  errorFrom?: "envelope" | "fallback";
};

/**
 * Structural fetch, not `typeof fetch`: the global carries extra members
 * (`preconnect`) that a test double has no reason to implement.
 */
export type ResourceFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

const DISCARDED = { kind: "discarded" } as const;

export async function loadViewerResource<T>(
  request: ViewerResourceRequest<T>,
  fetcher: ResourceFetcher = fetch,
): Promise<ViewerResourceOutcome<T>> {
  const isCurrent = request.isCurrent ?? (() => true);
  try {
    const response = await fetcher(request.path, request.init);
    // A body that is not JSON is not itself an error: a non-2xx response may
    // legitimately carry an empty or HTML body, and the status still decides.
    const raw: unknown = await response.json().catch(() => null);

    // INVARIANT: staleness is judged before the status is, so a superseded
    // failure never surfaces an error banner for a request nobody awaits.
    if (!isCurrent()) return DISCARDED;

    if (!response.ok) {
      return {
        kind: "failed",
        error:
          request.errorFrom === "fallback"
            ? request.fallbackError
            : envelopeError(raw, request.fallbackError),
      };
    }
    return { kind: "loaded", data: request.parse(raw) };
  } catch (error) {
    if (isAbortError(error)) return DISCARDED;
    if (!isCurrent()) return DISCARDED;
    return {
      kind: "failed",
      error: requestErrorMessage(error, request.fallbackError),
    };
  }
}

/**
 * `{ error: { message } }` is the shape every v1 route uses for failures.
 *
 * INTENT: this existed four times over — GeneratorWorkspace, ProfileWorkspace,
 * viewer-auth, and generation-write-client each kept a byte-identical private
 * copy. One export, four deletions.
 */
export function apiEnvelopeErrorMessage(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const error = payload.error;
  if (!isRecord(error)) return undefined;
  return typeof error.message === "string" ? error.message : undefined;
}

/** Prefers a thrown `Error`'s own message, falling back when it is absent or blank. */
export function requestErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * INVARIANT: mirrors the old `throw new Error(apiPayloadErrorMessage(raw) ?? fallback)`
 * → `requestErrorMessage(error, fallback)` round trip exactly, blank message
 * included — an envelope carrying `message: ""` falls back rather than
 * rendering an empty banner.
 */
function envelopeError(raw: unknown, fallback: string): string {
  const message = apiEnvelopeErrorMessage(raw);
  return message ? message : fallback;
}

/**
 * INVARIANT: matches the `error instanceof DOMException && error.name === "AbortError"`
 * test the workspaces used, rather than a looser name-only check — an ordinary
 * `Error` that happens to be named "AbortError" stays a real failure.
 */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
