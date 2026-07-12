import { describe, expect, it } from "vitest";
import {
  supportListPath,
  supportQueryFromSearch,
  supportWorkspaceUrl,
} from "./query";

describe("support query", () => {
  it("restores filters and maps them to the server authority", () => {
    const query = supportQueryFromSearch(
      "?search=refund&status=active&sla=overdue&category=billing&cursor=next",
    );
    expect(query).toEqual({
      search: "refund",
      status: "active",
      sla: "overdue",
      category: "billing",
      cursor: "next",
    });
    expect(supportListPath(query)).toBe(
      "/api/v1/admin/support/requests?limit=25&search=refund&status=active&sla=overdue&category=billing&cursor=next",
    );
  });

  it("preserves unrelated route state", () => {
    const query = supportQueryFromSearch("");
    expect(supportWorkspaceUrl("/admin/support", "?view=inbox", query)).toBe(
      "/admin/support?view=inbox",
    );
  });
});
