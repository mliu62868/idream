import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ContentMerchandisingWorkspace } from "./ContentMerchandisingWorkspace";

describe("Content merchandising permissions", () => {
  it("renders independent authority freshness and read-only state", () => {
    const html = renderToStaticMarkup(<ContentMerchandisingWorkspace canWrite={false} />);
    expect(html).toContain("Characters: refreshing");
    expect(html).toContain("Featured: refreshing");
    expect(html).toContain("content.takedown.write is not granted");
  });
});
