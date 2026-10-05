import { parseViewerAuthorityResponse } from "@/lib/public-api-contracts";
import {
  apiEnvelopeErrorMessage,
  type ResourceFetcher,
} from "@/lib/viewer-resource-client";

// SPEC: the single answer to "who is looking at this page".
//
// INTENT: four mechanisms used to answer it — `fetchViewerScope`,
// `fetchProtectedForViewer`, five bare `fetch("/api/v1/me")` calls scattered
// through the workspaces, and GeneratorWorkspace's own epoch/scope triple.
// They agreed on the endpoint and on nothing else.
//
// INTENT: `fetchProtectedForViewer` also re-resolved the viewer before *every*
// protected request, so each workspace mount paid for an extra `/api/v1/me`
// round trip. Sharing one resolution removes the duplicate request without
// touching authorisation: the server remains the authority on every protected
// response, and this cache only decides whether to ask it.
//
// INVARIANT: the remaining direct `/api/v1/me` readers deliberately do NOT go
// through this cache, because each needs an answer this one cannot give:
//   - AuthWorkspace re-queries live after a failed sign-in to catch the
//     "already authenticated" race, so it must see the mutation that just
//     happened in this same tab.
//   - AgeGateBoundary reads `ageGate.accepted` and re-runs on every route
//     change to notice an acceptance that just occurred.
//   - AuthNav parses with the stricter `parseAuthMeResponse` (display name and
//     email, not just an id) and has its own "Account unavailable" state.
//   - CreateWorkspace scopes localStorage drafts by viewer, where a stale id
//     would surface one account's draft under another on a shared browser.

export type ViewerFetcher = ResourceFetcher;

export type ViewerAuthority = ReturnType<typeof parseViewerAuthorityResponse>;

export type ProtectedViewerResponse =
  | { viewer: "anonymous"; response: null }
  | { viewer: "authenticated"; response: Response };

export type ViewerAuthorityResolver = {
  resolve: (fetcher?: ViewerFetcher) => Promise<ViewerAuthority>;
  /** Forget the resolved viewer. Call whenever the signed-in identity changes. */
  invalidate: () => void;
};

/**
 * INVARIANT: a rejected resolution is never remembered. Caching a failure would
 * strand the whole page on one unlucky network blip, so the promise is dropped
 * on rejection and the next caller retries.
 */
export function createViewerAuthorityResolver(): ViewerAuthorityResolver {
  let resolved: Promise<ViewerAuthority> | null = null;
  return {
    resolve(fetcher = fetch) {
      resolved ??= requestViewerAuthority(fetcher).catch((error: unknown) => {
        resolved = null;
        throw error;
      });
      return resolved;
    },
    invalidate() {
      resolved = null;
    },
  };
}

const sharedResolver = createViewerAuthorityResolver();

export function resolveViewerAuthority(
  fetcher?: ViewerFetcher,
): Promise<ViewerAuthority> {
  return sharedResolver.resolve(fetcher);
}

/** Forget a cached answer after an identity mutation or live recheck. */
export function invalidateViewerAuthority(): void {
  sharedResolver.invalidate();
}

export const VIEWER_AUTH_CHANGE_STORAGE_KEY = "idream.auth-change";

/** Same identity, new public profile fields (display name): AuthNav re-reads /me. */
export const VIEWER_PROFILE_CHANGED_EVENT = "idream-profile-changed";

/** Other tabs still hold private state even when the mutating tab navigates. */
export function announceViewerAuthorityChange(): void {
  invalidateViewerAuthority();
  try {
    window.localStorage.setItem(VIEWER_AUTH_CHANGE_STORAGE_KEY, crypto.randomUUID());
  } catch {
    // Storage can be disabled; AuthNav also checks the live identity on focus.
  }
}

/**
 * INTENT: a hung `/api/v1/me` used to hold everything waiting on it — every
 * gated read, and Profile's private reads and writes, Save included — on
 * "Loading" with no way out. Past this bound the check counts as failed, which
 * every caller already renders with a way to retry.
 */
export const VIEWER_CHECK_TIMEOUT_MS = 15_000;
export const VIEWER_UNCONFIRMED_MESSAGE = "We couldn't confirm your account. Refresh and try again.";

export function isTimeoutError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "TimeoutError";
}

async function requestViewerAuthority(
  fetcher: ViewerFetcher,
): Promise<ViewerAuthority> {
  let response: Response;
  let raw: unknown;
  try {
    response = await fetcher("/api/v1/me", {
      cache: "no-store",
      signal: AbortSignal.timeout(VIEWER_CHECK_TIMEOUT_MS),
    });
    raw = await response.json().catch(() => null);
  } catch (error) {
    throw isTimeoutError(error) ? new Error(VIEWER_UNCONFIRMED_MESSAGE) : error;
  }
  if (!response.ok) {
    throw new Error(apiEnvelopeErrorMessage(raw) ?? VIEWER_UNCONFIRMED_MESSAGE);
  }
  return parseViewerAuthorityResponse(raw);
}

/** `user:<id>` / `anonymous:<id>` — the key browser drafts are stored under. */
export async function fetchViewerScope(
  fetcher: ViewerFetcher = fetch,
): Promise<string> {
  const payload = await resolveViewerAuthority(fetcher);
  if (payload.user) return `user:${payload.user.id}`;
  if (typeof payload.anonymousId === "string" && payload.anonymousId.length > 0) {
    return `anonymous:${payload.anonymousId}`;
  }
  throw new Error(VIEWER_UNCONFIRMED_MESSAGE);
}

/**
 * Fetches a protected path, but only once the viewer is known to be signed in —
 * an anonymous viewer gets `response: null` instead of a pointless 401.
 */
export async function fetchProtectedForViewer(
  protectedPath: string,
  init?: RequestInit,
  fetcher: ViewerFetcher = fetch,
): Promise<ProtectedViewerResponse> {
  const viewerPayload = await resolveViewerAuthority(fetcher);

  if (viewerPayload.user === null) {
    return { viewer: "anonymous", response: null };
  }

  return {
    viewer: "authenticated",
    response: await fetcher(protectedPath, init),
  };
}
