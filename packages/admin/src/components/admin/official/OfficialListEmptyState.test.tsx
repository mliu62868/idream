import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { OfficialListEmptyState } from "./OfficialListEmptyState";

describe("Official character list empty states", () => {
  it("offers to clear filters when the authority has rows but none match the URL query", () => {
    const html = renderToStaticMarkup(
      <OfficialListEmptyState filtered onClear={vi.fn()} />,
    );

    expect(html).toContain("No character projects match these filters.");
    expect(html).toContain("Clear filters");
    expect(html).not.toContain("New character project");
  });

  it("offers the create flow when the authority is genuinely empty", () => {
    const html = renderToStaticMarkup(
      <OfficialListEmptyState filtered={false} onClear={vi.fn()} />,
    );

    expect(html).toContain("No character projects exist yet.");
    expect(html).toContain("New character project");
    expect(html).not.toContain("Clear filters");
  });
});
