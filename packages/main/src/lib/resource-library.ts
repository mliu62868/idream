import { getOurdreamRoute } from "./ourdream-data";
import { cmsRouteAuthority, isPublicRouteDiscoverable } from "./public-route-authority";

type ResourceCard = { path: string; title: string; description: string };
type PublishedResource = ResourceCard & {
  canonical: string | null;
  indexingStatus: "index" | "noindex";
};

const RESOURCE_PATHS = [
  "/guides/character-cards", "/guides/character-card-creator",
  "/guides/sillytavern-setup-guide", "/comparison", "/create", "/generate",
  "/upgrade", "/helpdesk", "/safety/introduction",
];
const PAGE_SIZE = 24;
export const cmsFamilyIndexPaths = ["/images", "/videos", "/glossary", "/authors"] as const;

function paginateCards(all: ResourceCard[], requestedPage?: string | string[]) {
  const pageCount = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  const parsed = typeof requestedPage === "string" && /^[1-9]\d{0,5}$/.test(requestedPage) ? Number(requestedPage) : 1;
  const page = Math.min(parsed, pageCount);
  return { items: all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), page, pageCount, total: all.length };
}

export function buildCmsFamilyDirectory(path: string, pages: readonly PublishedResource[], query: { q?: string | string[]; page?: string | string[] } = {}) {
  const search = typeof query.q === "string" ? query.q.trim().slice(0, 200) : "";
  const needle = search.toLowerCase();
  const cards = pages.filter(page => page.path.startsWith(`${path}/`) && cmsRouteAuthority(page).discoverable &&
    (!needle || `${page.title} ${page.description} ${page.path}`.toLowerCase().includes(needle)))
    .sort((a, b) => a.path.localeCompare(b.path)).map(({ path, title, description }) => ({ path, title, description }));
  return { ...paginateCards(cards, query.page), search };
}

// SPEC: CMS publication owns discovery too. A noindex/alternate-canonical
// override must remove the old static card, just as it does in the sitemap.
export function buildResourceLibrary(
  publishedPages: readonly PublishedResource[],
  requestedPage?: string | string[],
) {
  const cards = new Map<string, ResourceCard>();
  for (const path of RESOURCE_PATHS) {
    const route = getOurdreamRoute(path);
    if (route && isPublicRouteDiscoverable(path)) cards.set(path, route);
  }
  for (const page of [...publishedPages].sort((a, b) => a.path.localeCompare(b.path))) {
    if (!cmsRouteAuthority(page).discoverable || page.path === "/resources-hub") {
      cards.delete(page.path);
      continue;
    }
    cards.set(page.path, { path: page.path, title: page.title, description: page.description });
  }
  return paginateCards([...cards.values()], requestedPage);
}

export type ResourceLibrary = ReturnType<typeof buildResourceLibrary>;
