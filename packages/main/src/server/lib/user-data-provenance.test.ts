import { describe, expect, it } from "vitest";
import {
  isReservedFixtureEmail,
  isReservedInternalEmail,
  registeredUserDataClass,
} from "./user-data-provenance";

describe("user data provenance", () => {
  it("classifies reserved test domains as fixtures", () => {
    expect(isReservedFixtureEmail("person@test.local")).toBe(true);
    expect(isReservedFixtureEmail("person@qa.example.test")).toBe(true);
    expect(isReservedFixtureEmail("person@example.com")).toBe(true);
    expect(registeredUserDataClass("person@example.test")).toBe("fixture");
  });

  it("keeps ordinary registrations in the customer class", () => {
    expect(isReservedFixtureEmail("person@customer.invalid")).toBe(false);
    expect(registeredUserDataClass("person@customer.invalid")).toBe("customer");
  });

  it("classifies reserved operator domains as internal", () => {
    expect(isReservedInternalEmail("operator@idream.local")).toBe(true);
    expect(isReservedInternalEmail("reviewer@admin.idream.internal")).toBe(true);
    expect(isReservedInternalEmail("customer@idream.example")).toBe(false);
    expect(registeredUserDataClass("operator@idream.local")).toBe("internal");
  });
});
