import type { OurdreamRoute, OurdreamRouteTemplate } from "@/types/ourdream";
import { safetyRoutePaths } from "./ourdream-safety-data";
import { dedicatedStaticArticlePaths } from "./static-article-authority";

// A route inventory entry is navigation/editorial backlog, not publish proof.
// Only paths with a dedicated product renderer or authored static document may
// bypass CMS publication authority.
const dedicatedProductRouteTemplates = {
  "/chat": "marketing",
  "/community": "profile",
  "/comparison": "comparison",
  "/create": "create",
  "/custom": "profile",
  "/feed": "profile",
  "/generate": "generator",
  "/helpdesk": "marketing",
  "/login": "marketing",
  "/profile": "profile",
  "/profile/account-management": "profile",
  "/profile/notifications": "profile",
  "/profile/redeem-code": "profile",
  "/resources-hub": "library",
  "/signup": "marketing",
  "/terms": "terms",
  "/upgrade": "upgrade",
} as const satisfies Record<string, OurdreamRouteTemplate>;

const dedicatedArticlePathSet = new Set<string>(dedicatedStaticArticlePaths);
const safetyRoutePathSet = new Set<string>(safetyRoutePaths);

export const dedicatedStaticProductPaths = Object.freeze(
  Object.keys(dedicatedProductRouteTemplates),
);

export function hasDedicatedStaticRouteContent(
  route: Pick<OurdreamRoute, "path" | "template">,
) {
  if (dedicatedArticlePathSet.has(route.path)) {
    return route.template === "article";
  }
  if (safetyRoutePathSet.has(route.path)) {
    return route.template === "safety";
  }
  return (
    dedicatedProductRouteTemplates[
      route.path as keyof typeof dedicatedProductRouteTemplates
    ] === route.template
  );
}
