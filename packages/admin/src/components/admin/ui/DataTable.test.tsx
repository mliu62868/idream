import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DataTable } from "./DataTable";

const rows = [{ id: "subscription-1", cells: ["subscription-1", "Refund"] }];

describe("DataTable", () => {
  it("keeps the final action column visible when a wide operator table scrolls", () => {
    const html = renderToStaticMarkup(
      <DataTable caption="Subscriptions" headers={["ID", "Action"]} rows={rows} stickyLastColumn />,
    );

    expect(html.match(/sticky right-0/g)).toHaveLength(2);
    expect(html).toContain("border-l border-[var(--ad-border)]");
  });

  it("leaves ordinary data columns non-sticky by default", () => {
    const html = renderToStaticMarkup(
      <DataTable caption="Ledger" headers={["ID", "Balance"]} rows={[{ id: "entry-1", cells: ["entry-1", "242"] }]} />,
    );

    expect(html).not.toContain("sticky right-0");
    expect(html).not.toContain("sticky top-0");
  });

  it("keeps column names on screen while a long table scrolls vertically", () => {
    const html = renderToStaticMarkup(
      <DataTable caption="Ledger" headers={["ID"]} rows={rows} stickyHeader />,
    );

    expect(html).toContain("sticky top-0");
    expect(html).toContain("max-h-[70vh]");
  });

  // SPEC: 加载态是页大小条骨架行，不是一句 Loading —— 数据落地时表格不跳高度。
  it("renders one skeleton row per expected result instead of a loading sentence", () => {
    const html = renderToStaticMarkup(
      <DataTable caption="Generation Jobs" empty={<p>No jobs</p>} headers={["ID", "Status"]} loading rows={[]} skeletonRows={4} />,
    );

    expect(html.match(/animate-pulse/g)).toHaveLength(8);
    expect(html).toContain("Loading Generation Jobs…");
    expect(html).toContain('aria-busy="true"');
    // 还在加载时不能把零行说成空。
    expect(html).not.toContain("No jobs");
  });

  it("shows the caller's empty state only once the authority has answered", () => {
    const html = renderToStaticMarkup(
      <DataTable caption="Generation Jobs" empty={<p>No jobs</p>} headers={["ID"]} rows={[]} />,
    );

    expect(html).toContain("No jobs");
    expect(html).not.toContain("animate-pulse");
  });

  it("says the request failed instead of claiming the authority is empty", () => {
    const html = renderToStaticMarkup(
      <DataTable caption="Generation Jobs" empty={<p>No jobs</p>} error="Upstream timed out" headers={["ID"]} rows={[]} />,
    );

    expect(html).toContain("Upstream timed out");
    expect(html).not.toContain("No jobs");
  });

  it("keeps the stale rows readable while reporting the failed refresh", () => {
    const html = renderToStaticMarkup(
      <DataTable caption="Generation Jobs" error="Upstream timed out" headers={["ID", "Action"]} rows={rows} />,
    );

    expect(html).toContain("Upstream timed out");
    expect(html).toContain("subscription-1");
  });

  it("switches row padding between scanning and reading density", () => {
    const compact = renderToStaticMarkup(<DataTable caption="Ledger" density="compact" headers={["ID", "Action"]} rows={rows} />);
    const comfortable = renderToStaticMarkup(<DataTable caption="Ledger" headers={["ID", "Action"]} rows={rows} />);

    expect(compact).toContain("px-3 py-1.5");
    expect(compact).not.toContain("px-4 py-3");
    expect(comfortable).toContain("px-4 py-3");
  });

  it("clamps long identifier columns to their width and exposes the full value", () => {
    const html = renderToStaticMarkup(
      <DataTable
        caption="Ledger"
        headers={[{ label: "Reason", truncate: true, width: "12rem" }, { label: "Amount", align: "right" }]}
        rows={[{ id: "entry-1", cells: ["a very long operator reason", "242"] }]}
      />,
    );

    expect(html).toContain('title="a very long operator reason"');
    expect(html).toContain("truncate");
    expect(html).toContain("text-right tabular-nums");
  });

  it("offers bulk actions only once rows are selected", () => {
    const unselected = renderToStaticMarkup(
      <DataTable caption="Ledger" headers={["ID"]} rows={rows} selection={{ selected: [], onChange: () => {} }} />,
    );
    const selected = renderToStaticMarkup(
      <DataTable
        caption="Ledger"
        headers={["ID"]}
        rows={rows}
        selection={{ actions: <button type="button">Copy IDs</button>, onChange: () => {}, selected: ["subscription-1"] }}
      />,
    );

    expect(unselected).toContain('aria-label="Select all rows on this page"');
    expect(unselected).not.toContain("selected");
    expect(selected).toContain("1 selected");
    expect(selected).toContain("Copy IDs");
    expect(selected).toContain("Clear selection");
  });
});
