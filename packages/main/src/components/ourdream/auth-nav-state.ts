export type AuthNavLoadState = "loading" | "ready" | "error";
export type AuthNavLogoutState = "idle" | "pending" | "error";
export type AuthNavMode = "loading" | "authority_error" | "account" | "anonymous";

export function authNavMode(
  loadState: AuthNavLoadState,
  hasUser: boolean,
): AuthNavMode {
  if (loadState === "loading") return "loading";
  if (loadState === "error") return "authority_error";
  return hasUser ? "account" : "anonymous";
}

export function authNavLogoutPresentation(state: AuthNavLogoutState) {
  return {
    label: state === "pending" ? "Logging out…" : "Log out",
    error: state === "error" ? "Log out failed. Try again." : null,
  } as const;
}

export const ACCOUNT_AUTHORITY_UNAVAILABLE = "Account unavailable";
