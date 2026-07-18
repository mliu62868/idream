import { describe, expect, it } from "vitest";
import { buildSitemap } from "./sitemap";

describe("sitemap distribution authority", () => {
  it("lets a valid published noindex CMS override remove a static URL", () => {
    const entries = buildSitemap(
      [
        {
          canonical: null,
          indexingStatus: "noindex",
          path: "/resources-hub",
          publishedAt: new Date("2026-07-16T00:00:00.000Z"),
        },
      ],
      new URL("https://idream.test"),
    );

    expect(entries.some((entry) => entry.url.endsWith("/resources-hub"))).toBe(
      false,
    );
  });

  it("adds only self-canonical index publications", () => {
    const entries = buildSitemap(
      [
        {
          canonical: "/",
          indexingStatus: "noindex",
          path: "/guides/cross-canonical",
          publishedAt: new Date("2026-07-16T00:00:00.000Z"),
        },
        {
          canonical: "/guides/published",
          indexingStatus: "index",
          path: "/guides/published",
          publishedAt: new Date("2026-07-16T00:00:00.000Z"),
        },
      ],
      new URL("https://idream.test"),
    );

    expect(entries.map((entry) => entry.url)).toContain(
      "https://idream.test/guides/published",
    );
    expect(entries.map((entry) => entry.url)).not.toContain(
      "https://idream.test/guides/cross-canonical",
    );
  });
});
