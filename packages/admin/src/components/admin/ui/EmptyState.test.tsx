import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EmptyState } from "./EmptyState";

describe("EmptyState", () => {
  // SPEC: "还没有数据"和"当前筛选无结果"是两件事，下一步动作也不同。
  it("offers the way back out of a filter that matched nothing", () => {
    const html = renderToStaticMarkup(
      <EmptyState
        hint="The complete server-side query returned no records."
        kind="filtered"
        onClearFilters={() => {}}
        title="No audit events match these filters"
      />,
    );

    expect(html).toContain("No audit events match these filters");
    expect(html).toContain("Clear filters");
  });

  it("does not offer to clear filters when the authority is simply empty", () => {
    const html = renderToStaticMarkup(<EmptyState hint="Nothing recorded yet." title="No audit events exist yet" />);

    expect(html).toContain("No audit events exist yet");
    expect(html).not.toContain("Clear filters");
  });

  it("lets a caller replace the standard way out with its own call to action", () => {
    const html = renderToStaticMarkup(
      <EmptyState action={<button type="button">Create character</button>} onClearFilters={() => {}} title="Nothing here" />,
    );

    expect(html).toContain("Create character");
    expect(html).not.toContain("Clear filters");
  });
});
