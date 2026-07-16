import { describe, expect, it } from "vitest";
import {
  CUSTOMER_METRIC_DATA_SCOPE,
  OPERATIONAL_EVENT_DATA_CLASSES,
  OPERATIONAL_METRIC_DATA_SCOPE,
  OPERATIONAL_USER_DATA_CLASSES,
  customerAnalyticsEventWhere,
  customerDreamcoinLedgerWhere,
  customerGenerationJobWhere,
  customerReferralWhere,
  customerSubscriptionWhere,
  customerUserWhere,
  operationalAnalyticsEventWhere,
  operationalGenerationJobWhere,
  operationalMediaAssetPlacementWhere,
} from "./metric-data-scope";

describe("legacy admin metric data scopes", () => {
  it("keeps business metrics inside the customer audience boundary", () => {
    expect(customerUserWhere({ createdAt: { gte: new Date(0) } })).toEqual({
      AND: [
        { dataClass: "customer" },
        { createdAt: { gte: new Date(0) } },
      ],
    });
    expect(customerGenerationJobWhere({ status: "completed" })).toEqual({
      AND: [
        { user: { is: { dataClass: "customer" } } },
        { status: "completed" },
      ],
    });
    expect(customerSubscriptionWhere({ status: "active" })).toEqual({
      AND: [
        { user: { is: { dataClass: "customer" } } },
        { status: "active" },
      ],
    });
    expect(customerDreamcoinLedgerWhere({ reason: "generation_spend" })).toEqual({
      AND: [
        { user: { is: { dataClass: "customer" } } },
        { reason: "generation_spend" },
      ],
    });
    expect(customerReferralWhere({ status: "completed" })).toEqual({
      AND: [
        { inviter: { is: { dataClass: "customer" } } },
        { status: "completed" },
      ],
    });
    expect(customerAnalyticsEventWhere({ name: "signup" })).toEqual({
      AND: [{ dataClass: "customer" }, { name: "signup" }],
    });
    expect(CUSTOMER_METRIC_DATA_SCOPE).toEqual({
      kind: "customer",
      includedDataClasses: ["customer"],
      excludedDataClasses: ["internal", "operational", "fixture", "audit"],
    });
  });

  it("keeps operational metrics while excluding fixture and audit traffic", () => {
    expect(OPERATIONAL_USER_DATA_CLASSES).toEqual(["customer", "internal"]);
    expect(OPERATIONAL_EVENT_DATA_CLASSES).toEqual([
      "customer",
      "internal",
      "operational",
    ]);
    expect(operationalGenerationJobWhere({ status: "failed" })).toEqual({
      AND: [
        {
          user: {
            is: { dataClass: { in: ["customer", "internal"] } },
          },
        },
        { status: "failed" },
      ],
    });
    expect(operationalAnalyticsEventWhere({ name: "placement_click" })).toEqual({
      AND: [
        {
          dataClass: {
            in: ["customer", "internal", "operational"],
          },
        },
        { name: "placement_click" },
      ],
    });
    expect(operationalMediaAssetPlacementWhere({ status: "published" })).toEqual({
      AND: [
        {
          createdBy: {
            is: { dataClass: { in: ["customer", "internal"] } },
          },
        },
        {
          mediaAsset: {
            is: {
              owner: {
                is: { dataClass: { in: ["customer", "internal"] } },
              },
            },
          },
        },
        { status: "published" },
      ],
    });
    expect(OPERATIONAL_METRIC_DATA_SCOPE).toEqual({
      kind: "operational",
      includedDataClasses: ["customer", "internal", "operational"],
      excludedDataClasses: ["fixture", "audit"],
    });
  });
});
