import { unstable_cache } from "next/cache";
import { prisma } from "@/server/lib/db";
import { logger } from "@/server/lib/logger";
import {
  CMS_CONTENT_SCHEMA_VERSION,
  cmsCacheTag,
  inspectCmsPublication,
  validateCmsPublication,
  type CmsArticleBody,
  type CmsIndexingStatus,
  type CmsPublicationCandidate,
} from "@/server/cms/route-page-contract";

export type PublishedRoutePage = {
  body: CmsArticleBody;
  canonical: string | null;
  description: string;
  indexingStatus: CmsIndexingStatus;
  path: string;
  publishedAt: Date;
  template: "article";
  title: string;
  updatedAt: Date;
};

export type CmsRouteResolution =
  | { state: "published"; page: PublishedRoutePage }
  | { state: "absent"; reason: "missing" | "not_published" }
  | {
      state: "invalid";
      issues: Array<{ code: string; path: string }>;
    }
  | { state: "unavailable" };

type RoutePageRow = CmsPublicationCandidate & {
  contentSchemaVersion: number | null;
  contentStatus: string;
  publishedAt: Date | null;
  updatedAt: Date;
};

const routePageSelect = {
  path: true,
  template: true,
  title: true,
  description: true,
  canonical: true,
  contentStatus: true,
  contentSchemaVersion: true,
  indexingStatus: true,
  body: true,
  publishedAt: true,
  updatedAt: true,
} as const;

export function resolveCmsRouteRow(
  row: RoutePageRow | null,
): Exclude<CmsRouteResolution, { state: "unavailable" }> {
  if (!row) return { state: "absent", reason: "missing" };
  if (row.contentStatus !== "published") {
    return { state: "absent", reason: "not_published" };
  }

  if (
    row.contentSchemaVersion !== CMS_CONTENT_SCHEMA_VERSION ||
    row.publishedAt === null
  ) {
    return {
      state: "invalid",
      issues: [
        {
          code: "invalid_publication_version",
          path: "contentSchemaVersion",
        },
      ],
    };
  }

  const candidate = {
    body: row.body,
    canonical: row.canonical,
    description: row.description,
    indexingStatus: row.indexingStatus,
    path: row.path,
    template: row.template,
    title: row.title,
  };
  const readiness = inspectCmsPublication(candidate);
  if (readiness.publishability === "blocked") {
    return {
      state: "invalid",
      issues: readiness.issues.map((issue) => ({
        code: issue.code,
        path: issue.path,
      })),
    };
  }

  const validated = validateCmsPublication(candidate);
  return {
    state: "published",
    page: {
      body: validated.body,
      canonical: validated.canonical,
      description: validated.description,
      indexingStatus: validated.indexingStatus,
      path: validated.path,
      publishedAt: row.publishedAt,
      template: validated.template,
      title: validated.title,
      updatedAt: row.updatedAt,
    },
  };
}

export async function resolveCmsRouteWithReader(
  path: string,
  read: (path: string) => Promise<RoutePageRow | null>,
): Promise<CmsRouteResolution> {
  try {
    return resolveCmsRouteRow(await read(path));
  } catch (error) {
    logger.error(
      {
        errorKind: error instanceof Error ? error.name : typeof error,
        path,
      },
      "CMS route authority is unavailable",
    );
    return { state: "unavailable" };
  }
}

export async function loadPublishedRoutePage(
  path: string,
): Promise<CmsRouteResolution> {
  const cached = unstable_cache(
    async () => {
      const row = await prisma.routePage.findUnique({
        where: { path },
        select: routePageSelect,
      });
      return resolveCmsRouteRow(row);
    },
    ["cms-route-page", path],
    {
      revalidate: 60,
      tags: ["cms-pages", cmsCacheTag(path)],
    },
  );

  try {
    return await cached();
  } catch (error) {
    // Rejections are not converted into a cacheable "missing" result.
    logger.error(
      {
        errorKind: error instanceof Error ? error.name : typeof error,
        path,
      },
      "CMS route read failed",
    );
    return { state: "unavailable" };
  }
}

export async function loadPublishedRoutePagesForDistribution(): Promise<
  PublishedRoutePage[]
> {
  try {
    const rows = await prisma.routePage.findMany({
      where: {
        contentStatus: "published",
        contentSchemaVersion: CMS_CONTENT_SCHEMA_VERSION,
      },
      select: routePageSelect,
      orderBy: { path: "asc" },
    });
    return rows
      .map(resolveCmsRouteRow)
      .filter(
        (
          resolution,
        ): resolution is Extract<CmsRouteResolution, { state: "published" }> =>
          resolution.state === "published",
      )
      .map((resolution) => resolution.page);
  } catch (error) {
    logger.error(
      {
        errorKind: error instanceof Error ? error.name : typeof error,
      },
      "CMS sitemap authority is unavailable",
    );
    throw new Error("CMS sitemap authority is unavailable", { cause: error });
  }
}

export async function loadIndexablePublishedRoutePages(): Promise<
  PublishedRoutePage[]
> {
  return (await loadPublishedRoutePagesForDistribution()).filter(
    (page) =>
      page.indexingStatus === "index" &&
      (page.canonical === null || page.canonical === page.path),
  );
}
