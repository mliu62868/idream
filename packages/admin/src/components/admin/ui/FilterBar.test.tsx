import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FilterBar } from "./FilterBar";

const search = { search: "", onSearch: () => {}, searchPlaceholder: "Search jobs" };
const selects = [{ name: "Status", value: "", onChange: () => {}, options: [{ value: "", label: "All" }] }];

describe("FilterBar", () => {
  // SPEC: 只有一两个下拉的列表页保持单行 —— 把它们折起来只会多一次点击。
  it("keeps a short filter row inline", () => {
    const html = renderToStaticMarkup(<FilterBar {...search} selects={selects} />);

    expect(html).toContain('aria-label="Search jobs"');
    expect(html).toContain(">All</option>");
    expect(html).not.toContain("Filters");
  });

  // SPEC: 字段多的页面折叠起来，首屏留给结果；搜索框常驻。
  it("hides the secondary fields behind a disclosure but never the search box", () => {
    const html = renderToStaticMarkup(
      <FilterBar
        {...search}
        collapsible
        inputs={[{ name: "Actor ID", value: "", onChange: () => {} }]}
        selects={selects}
      />,
    );

    expect(html).toContain('aria-label="Search jobs"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Filters");
    expect(html).not.toContain("Actor ID");
    expect(html).not.toContain("</select>");
  });

  it("states the active conditions as chips, each with its own way out", () => {
    const html = renderToStaticMarkup(
      <FilterBar
        {...search}
        chips={[
          { key: "mode", label: "Mode", value: "Video", onClear: () => {} },
          { key: "provider", label: "Provider", value: "comfyui", onClear: () => {} },
        ]}
        collapsible
        onReset={() => {}}
      />,
    );

    expect(html).toContain("Video");
    expect(html).toContain("comfyui");
    expect(html).toContain('aria-label="Clear filter Mode"');
    expect(html).toContain('aria-label="Clear filter Provider"');
    expect(html).toContain("Reset all");
    // 收起时用一个计数告诉运营还有几条条件在生效。
    expect(html).toContain(">2</span>");
  });

  it("offers no reset-all and no chip row when nothing is filtered", () => {
    const html = renderToStaticMarkup(<FilterBar {...search} collapsible onReset={() => {}} />);

    expect(html).not.toContain("Reset all");
  });
});
