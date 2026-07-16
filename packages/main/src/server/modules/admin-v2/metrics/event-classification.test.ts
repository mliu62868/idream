import { describe, expect, it } from "vitest";
import { classifyExistingCustomerMetricActor } from "./event-classification";

const activeCustomer = {
  id: "customer-1",
  email: "customer@real.example",
  role: "user",
  status: "active",
  deletedAt: null,
} as const;

describe("canonical metric actor classification", () => {
  it("uses the persisted data class as the primary authority", () => {
    expect(
      classifyExistingCustomerMetricActor({
        ...activeCustomer,
        dataClass: "internal",
      }),
    ).toMatchObject({
      dataClass: "internal",
      actor: { isInternal: true },
    });

    expect(
      classifyExistingCustomerMetricActor({
        ...activeCustomer,
        dataClass: "audit",
      }),
    ).toMatchObject({
      dataClass: "audit",
      actor: { isInternal: true },
    });
  });

  it("fails safe when a reserved fixture email is mislabeled as customer", () => {
    for (const email of [
      "browser@test.local",
      "integration@example.test",
      "legacy@example.com",
    ]) {
      expect(
        classifyExistingCustomerMetricActor({
          ...activeCustomer,
          email,
          dataClass: "customer",
        }),
      ).toMatchObject({
        dataClass: "fixture",
        actor: { isInternal: true },
      });
    }
  });
});
