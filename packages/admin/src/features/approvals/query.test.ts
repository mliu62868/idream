import { describe, expect, it } from "vitest";
import {
  approvalListPath,
  approvalQueryFromSearch,
  approvalWorkspaceUrl,
} from "./query";

describe("approval query", () => {
  it("restores server filters and stable cursor", () => {
    const query = approvalQueryFromSearch(
      "?approvalSearch=release&approvalStatus=approved&approvalCursor=next",
    );
    expect(query).toEqual({
      search: "release",
      status: "approved",
      cursor: "next",
    });
    expect(approvalListPath(query)).toBe(
      "/api/v2/admin/approvals?limit=25&search=release&status=approved&cursor=next",
    );
  });

  it("keeps unrelated route state", () => {
    const query = approvalQueryFromSearch("");
    expect(approvalWorkspaceUrl("/admin/approvals", "?view=queue", query)).toBe(
      "/admin/approvals?view=queue",
    );
  });
});
