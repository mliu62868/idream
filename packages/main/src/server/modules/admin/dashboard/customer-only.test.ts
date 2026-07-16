import { describe, expect, it } from "vitest";
import {
  customerContentReportWhere,
  customerGenerationJobWhere,
  customerSubscriptionWhere,
  customerUserWhere,
} from "./customer-only";

describe("admin dashboard customer-only query helpers", () => {
  it("keeps operational filters inside the customer audience boundary", () => {
    expect(customerUserWhere({ status: "active", deletedAt: null })).toEqual({
      AND: [
        { dataClass: "customer" },
        { status: "active", deletedAt: null },
      ],
    });
    expect(customerSubscriptionWhere({ status: "active" })).toEqual({
      AND: [
        { user: { is: { dataClass: "customer" } } },
        { status: "active" },
      ],
    });
    expect(customerGenerationJobWhere({ status: "completed" })).toEqual({
      AND: [
        { user: { is: { dataClass: "customer" } } },
        { status: "completed" },
      ],
    });
    expect(customerContentReportWhere({ status: "open" })).toEqual({
      AND: [
        { reporter: { is: { dataClass: "customer" } } },
        { status: "open" },
      ],
    });
  });
});
