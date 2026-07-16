import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LegacyTestAssetBadge } from "./LegacyTestAssetBadge";

describe("LegacyTestAssetBadge", () => {
  it("labels synthetic media as a demo legacy test asset", () => {
    const markup = renderToStaticMarkup(
      createElement(LegacyTestAssetBadge, { isSynthetic: true }),
    );

    expect(markup).toContain("Demo / legacy test asset");
    expect(markup).toContain('data-testid="legacy-test-asset-badge"');
  });

  it("does not label authoritative media", () => {
    expect(
      renderToStaticMarkup(
        createElement(LegacyTestAssetBadge, { isSynthetic: false }),
      ),
    ).toBe("");
  });
});
