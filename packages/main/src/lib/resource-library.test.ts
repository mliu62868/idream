import { describe, expect, it } from "vitest";
import { buildResourceLibrary, buildCmsFamilyDirectory } from "./resource-library";

const article = (path: string, overrides = {}) => ({
  path, title: "Keeping a character consistent", description: "A published character guide.",
  canonical: null, indexingStatus: "index" as const, ...overrides,
});

describe("CMS content family directory", () => {
  it("includes only discoverable details in the current family and follows publication changes", () => {
    const pages = [article("/images"), article("/images/edit-a-source"), article("/videos/animate-a-character"), article("/images/noindex", { indexingStatus: "noindex" as const }), article("/images/duplicate", { canonical: "/images/edit-a-source" })];
    expect(buildCmsFamilyDirectory("/images", pages).items.map(page => page.path)).toEqual(["/images/edit-a-source"]);
    expect(buildCmsFamilyDirectory("/images", pages.filter(page => page.path !== "/images/edit-a-source")).items).toEqual([]);
  });
  it("searches actual published titles and keeps every result reachable with stable pagination", () => {
    const pages = Array.from({ length: 31 }, (_, index) => article(`/glossary/term-${String(index).padStart(2, "0")}`, { title: `Source concept ${index}` }));
    const first = buildCmsFamilyDirectory("/glossary", pages, { q: "Source" }), next = buildCmsFamilyDirectory("/glossary", pages, { q: "Source", page: "2" });
    expect(first.items).toHaveLength(24); expect(next.items).toHaveLength(7); expect(new Set([...first.items, ...next.items].map(page => page.path)).size).toBe(31);
    expect(buildCmsFamilyDirectory("/glossary", pages, { q: "SOURCE CONCEPT 30" }).items.map(page => page.path)).toEqual(["/glossary/term-30"]);
    expect(buildCmsFamilyDirectory("/glossary", pages, { q: "nonexistent" }).total).toBe(0);
  });
});

describe("Resources Hub publication and pagination", () => {
  it("includes a new published article with its current title and removes it when unpublished", () => {
    const page = article("/guides/keeping-a-character-consistent");
    expect(buildResourceLibrary([page]).items).toContainEqual({
      path: page.path, title: page.title, description: page.description,
    });
    expect(buildResourceLibrary([]).items.some(item => item.path === page.path)).toBe(false);
  });

  it("uses CMS discovery authority for static overrides and alternate canonical paths", () => {
    const original = "/guides/character-cards";
    const replacement = article(original, { title: "Updated character cards" });
    const updated = buildResourceLibrary([replacement]).items.filter(item => item.path === original);
    expect(updated).toEqual([{ path: original, title: replacement.title, description: replacement.description }]);
    expect(buildResourceLibrary([
      article(original, { indexingStatus: "noindex" as const }),
      article("/guides/duplicate", { canonical: "/guides/keeping-a-character-consistent" }),
      article("/resources-hub"),
    ]).items.map(item => item.path)).not.toEqual(expect.arrayContaining([original]));
    const paths = buildResourceLibrary([
      article("/guides/duplicate", { canonical: original }),
      article("/resources-hub"),
    ]).items.map(item => item.path);
    expect(paths).not.toContain("/guides/duplicate");
    expect(paths).not.toContain("/resources-hub");
  });

  it("makes every published item reachable beyond the first 24 without duplicates", () => {
    const pages = Array.from({ length: 31 }, (_, index) =>
      article(`/guides/reader-guide-${String(index).padStart(2, "0")}`));
    const first = buildResourceLibrary(pages);
    const second = buildResourceLibrary(pages, "2");
    expect(first.items).toHaveLength(24);
    expect(first.pageCount).toBe(2);
    expect(second.page).toBe(2);
    const allPaths = [...first.items, ...second.items].map(item => item.path);
    expect(new Set(allPaths).size).toBe(first.total);
    expect(allPaths).toEqual(expect.arrayContaining(pages.map(page => page.path)));
    expect(buildResourceLibrary(pages, "999")).toEqual(second);
  });

  it.each([undefined, "-1", "0", "1.5", "2x", ["1", "2"]])("starts at page one for invalid page %j", value => {
    expect(buildResourceLibrary([], value).page).toBe(1);
  });
});
