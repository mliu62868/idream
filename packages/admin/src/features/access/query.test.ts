import { describe, expect, it } from "vitest";
import { accessListPath, accessPermissionConfirmation, accessQueryFromSearch, accessStatusConfirmation, accessWorkspaceUrl } from "./query";

describe("access query", () => {
  it("restores URL query state and maps it to server search/filter/cursor", () => {
    const query = accessQueryFromSearch("?accessSearch=amy&accessRole=support&accessStatus=active&accessCursor=next");
    expect(query).toEqual({ search: "amy", role: "support", status: "active", cursor: "next" });
    expect(accessListPath(query)).toBe("/api/v1/admin/users?q=amy&role=support&status=active&cursor=next&limit=25");
  });

  it("preserves unrelated canonical route state and exact confirmation contracts", () => {
    expect(accessWorkspaceUrl("/admin/system/access", "?view=team", { search: "", role: "", status: "", cursor: "" })).toBe("/admin/system/access?view=team");
    expect(accessPermissionConfirmation("user-1", "billing.ledger.adjust", "grant")).toBe("user-1:billing.ledger.adjust:grant");
    expect(accessStatusConfirmation("user-1", "suspended")).toBe("user-1:suspended");
  });
});
