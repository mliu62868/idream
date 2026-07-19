import { parseViewerAuthorityResponse } from "@/lib/public-api-contracts";

export type ViewerFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type ProtectedViewerResponse =
  | { viewer: "anonymous"; response: null }
  | { viewer: "authenticated"; response: Response };

export async function fetchViewerScope(
  fetcher: ViewerFetcher = fetch,
): Promise<string> {
  const response = await fetcher("/api/v1/me", { cache: "no-store" });
  const raw = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(apiErrorMessage(raw) ?? "Viewer authority could not load.");
  }
  const payload = parseViewerAuthorityResponse(raw);
  if (payload.user) return `user:${payload.user.id}`;
  if (typeof payload.anonymousId === "string" && payload.anonymousId.length > 0) {
    return `anonymous:${payload.anonymousId}`;
  }
  throw new Error("Viewer authority was incomplete.");
}

export async function fetchProtectedForViewer(
  protectedPath: string,
  init?: RequestInit,
  fetcher: ViewerFetcher = fetch,
): Promise<ProtectedViewerResponse> {
  const viewerResponse = await fetcher("/api/v1/me", { cache: "no-store" });
  const raw = await viewerResponse.json().catch(() => null);
  if (!viewerResponse.ok) {
    throw new Error(
      apiErrorMessage(raw) ?? "Viewer authority could not load.",
    );
  }
  const viewerPayload = parseViewerAuthorityResponse(raw);

  if (viewerPayload.user === null) {
    return { viewer: "anonymous", response: null };
  }

  return {
    viewer: "authenticated",
    response: await fetcher(protectedPath, init),
  };
}

function apiErrorMessage(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const error = (payload as Record<string, unknown>).error;
  if (!error || typeof error !== "object" || Array.isArray(error)) {
    return undefined;
  }
  const message = (error as Record<string, unknown>).message;
  return typeof message === "string" ? message : undefined;
}
