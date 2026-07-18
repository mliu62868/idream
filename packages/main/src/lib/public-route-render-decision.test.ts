import { describe, expect, it } from "vitest";

import { publicRouteRenderDecision } from "./public-route-render-decision";

const staticArticle = {
  path: "/guides/character-cards",
  template: "article" as const,
};
const unpublishedArticle = {
  path: "/guides/how-to-use-character-ai",
  template: "article" as const,
};
const productSurface = {
  path: "/resources-hub",
  template: "library" as const,
};
const genericGenerator = {
  path: "/generate/ai-porn",
  template: "generator" as const,
};
const genericComparison = {
  path: "/comparison/character-ai-alternative",
  template: "comparison" as const,
};

describe("public route render decision", () => {
  it("gives a valid CMS publication highest authority", () => {
    expect(
      publicRouteRenderDecision(unpublishedArticle, "published"),
    ).toBe("cms");
    expect(publicRouteRenderDecision(undefined, "published")).toBe("cms");
  });

  it("only falls back to trusted static content", () => {
    expect(publicRouteRenderDecision(staticArticle, "absent")).toBe("static");
    expect(publicRouteRenderDecision(productSurface, "absent")).toBe("static");
    expect(publicRouteRenderDecision(unpublishedArticle, "absent")).toBe(
      "not_found",
    );
    expect(publicRouteRenderDecision(genericGenerator, "absent")).toBe(
      "not_found",
    );
    expect(publicRouteRenderDecision(genericComparison, "absent")).toBe(
      "not_found",
    );
  });

  it("fails closed when a non-static CMS authority is invalid or unavailable", () => {
    expect(publicRouteRenderDecision(unpublishedArticle, "invalid")).toBe(
      "authority_error",
    );
    expect(publicRouteRenderDecision(undefined, "unavailable")).toBe(
      "authority_error",
    );
    expect(publicRouteRenderDecision(staticArticle, "unavailable")).toBe(
      "static",
    );
    expect(publicRouteRenderDecision(genericGenerator, "unavailable")).toBe(
      "authority_error",
    );
  });
});
