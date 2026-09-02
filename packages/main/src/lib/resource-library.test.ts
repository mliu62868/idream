import { describe, expect, it } from "vitest";
import { buildResourceLibrary } from "./resource-library";

const article = (path: string, overrides = {}) => ({
  path, title: "Keeping a character consistent", description: "A published character guide.",
  canonical: null, indexingStatus: "index" as const, ...overrides,
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
