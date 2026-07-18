import { describe, expect, it } from "vitest";
import { ourdreamRoutePaths, getOurdreamRoute } from "./ourdream-data";
import { safetyRoutePaths } from "./ourdream-safety-data";
import {
  dedicatedStaticProductPaths,
  hasDedicatedStaticRouteContent,
} from "./static-route-authority";
import { dedicatedStaticArticlePaths } from "./static-article-authority";

describe("dedicated static route authority", () => {
  it("uses an exact positive registry instead of trusting route templates", () => {
    const expectedTrustedPaths = new Set([
      ...dedicatedStaticProductPaths,
      ...dedicatedStaticArticlePaths,
      ...safetyRoutePaths,
    ]);

    for (const path of ourdreamRoutePaths) {
      const route = getOurdreamRoute(path);
      expect(route, path).toBeDefined();
      expect(hasDedicatedStaticRouteContent(route!), path).toBe(
        expectedTrustedPaths.has(path),
      );
    }
  });

  it("requires the registered renderer template to match", () => {
    expect(
      hasDedicatedStaticRouteContent({
        path: "/generate",
        template: "marketing",
      }),
    ).toBe(false);
    expect(
      hasDedicatedStaticRouteContent({
        path: "/guides/character-cards",
        template: "library",
      }),
    ).toBe(false);
    expect(
      hasDedicatedStaticRouteContent({
        path: "/safety/introduction",
        template: "article",
      }),
    ).toBe(false);
  });
});
