import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Pagination, paginationSummary } from "./Pagination";

describe("paginationSummary", () => {
  it("names the exact slice the operator is looking at", () => {
    expect(paginationSummary({ page: 4, pageSize: 25, rowCount: 20, totalCount: 95 }))
      .toEqual({ from: 76, to: 95, pageCount: 4 });
  });

  it("counts a partly filled first page from one", () => {
    expect(paginationSummary({ page: 1, pageSize: 25, rowCount: 3, totalCount: 3 }))
      .toEqual({ from: 1, to: 3, pageCount: 1 });
  });

  it("starts at zero rather than claiming a first row that is not there", () => {
    expect(paginationSummary({ page: 1, pageSize: 25, rowCount: 0, totalCount: 0 }))
      .toEqual({ from: 0, to: 0, pageCount: 1 });
  });

  // SPEC: 游标分页的后端只知道「还有下一页」，不知道总数 —— 这时不编造总页数。
  it("refuses to invent a page count the cursor API cannot know", () => {
    expect(paginationSummary({ page: 2, pageSize: 25, rowCount: 25 }).pageCount).toBeNull();
  });
});

describe("Pagination", () => {
  const controls = {
    hasNext: true,
    hasPrevious: false,
    onNext: () => {},
    onPrevious: () => {},
  };

  it("tells the operator which page of how many they are on", () => {
    const html = renderToStaticMarkup(
      <Pagination {...controls} page={4} pageSize={25} rowCount={20} totalCount={95} />,
    );

    expect(html).toContain("Page 4 of 4");
    expect(html).toContain("Showing 76–95 of 95");
    expect(html).toContain("Previous page");
    expect(html).toContain("Next page");
  });

  it("disables the way back off the first page", () => {
    const html = renderToStaticMarkup(
      <Pagination {...controls} page={1} pageSize={25} rowCount={25} totalCount={95} />,
    );

    expect(html.match(/disabled=""/g)).toHaveLength(1);
  });

  it("offers a page size only when the caller can act on it", () => {
    const without = renderToStaticMarkup(<Pagination {...controls} page={1} pageSize={25} rowCount={25} />);
    const with_ = renderToStaticMarkup(
      <Pagination {...controls} onPageSizeChange={() => {}} page={1} pageSize={50} rowCount={50} />,
    );

    expect(without).not.toContain("Rows per page");
    expect(without).toContain("Page 1");
    expect(with_).toContain("Rows per page");
    expect(with_).toContain('value="50"');
  });
});
