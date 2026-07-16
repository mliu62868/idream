export type ViewerFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

type ViewerAuthorityPayload = {
  ok?: boolean;
  data?: {
    user?: unknown | null;
  };
  error?: {
    message?: string;
  };
};

export type ProtectedViewerResponse =
  | { viewer: "anonymous"; response: null }
  | { viewer: "authenticated"; response: Response };

export async function fetchProtectedForViewer(
  protectedPath: string,
  init?: RequestInit,
  fetcher: ViewerFetcher = fetch,
): Promise<ProtectedViewerResponse> {
  const viewerResponse = await fetcher("/api/v1/me", { cache: "no-store" });
  const viewerPayload = (await viewerResponse.json().catch(() => null)) as
    | ViewerAuthorityPayload
    | null;

  if (
    !viewerResponse.ok ||
    viewerPayload?.ok === false ||
    !viewerPayload?.data ||
    !Object.hasOwn(viewerPayload.data, "user")
  ) {
    throw new Error(
      viewerPayload?.error?.message ?? "Viewer authority could not load.",
    );
  }

  if (viewerPayload.data.user === null) {
    return { viewer: "anonymous", response: null };
  }

  if (
    typeof viewerPayload.data.user !== "object" ||
    Array.isArray(viewerPayload.data.user)
  ) {
    throw new Error("Viewer authority was incomplete.");
  }

  return {
    viewer: "authenticated",
    response: await fetcher(protectedPath, init),
  };
}
