export type AuthRoute = "/login" | "/signup";

const allowedAuthRedirectPrefixes = [
  "/",
  "/ai-boyfriend",
  "/ai-girlfriend",
  "/ai-instructions",
  "/characters",
  "/chat",
  "/comparison",
  "/community",
  "/creators",
  "/create",
  "/custom",
  "/feed",
  "/games",
  "/generate",
  "/guides",
  "/helpdesk",
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

export function authHrefForTarget(route: AuthRoute, target: string | null) {
  if (!target) return route;
  return `${route}?next=${encodeURIComponent(target)}`;
}

export function authNextTargetFromPath(
  pathname: string | null | undefined,
  search: string,
  hash = "",
) {
  if (!pathname || !pathname.startsWith("/") || pathname.startsWith("//")) return null;
  if (pathname === "/" || authRoutes.has(pathname)) return null;

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
