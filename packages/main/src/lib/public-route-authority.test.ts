import { describe, expect, it } from "vitest";
import { getOurdreamRoute, ourdreamRoutePaths } from "./ourdream-data";
import {
  cmsRouteAuthority,
  indexableStaticPaths,
  isPublicRouteDiscoverable,
  publicRouteAuthority,
} from "./public-route-authority";

describe("public route authority", () => {
  it("keeps the current index allowlist exact, unique, and self-canonical", () => {
    expect(indexableStaticPaths).toHaveLength(27);
    expect(new Set(indexableStaticPaths).size).toBe(27);
    for (const path of indexableStaticPaths) {
      const authority = publicRouteAuthority(path, getOurdreamRoute(path));
      expect(authority).toMatchObject({
        canonicalPath: path,
        discoverable: true,
        follow: true,
        indexable: true,
      });
    }
  });

  it("keeps route inventory without treating generic shells as published content", () => {
    for (const path of [
      "/comparison/character-ai-alternative",
      "/generate/ai-porn",
      "/ai-girlfriend",
    ]) {
      expect(ourdreamRoutePaths).toContain(path);
      expect(publicRouteAuthority(path, getOurdreamRoute(path))).toMatchObject({
        canonicalPath: path,
        discoverable: false,
        follow: true,
        indexable: false,
        renderable: false,
      });
      expect(isPublicRouteDiscoverable(path)).toBe(false);
    }

    const unpublishedArticle = "/guides/how-to-use-character-ai";
    expect(ourdreamRoutePaths).toContain(unpublishedArticle);
    expect(
      publicRouteAuthority(
        unpublishedArticle,
        getOurdreamRoute(unpublishedArticle),
      ),
    ).toMatchObject({
      canonicalPath: unpublishedArticle,
      discoverable: false,
      follow: true,
      indexable: false,
      renderable: false,
    });
    expect(
      publicRouteAuthority(
        "/guides/character-cards",
        getOurdreamRoute("/guides/character-cards"),
      ),
    ).toMatchObject({
      discoverable: true,
      indexable: true,
      renderable: true,
    });
    for (const path of [
      "/chat",
      "/community",
      "/create",
      "/feed",
      "/generate",
      "/profile",
      "/resources-hub",
      "/upgrade",
    ]) {
      expect(publicRouteAuthority(path, getOurdreamRoute(path))).toMatchObject({
        renderable: true,
      });
    }
  });

  it("separates aliases and private application surfaces", () => {
    expect(publicRouteAuthority("/explore")).toMatchObject({
      canonicalPath: "/",
      indexable: false,
      follow: true,
    });
    expect(publicRouteAuthority("/safety")).toMatchObject({
      canonicalPath: "/safety/introduction",
      indexable: false,
      follow: true,
    });
    for (const path of [
      "/chat",
      "/chat/session-id",
      "/custom",
      "/profile/account-management",
      "/feed",
      "/characters/id",
      "/creators/id",
    ]) {
      expect(publicRouteAuthority(path)).toMatchObject({
        indexable: false,
        follow: false,
      });
    }
  });

  it("requires a CMS index decision and a self canonical", () => {
    expect(
      cmsRouteAuthority({
        canonical: null,
        indexingStatus: "index",
        path: "/guides/real-cms-page",
      }),
    ).toMatchObject({ indexable: true, discoverable: true });
    expect(
      cmsRouteAuthority({
        canonical: "/guides/canonical-page",
        indexingStatus: "index",
        path: "/guides/alias-page",
      }),
    ).toMatchObject({
      canonicalPath: "/guides/canonical-page",
      indexable: false,
      follow: true,
    });
    expect(
      cmsRouteAuthority({
        canonical: null,
        indexingStatus: "noindex",
        path: "/guides/draft-distribution",
      }),
    ).toMatchObject({ indexable: false, discoverable: false });
  });
});
