export type AuthRoute = "/login" | "/signup";

const allowedAuthRedirectPrefixes = [
  "/",
  "/age-verification",
  "/ai-boyfriend",
  "/ai-girlfriend",
  "/ai-instructions",
  "/characters",
  "/changelog",
  "/chat",
  "/comparison",
  "/community",
  "/coins",
  "/comics",
  "/creator-studio",
  "/creators",
  "/create",
  "/custom",
  "/feed",
  "/games",
  "/generate",
  "/guides",
  "/helpdesk",
  "/packs",
  "/profile",
  "/resources-hub",
  "/romantasy",
  "/safety",
  "/sex-chat",
  "/terms",
  "/type",
  "/upgrade",
  "/videos",
] as const;

const authRoutes = new Set<string>(["/login", "/signup"]);

export function authHrefForTarget(route: AuthRoute, target: string | null, referralCode?: string) {
  const query = [];
  if (target) query.push(`next=${encodeURIComponent(target)}`);
  const ref = referralCode?.trim();
  if (ref) query.push(`ref=${encodeURIComponent(ref)}`);
  return `${route}${query.length ? `?${query.join("&")}` : ""}`;
}

export function signupReferralCode(search: string) {
  return new URLSearchParams(search).get("ref")?.trim() || undefined;
}

export function authNextTargetFromPath(
  pathname: string | null | undefined,
  search: string,
  hash = "",
) {
  if (!pathname || !pathname.startsWith("/") || pathname.startsWith("//")) return null;
  if (pathname === "/") return null;
  if (authRoutes.has(pathname)) {
    // Only first-party paths are accepted; the inert origin also rejects backslash host escapes.
    const target = safeInternalAuthRedirect(new URLSearchParams(search).get("next"), "https://idream.invalid");
    return target === "/" ? null : target;
  }

  const normalizedSearch = search.startsWith("?") ? search.slice(1) : search;
  const normalizedHash = hash.startsWith("#") ? hash : "";
  const target = `${pathname}${normalizedSearch ? `?${normalizedSearch}` : ""}${normalizedHash}`;
  return isAllowedInternalAuthRedirect(target) ? target : null;
}

export function safeInternalAuthRedirect(next: string | null, origin: string) {
  if (!next) return "/";
  const trimmed = next.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return "/";

  try {
    const parsed = new URL(trimmed, origin);
    if (parsed.origin !== origin) return "/";
    const target = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    return isAllowedInternalAuthRedirect(target) ? target : "/";
  } catch {
    return "/";
  }
}

function isAllowedInternalAuthRedirect(target: string) {
  const hashIndex = target.indexOf("#");
  const comparableTarget = hashIndex === -1 ? target : target.slice(0, hashIndex);

  if (authRoutes.has(comparableTarget)) return false;

  return allowedAuthRedirectPrefixes.some(
    (prefix) =>
      comparableTarget === prefix ||
      comparableTarget.startsWith(`${prefix}?`) ||
      (prefix !== "/" && comparableTarget.startsWith(`${prefix}/`)),
  );
}
