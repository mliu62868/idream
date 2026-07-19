import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AuthWorkspace } from "./AuthWorkspace";

describe("AuthWorkspace hydration authority", () => {
  it.each([
    ["signup", 4],
    ["login", 3],
  ] as const)(
    "keeps the %s form non-interactive until client hydration",
    (mode, disabledControlCount) => {
      const markup = renderToStaticMarkup(
        createElement(AuthWorkspace, { mode }),
      );

      expect(markup).toContain('data-auth-ready="false"');
      expect(markup).toContain('aria-busy="true"');
      expect(markup.match(/ disabled=""/g)).toHaveLength(
        disabledControlCount,
      );
    },
  );
});
