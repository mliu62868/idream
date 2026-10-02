import { describe, expect, it, vi } from "vitest";
const read = vi.hoisted(() => vi.fn());
vi.mock("@/server/lib/db", () => ({ prisma: { routePage: { findMany: read } } }));
import { loadPublishedRoutePagesForDistribution } from "./published-route";
import { editorialContent } from "./editorial-content";

describe("Changelog public distribution boundary", () => {
  it("does not return membership content to resources, search or sitemap", async () => {
    const article = editorialContent.find((page) => page.path === "/images")!;
    const row = { ...article, template: "article", canonical: null, contentStatus: "published", contentSchemaVersion: 1, indexingStatus: "index", publishedAt: new Date(), updatedAt: new Date() };
    read.mockResolvedValue([row, { ...row, path: "/changelog", body: { ...row.body, intro: "Private release details must never be distributed to anonymous directories or search, regardless of the CMS indexing setting." } }]);
    const pages = await loadPublishedRoutePagesForDistribution();
    expect(pages.map((page) => page.path)).toEqual(["/images"]);
    expect(JSON.stringify(pages)).not.toContain("Private release details");
  });
});
