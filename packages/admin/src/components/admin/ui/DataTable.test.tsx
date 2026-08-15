import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DataTable } from "./DataTable";

describe("DataTable", () => {
  it("keeps the final action column visible when a wide operator table scrolls", () => {
    const html = renderToStaticMarkup(
      <DataTable
        caption="Subscriptions"
        headers={["ID", "Action"]}
        rows={[{ id: "subscription-1", cells: ["subscription-1", "Refund"] }]}
        stickyLastColumn
      />,
    );

    expect(html.match(/sticky right-0/g)).toHaveLength(2);
    expect(html).toContain("border-l border-[var(--ad-border)]");
  });

  it("leaves ordinary data columns non-sticky by default", () => {
    const html = renderToStaticMarkup(
      <DataTable
        caption="Ledger"
        headers={["ID", "Balance"]}
        rows={[{ id: "entry-1", cells: ["entry-1", "242"] }]}
      />,
    );

    expect(html).not.toContain("sticky right-0");
  });
});
