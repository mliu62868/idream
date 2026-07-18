import type { MetadataRoute } from "next";
import { indexableStaticPaths } from "@/lib/public-route-authority";
import { publicSiteOrigin } from "@/lib/public-site-origin";
import {
  loadPublishedRoutePagesForDistribution,
  type PublishedRoutePage,
} from "@/server/cms/published-route";

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  return buildSitemap(
    await loadPublishedRoutePagesForDistribution(),
    publicSiteOrigin(),
  );
}

type SitemapCmsPage = Pick<
  PublishedRoutePage,
  "canonical" | "indexingStatus" | "path" | "publishedAt"
>;

export function buildSitemap(
  cmsPages: SitemapCmsPage[],
  origin: URL,
): MetadataRoute.Sitemap {
  const entries = new Map<string, MetadataRoute.Sitemap[number]>();

  for (const path of indexableStaticPaths) {
    entries.set(path, {
      url: new URL(path, origin).href,
      changeFrequency: staticChangeFrequency(path),
      priority: staticPriority(path),
    });
  }

  for (const page of cmsPages) {
    if (
      page.indexingStatus !== "index" ||
      (page.canonical !== null && page.canonical !== page.path)
    ) {
      entries.delete(page.path);
      continue;
    }
    entries.set(page.path, {
      url: new URL(page.path, origin).href,
      lastModified: page.publishedAt,
      changeFrequency: "monthly",
      priority: 0.7,
    });
  }

  return [...entries.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, entry]) => entry);
}

function staticChangeFrequency(
  path: string,
): NonNullable<MetadataRoute.Sitemap[number]["changeFrequency"]> {
  if (path === "/" || path === "/community") return "daily";
  if (
    path === "/create" ||
    path === "/generate" ||
    path === "/upgrade" ||
    path === "/helpdesk"
  ) {
    return "weekly";
  }
  return "monthly";
}

function staticPriority(path: string) {
  if (path === "/") return 1;
  if (path === "/create" || path === "/generate" || path === "/upgrade") {
    return 0.9;
  }
  if (path === "/community") return 0.8;
  if (
    path === "/resources-hub" ||
    path === "/comparison" ||
    path.startsWith("/guides/")
  ) {
    return 0.7;
  }
  return 0.5;
}
