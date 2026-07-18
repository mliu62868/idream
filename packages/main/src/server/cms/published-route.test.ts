import { describe, expect, it } from "vitest";
import {
  resolveCmsRouteRow,
  resolveCmsRouteWithReader,
} from "./published-route";

const validRow = {
  path: "/guides/cms-resolution-test",
  template: "article",
  title: "CMS resolution contract guide",
  description:
    "A complete CMS article used to prove that only versioned, validated content reaches the public renderer.",
  canonical: null,
  contentStatus: "published",
  contentSchemaVersion: 1,
  indexingStatus: "noindex",
  body: {
    heading: "CMS resolution contract",
    intro:
      "This complete introduction proves that public CMS content has meaningful context before it can become visible to users.",
    sections: [
      {
        heading: "Validate the draft",
        paragraphs: [
          "The publication command validates every field and records a version before the public route is allowed to render the article.",
        ],
      },
      {
        heading: "Resolve explicit states",
        paragraphs: [
          "The public reader keeps missing, unpublished, invalid, and temporarily unavailable content as separate observable states.",
        ],
      },
    ],
  },
  publishedAt: new Date("2026-07-16T12:00:00.000Z"),
  updatedAt: new Date("2026-07-16T12:00:00.000Z"),
};

describe("published RoutePage resolution", () => {
  it("distinguishes missing and unpublished rows", () => {
    expect(resolveCmsRouteRow(null)).toEqual({
      state: "absent",
      reason: "missing",
    });
    expect(
      resolveCmsRouteRow({
        ...validRow,
        contentStatus: "draft",
        contentSchemaVersion: null,
        publishedAt: null,
      }),
    ).toEqual({ state: "absent", reason: "not_published" });
  });

  it("returns a fully parsed published page", () => {
    expect(resolveCmsRouteRow(validRow)).toMatchObject({
      state: "published",
      page: {
        path: validRow.path,
        template: "article",
        body: { heading: "CMS resolution contract" },
      },
    });
  });

  it("fails closed for legacy versions and malformed bodies", () => {
    expect(
      resolveCmsRouteRow({
        ...validRow,
        contentSchemaVersion: null,
      }),
    ).toMatchObject({
      state: "invalid",
      issues: [{ code: "invalid_publication_version" }],
    });
    expect(
      resolveCmsRouteRow({
        ...validRow,
        body: { heading: { unsafe: true }, sections: [null] },
      }),
    ).toMatchObject({ state: "invalid" });
  });

  it("does not turn an authority failure into a missing page", async () => {
    await expect(
      resolveCmsRouteWithReader(validRow.path, async () => {
        throw new Error("database unavailable");
      }),
    ).resolves.toEqual({ state: "unavailable" });
  });
});
