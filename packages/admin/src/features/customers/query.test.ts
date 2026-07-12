import { describe, expect, it } from "vitest";
import { buildCustomerWorkspaceParams, customerWorkspacePath, parseCustomerWorkspaceParams } from "./query";

describe("customer workspace query", () => {
  it("round-trips filters, cursor, and selection through the URL", () => {
    const params = buildCustomerWorkspaceParams({
      query: { search: "reader@example.test", status: "active", cursor: "opaque:customer:cursor" },
      selectedId: "customer-7",
    });

    expect(parseCustomerWorkspaceParams(params)).toEqual({
      query: { search: "reader@example.test", status: "active", cursor: "opaque:customer:cursor" },
      selectedId: "customer-7",
    });
  });

  it("keeps canonical detail routes stable", () => {
    expect(customerWorkspacePath("customer/7")).toBe("/admin/customers/customer%2F7");
    expect(customerWorkspacePath(null)).toBe("/admin/customers");
  });
});
