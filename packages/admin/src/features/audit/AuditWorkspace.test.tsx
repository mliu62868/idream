import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AuditWorkspace } from "./AuditWorkspace";

describe("Audit operator workspace", () => {
  it("renders authority-backed filters and a structure-matched accessible loading state", () => {
    const html = renderToStaticMarkup(<AuditWorkspace />);

    expect(html).toContain("Audit Log");
    expect(html).toContain("Search audit authority");
    expect(html).toContain("Exact action");
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="Loading audit authority"');
    expect(html).toContain("freshness watermark unavailable");
  });
});
