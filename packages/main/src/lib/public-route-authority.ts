import type { OurdreamRoute } from "@/types/ourdream";
import { hasTrustedStaticRouteContent } from "./public-route-render-decision";

export type PublicRouteAuthority = {
  canonicalPath: string;
  discoverable: boolean;
  follow: boolean;
  indexable: boolean;
  path: string;
  renderable: boolean;
};

const safetyIndexablePaths = [
  "/safety/contact",
  "/safety/introduction",
  "/safety/moderation/appeals",
  "/safety/moderation/how-it-works",
  "/safety/moderation/why-rejected",
  "/safety/policies/acceptable-use",
  "/safety/policies/age-verification",
  "/safety/policies/intellectual-property",
  "/safety/policies/prohibited-content",
  "/safety/policies/what-we-wont-do",
  "/safety/principles",
  "/safety/reporting/how-to-report",
  "/safety/your-account/privacy-summary",
  "/safety/your-account/safety-tools",
  "/safety/your-account/wellbeing-resources",
] as const;

export const indexableStaticPaths = [
  "/",
  "/create",
  "/generate",
  "/upgrade",
  "/community",
  "/helpdesk",
  "/resources-hub",
  "/comparison",
  "/guides/character-cards",
  "/guides/character-card-creator",
  "/guides/sillytavern-setup-guide",
  "/terms",
  ...safetyIndexablePaths,
] as const;

const indexableStaticPathSet = new Set<string>(indexableStaticPaths);
const aliases = new Map<string, string>([
  ["/explore", "/"],
  ["/safety", "/safety/introduction"],
]);
const privatePrefixes = [
  "/admin",
  "/api",
  "/characters",
  "/chat",
  "/creators",
  "/custom",
  "/feed",
  "/internal-preview",
  "/login",
  "/profile",
  "/signup",
  "/user-content",
] as const;

export function publicRouteAuthority(
  path: string,
  route?: OurdreamRoute,
): PublicRouteAuthority {
  const canonicalPath = aliases.get(path) ?? path;
  const privateRoute = privatePrefixes.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
  const indexable = indexableStaticPathSet.has(path);
  const hasStaticContent = Boolean(
    route && hasTrustedStaticRouteContent(route),
  );

  return {
    path,
    canonicalPath,
    renderable: hasStaticContent || path === "/" || aliases.has(path),
    discoverable: indexable,
    indexable,
    follow: !privateRoute,
  };
}

export function cmsRouteAuthority(input: {
  canonical: string | null;
  indexingStatus: "index" | "noindex";
  path: string;
}): PublicRouteAuthority {
  const canonicalPath = input.canonical ?? input.path;
  const indexable =
    input.indexingStatus === "index" && canonicalPath === input.path;
  return {
    path: input.path,
    canonicalPath,
    renderable: true,
    discoverable: indexable,
    indexable,
    follow: true,
  };
}

export function isPublicRouteDiscoverable(path: string) {
  return indexableStaticPathSet.has(path);
}
