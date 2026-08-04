import {
  buildCompatibilityListUrl,
  readCompatibilityListQuery,
} from "@/features/compatibility-lists/query";

export type AnnouncementQuery = {
  announcementSearch: string;
  announcementLevel: string;
  announcementActive: string;
  announcementCursor: string;
};

const queryKeys = [
  "announcementSearch",
  "announcementLevel",
  "announcementActive",
  "announcementCursor",
] as const;

export function announcementQueryFromSearch(search: string): AnnouncementQuery {
  return readCompatibilityListQuery(
    new URLSearchParams(search),
    queryKeys,
  ) as AnnouncementQuery;
}

export function announcementListPath(query: AnnouncementQuery) {
  const params = new URLSearchParams({ limit: "25" });
  set(params, "search", query.announcementSearch);
  set(params, "level", query.announcementLevel);
  set(params, "active", query.announcementActive);
  set(params, "cursor", query.announcementCursor);
  return `/api/v1/admin/announcements?${params.toString()}`;
}

export function announcementWorkspaceUrl(
  pathname: string,
  search: string,
  updates: Readonly<Record<string, string | null>>,
  clearCursor = false,
) {
  return buildCompatibilityListUrl(
    pathname,
    search,
    updates,
    clearCursor ? ["announcementCursor"] : [],
  );
}

function set(params: URLSearchParams, key: string, value: string) {
  if (value) params.set(key, value);
}
