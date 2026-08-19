import { describe, expect, it } from "vitest";
import { accessListPath, accessPermissionConfirmation, accessQueryFromSearch, accessStatusConfirmation, accessWorkspaceUrl } from "./query";

describe("access query", () => {
  it("restores URL query state and maps it to server search/filter/cursor", () => {
    const query = accessQueryFromSearch("?accessSearch=amy&accessRole=support&accessStatus=active&accessDataClass=internal&accessCursor=next");
    expect(query).toEqual({
      search: "amy",
      role: "support",
      status: "active",
      dataClass: "internal",
      cursor: "next",
    });
    expect(accessListPath(query)).toBe("/api/v2/admin/users?q=amy&role=support&status=active&dataClass=internal&cursor=next&limit=25");
  });

  it("preserves unrelated canonical route state and exact confirmation contracts", () => {
    expect(accessWorkspaceUrl("/admin/system/access", "?view=team", {
      search: "",
      role: "",
      status: "",
      dataClass: "",
      cursor: "",
    })).toBe("/admin/system/access?view=team");
    expect(accessPermissionConfirmation("user-1", "billing.ledger.adjust", "grant")).toBe("user-1:billing.ledger.adjust:grant");
    expect(accessStatusConfirmation("user-1", "suspended")).toBe("user-1:suspended");
  });

  it("fails closed to all data classes when URL state contains an unsupported value", () => {
    expect(accessQueryFromSearch("?accessDataClass=unknown").dataClass).toBe("");
  });
});
