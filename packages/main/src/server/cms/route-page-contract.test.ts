import { describe, expect, it } from "vitest";
import {
  cmsArticleBodySchema,
  cmsCacheTag,
  cmsCanonicalSchema,
  cmsPathSchema,
  inspectCmsPublication,
  validateCmsPublication,
} from "./route-page-contract";

const validBody = {
  heading: "Build a consistent character card",
  intro:
    "A useful character card keeps identity, voice, visual anchors, and the opening relationship aligned across the complete product workflow.",
  sections: [
    {
      heading: "Define the identity",
      paragraphs: [
        "Start with the stable facts that should remain true in discovery, private chat, and every character-aware image generation request.",
      ],
    },
    {
      heading: "Test the first scene",
      paragraphs: [
        "Run the opening conversation, verify the voice and relationship, and revise the source card before treating the character as complete.",
      ],
    },
  ],
};

describe("RoutePage publication contract", () => {
  it("accepts a complete article and preserves explicit index authority", () => {
    expect(
      validateCmsPublication({
        body: validBody,
        canonical: null,
        description:
          "A practical guide to creating consistent character cards for chat and image generation.",
        indexingStatus: "index",
        path: "/guides/consistent-character-card",
        template: "article",
        title: "Consistent character card guide",
      }),
    ).toMatchObject({
      indexingStatus: "index",
      template: "article",
    });
  });

  it("rejects placeholder, malformed, and unknown body content", () => {
    expect(cmsArticleBodySchema.safeParse({ eyebrow: "Guide" }).success).toBe(
      false,
    );
    expect(
      cmsArticleBodySchema.safeParse({
        ...validBody,
        sections: [null],
      }).success,
    ).toBe(false);
    expect(
      cmsArticleBodySchema.safeParse({
        ...validBody,
        unknown: "not silently stripped",
      }).success,
    ).toBe(false);
  });

  it("rejects application-owned and non-normalized paths", () => {
    for (const path of [
      "/",
      "/api/v1/plans",
      "/chat/session",
      "/profile",
      "/Guides/Bad",
      "/guides/trailing/",
      "/guides/page?draft=1",
      "//guides/page",
    ]) {
      expect(cmsPathSchema.safeParse(path).success, path).toBe(false);
    }
    expect(cmsPathSchema.safeParse("/guides/real-page").success).toBe(true);
  });

  it("only allows normalized internal canonicals", () => {
    expect(cmsCanonicalSchema.safeParse("/").success).toBe(true);
    expect(cmsCanonicalSchema.safeParse("/guides/real-page").success).toBe(
      true,
    );
    expect(cmsCanonicalSchema.safeParse(null).success).toBe(true);
    expect(
      cmsCanonicalSchema.safeParse("https://competitor.example/page").success,
    ).toBe(false);
    expect(cmsCanonicalSchema.safeParse("/guides/page?q=1").success).toBe(false);
  });

  it("allows the site root as a canonical or CTA without allowing it as a CMS page path", () => {
    expect(cmsPathSchema.safeParse("/").success).toBe(false);
    expect(
      cmsArticleBodySchema.safeParse({
        ...validBody,
        cta: { label: "Explore", href: "/" },
      }).success,
    ).toBe(true);
  });

  it.each([
    [
      "short title",
      {
        title: "Too short",
      },
      "title",
    ],
    [
      "short description",
      {
        description: "Too short",
      },
      "description",
    ],
    [
      "one section",
      {
        body: { ...validBody, sections: validBody.sections.slice(0, 1) },
      },
      "body.sections",
    ],
    [
      "short paragraph",
      {
        body: {
          ...validBody,
          sections: [
            {
              ...validBody.sections[0],
              paragraphs: ["Too short"],
            },
            validBody.sections[1],
          ],
        },
      },
      "body.sections.0.paragraphs.0",
    ],
    [
      "duplicate section headings",
      {
        body: {
          ...validBody,
          sections: [
            validBody.sections[0],
            {
              ...validBody.sections[1],
              heading: validBody.sections[0].heading,
            },
          ],
        },
      },
      "body.sections",
    ],
    [
      "non-HTTPS CTA",
      {
        body: {
          ...validBody,
          cta: { label: "Read more", href: "http://example.com/guide" },
        },
      },
      "body.cta.href",
    ],
    [
      "non-article template",
      {
        template: "marketing",
      },
      "template",
    ],
    [
      "cross-canonical index page",
      {
        canonical: "/guides/other-page",
      },
      "canonical",
    ],
  ])("reports %s as a publication blocker", (_label, override, issuePath) => {
    const readiness = inspectCmsPublication({
      body: validBody,
      canonical: null,
      description:
        "A practical guide to creating consistent character cards for chat and image generation.",
      indexingStatus: "index",
      path: "/guides/consistent-character-card",
      template: "article",
      title: "Consistent character card guide",
      ...override,
    });

    expect(readiness.publishability).toBe("blocked");
    expect(readiness.issues.some((issue) => issue.path === issuePath)).toBe(
      true,
    );
  });

  it("returns an explicit ready state for a complete publication", () => {
    expect(
      inspectCmsPublication({
        body: validBody,
        canonical: "/guides/consistent-character-card",
        description:
          "A practical guide to creating consistent character cards for chat and image generation.",
        indexingStatus: "index",
        path: "/guides/consistent-character-card",
        template: "article",
        title: "Consistent character card guide",
      }),
    ).toEqual({ publishability: "ready", issues: [] });
  });

  it("uses a bounded, deterministic cache tag for any valid path length", () => {
    const tag = cmsCacheTag(`/guides/${"long-segment-".repeat(30)}page`);
    expect(tag).toMatch(/^cms-page:[a-f0-9]{32}$/);
    expect(tag.length).toBeLessThanOrEqual(256);
  });
});
