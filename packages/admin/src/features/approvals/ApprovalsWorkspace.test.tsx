import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApprovalsWorkspace } from "./ApprovalsWorkspace";

describe("Approvals workspace permissions", () => {
  it("renders an explicit read-only state without review permission", () => {
    const html = renderToStaticMarkup(<ApprovalsWorkspace canReview={false} />);
    expect(html).toContain("admin.approval.review is not granted");
  });
});
