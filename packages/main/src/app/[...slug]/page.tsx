import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  getOurdreamRoute,
  ourdreamRoutePaths,
} from "@/lib/ourdream-data";
import { OurdreamRoutePage } from "@/components/ourdream/OurdreamRoutePage";
import { CmsRenderer } from "@/components/ourdream/CmsRenderer";
import { loadPublishedRoutePage } from "@/server/cms/published-route";

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

export function generateStaticParams(): RouteParams[] {
  return ourdreamRoutePaths.map((path) => ({
    slug: path.slice(1).split("/"),
  }));
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const path = pathFromSlug(slug);

  // DB override 优先：运营可改 title/description/canonical 而无需发版。
  const dbPage = await loadPublishedRoutePage(path);
  if (dbPage) {
    return {
      title: `${dbPage.title} | ourdream.ai`,
      description: dbPage.description,
      alternates: { canonical: dbPage.canonical ?? path },
      icons: { icon: "/seo/favicon.ico" },
    };
  }

  const route = getOurdreamRoute(path);
  if (!route) {
    return {
      title: "ourdream.ai",
    };
  }

  return {
    title: `${route.title} | ourdream.ai`,
    description: route.description,
    alternates: {
      canonical: route.path,
    },
    icons: {
      icon: "/seo/favicon.ico",
    },
  };
}

export default async function Page({ params }: PageProps) {
  const { slug } = await params;
  const path = pathFromSlug(slug);

  // 已发布的 DB 页优先（含静态集合外的纯 DB 新页）；否则 fallback 静态。
  const dbPage = await loadPublishedRoutePage(path);
  if (dbPage) return <CmsRenderer page={dbPage} />;

  const route = getOurdreamRoute(path);
  if (!route) notFound();

  return <OurdreamRoutePage route={route} />;
}
