import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  getOurdreamRoute,
  ourdreamRoutePaths,
} from "@/lib/ourdream-data";
import { OurdreamRoutePage } from "@/components/ourdream/OurdreamRoutePage";

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
  const route = getOurdreamRoute(pathFromSlug(slug));

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
  const route = getOurdreamRoute(pathFromSlug(slug));

  if (!route) notFound();

  return <OurdreamRoutePage route={route} />;
}
