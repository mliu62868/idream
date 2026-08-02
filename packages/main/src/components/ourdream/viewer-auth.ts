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
//   - UpgradeWorkspace's checkout resolves the viewer on demand precisely
//     because the mount-time load may not have finished; a money path must not
//     act on a remembered identity.
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

/**
 * INVARIANT: must be called wherever the signed-in identity changes without a
 * full page load. Nothing in the app calls it today, and that is a finding
 * rather than an oversight: all four identity transitions — sign-in/sign-up
 * (AuthWorkspace), log out (AuthNav), sign out everywhere and account deletion
 * (ProfileWorkspace) — navigate on success via `window.location`, which tears
 * down this module along with the rest of the heap. The moment one of them
 * becomes a client-side (router.push) transition, it has to call this.
 */
export function invalidateViewerAuthority(): void {
  sharedResolver.invalidate();
}

async function requestViewerAuthority(
  fetcher: ViewerFetcher,
): Promise<ViewerAuthority> {
  const response = await fetcher("/api/v1/me", { cache: "no-store" });
  const raw: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      apiEnvelopeErrorMessage(raw) ?? "Viewer authority could not load.",
    );
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
  throw new Error("Viewer authority was incomplete.");
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
