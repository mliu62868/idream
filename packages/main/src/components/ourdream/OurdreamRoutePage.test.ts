import { describe, expect, it } from "vitest";
import { hasDedicatedStaticArticleContent } from "@/lib/static-article-authority";
import { hasTrustedStaticRouteContent } from "@/lib/public-route-render-decision";

describe("static article publication authority", () => {
  it("only treats genuinely authored static articles as published", () => {
    expect(hasDedicatedStaticArticleContent("/guides/character-cards")).toBe(
      true,
    );
    expect(
      hasDedicatedStaticArticleContent("/guides/character-card-creator"),
    ).toBe(true);
    expect(
      hasDedicatedStaticArticleContent("/guides/sillytavern-setup-guide"),
    ).toBe(true);
    expect(
      hasDedicatedStaticArticleContent("/type/roleplay-ai-girlfriend"),
    ).toBe(false);
    expect(
      hasDedicatedStaticArticleContent("/sex-chat/ai-sex-chat-roleplay"),
    ).toBe(false);
    expect(
      hasTrustedStaticRouteContent({
        path: "/type/roleplay-ai-girlfriend",
        template: "article",
      }),
    ).toBe(false);
    expect(
      hasTrustedStaticRouteContent({
        path: "/guides/character-cards",
        template: "article",
      }),
    ).toBe(true);
    expect(
      hasTrustedStaticRouteContent({
        path: "/resources-hub",
        template: "library",
      }),
    ).toBe(true);
  });
});
