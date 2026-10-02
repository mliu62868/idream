import { describe, expect, it } from "vitest";
import { editorialContent } from "./editorial-content";
import { validateCmsPublication } from "./route-page-contract";
import { ourdreamRoutePaths } from "@/lib/ourdream-data";

describe("Original CMS content staging contract", () => {
  it("provides a publishable index and independent detail in every required content family", () => {
    const paths = editorialContent.map(page => page.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const family of ["images", "videos", "glossary", "authors"]) {
      expect(paths).toContain(`/${family}`);
      expect(paths.some(path => path.startsWith(`/${family}/`))).toBe(true);
    }
    for (const page of editorialContent) expect(() => validateCmsPublication({ ...page, template: "article", canonical: page.path, indexingStatus: "index" }), page.path).not.toThrow();
  });
  it("links only real application or supplied CMS destinations, without claiming a personal author", () => {
    const paths = new Set([...ourdreamRoutePaths, ...editorialContent.map(page => page.path), "/"]);
    for (const page of editorialContent) if (page.body.cta) expect(paths.has(page.body.cta.href), page.path).toBe(true);
    const author = editorialContent.find(page => page.path === "/authors/idream-guides")!;
    expect(author.body.intro).toContain("the publication label"); expect(author.body.intro).toContain("practical task");
  });
});
