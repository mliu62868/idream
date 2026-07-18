import type { Metadata } from "next";
import { cache } from "react";
import { notFound, permanentRedirect } from "next/navigation";
import {
  getOurdreamRoute,
  ourdreamRoutePaths,
} from "@/lib/ourdream-data";
import {
  cmsRouteAuthority,
  publicRouteAuthority,
  type PublicRouteAuthority,
} from "@/lib/public-route-authority";
import { OurdreamRoutePage } from "@/components/ourdream/OurdreamRoutePage";
import { CmsRenderer } from "@/components/ourdream/CmsRenderer";
import { loadPublishedRoutePage } from "@/server/cms/published-route";
import {
  hasTrustedStaticRouteContent,
  publicRouteRenderDecision,
} from "@/lib/public-route-render-decision";

// CMS override（ADMIN_PHASE3_DESIGN §3.2）：已发布 RoutePage 优先；ISR 让编辑无需发版即生效，
// 同时保留静态页性能。未在静态集合的纯 DB 页按需 SSR。
export const dynamicParams = true;
export const revalidate = 60;

type RouteParams = {
  slug: string[];
};

type PageProps = {
  params: Promise<RouteParams>;
};

function pathFromSlug(slug: string[]) {
  return `/${slug.join("/")}`;
}

const loadCmsResolution = cache(loadPublishedRoutePage);

export function generateStaticParams(): RouteParams[] {
  return ourdreamRoutePaths
    .filter((path) => {
      const route = getOurdreamRoute(path);
      return route ? hasTrustedStaticRouteContent(route) : false;
    })
    .map((path) => ({
      slug: path.slice(1).split("/"),
    }));
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const path = pathFromSlug(slug);
  const route = getOurdreamRoute(path);
  const resolution = await loadCmsResolution(path);
  const renderDecision = publicRouteRenderDecision(route, resolution.state);

  if (renderDecision === "cms" && resolution.state === "published") {
    const authority = cmsRouteAuthority(resolution.page);
    const title = `${resolution.page.title} | ourdream.ai`;
    return {
      title,
      description: resolution.page.description,
      ...authorityMetadata(
        authority,
        title,
        resolution.page.description,
      ),
    };
  }

  if (renderDecision === "authority_error") {
    throw new Error(`CMS authority is not usable for route ${path}`);
  }
  if (renderDecision === "not_found" || !route) notFound();

  const authority = publicRouteAuthority(path, route);
  const title = `${route.title} | ourdream.ai`;
  return {
    title,
    description: route.description,
    ...authorityMetadata(authority, title, route.description),
  };
}

export default async function Page({ params }: PageProps) {
  const { slug } = await params;
  const path = pathFromSlug(slug);

  const route = getOurdreamRoute(path);
  const authority = publicRouteAuthority(path, route);
  if (authority.canonicalPath !== path) {
    permanentRedirect(authority.canonicalPath);
  }

  const resolution = await loadCmsResolution(path);
  const renderDecision = publicRouteRenderDecision(route, resolution.state);
  if (renderDecision === "cms" && resolution.state === "published") {
    return <CmsRenderer page={resolution.page} />;
  }

  // A route definition is navigation/editorial metadata, not publish proof.
  // Only the explicit dedicated-renderer registry may bypass CMS authority.
  if (renderDecision === "static" && route) {
    return <OurdreamRoutePage route={route} />;
  }

  if (renderDecision === "authority_error") {
    throw new Error(`CMS authority is not usable for route ${path}`);
  }
  notFound();
}

function authorityMetadata(
  authority: PublicRouteAuthority,
  title: string,
  description: string,
): Pick<
  Metadata,
  "alternates" | "openGraph" | "robots"
> {
  return {
    alternates: { canonical: authority.canonicalPath },
    openGraph: {
      type: "website",
      siteName: "ourdream.ai",
      title,
      description,
      url: authority.canonicalPath,
    },
    robots: {
      index: authority.indexable,
      follow: authority.follow,
      googleBot: {
        index: authority.indexable,
        follow: authority.follow,
      },
    },
  };
}
