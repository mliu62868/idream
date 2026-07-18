import type { OurdreamRoute } from "@/types/ourdream";
import { hasDedicatedStaticRouteContent } from "./static-route-authority";

export type CmsRouteState =
  | "published"
  | "absent"
  | "invalid"
  | "unavailable";

export type PublicRouteRenderDecision =
  | "cms"
  | "static"
  | "not_found"
  | "authority_error";

export function hasTrustedStaticRouteContent(
  route: Pick<OurdreamRoute, "path" | "template">,
) {
  return hasDedicatedStaticRouteContent(route);
}

export function publicRouteRenderDecision(
  route: Pick<OurdreamRoute, "path" | "template"> | undefined,
  cmsState: CmsRouteState,
): PublicRouteRenderDecision {
  if (cmsState === "published") return "cms";
  if (route && hasTrustedStaticRouteContent(route)) return "static";
  if (cmsState === "invalid" || cmsState === "unavailable") {
    return "authority_error";
  }
  return "not_found";
}
