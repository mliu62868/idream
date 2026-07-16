export type AuthorityStatus = {
  phase: "loading" | "ready" | "error";
  error: string | null;
  hasSnapshot: boolean;
};

export type ProfileAuthorityState =
  | "authenticated"
  | "anonymous"
  | "error";

export function initialAuthorityStatus(): AuthorityStatus {
  return {
    phase: "loading",
    error: null,
    hasSnapshot: false,
  };
}

export function loadingAuthorityStatus(
  current: AuthorityStatus,
): AuthorityStatus {
  return {
    phase: "loading",
    error: null,
    hasSnapshot: current.hasSnapshot,
  };
}

export function loadingAuthorityStatusForScope(
  current: AuthorityStatus,
  hasMatchingScope: boolean,
): AuthorityStatus {
  return loadingAuthorityStatus(
    hasMatchingScope ? current : initialAuthorityStatus(),
  );
}

export function readyAuthorityStatus(): AuthorityStatus {
  return {
    phase: "ready",
    error: null,
    hasSnapshot: true,
  };
}

export function failedAuthorityStatus(
  current: AuthorityStatus,
  error: string,
): AuthorityStatus {
  return {
    phase: "error",
    error,
    hasSnapshot: current.hasSnapshot,
  };
}

export function authorityShowsEmpty(
  status: AuthorityStatus,
  itemCount: number,
): boolean {
  return status.phase === "ready" && itemCount === 0;
}

export function profileAuthorityStateForResponse(response: {
  status: number;
  ok: boolean;
}): ProfileAuthorityState {
  if (response.status === 401) {
    return "anonymous";
  }
  return response.ok ? "authenticated" : "error";
}
