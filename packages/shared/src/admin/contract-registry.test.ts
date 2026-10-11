import { describe, expect, it } from "vitest";
import { ADMIN_V2_API_OPERATIONS } from "./api-manifest";
import {
  requireExecutableAdminV2Contract,
  resolveAdminV2Contract,
} from "./contract-registry";
import { adminV2ContractFixtures } from "./testing/contract-fixtures";

function manifestRefs() {
  return [...new Set(ADMIN_V2_API_OPERATIONS.flatMap((operation) => [
    operation.contract.request,
    operation.contract.response,
  ]))].sort();
}

function manifestBaseRefs() {
  return new Set(manifestRefs().map((ref) => ref.split("+")[0] ?? ref));
}

describe("Admin v2 executable contract registry", () => {
  it("resolves every request and response ref in the current manifest", () => {
    for (const ref of manifestRefs()) {
      expect(resolveAdminV2Contract(ref), ref).not.toBeNull();
    }
  });

  it("automatically executes a positive and negative fixture for every bound contract", () => {
    const executed = new Set<string>();
    for (const ref of manifestRefs()) {
      const binding = resolveAdminV2Contract(ref);
      if (!binding || executed.has(binding.ref)) continue;
      executed.add(binding.ref);

      expect(binding.schema.safeParse(adminV2ContractFixtures(ref).valid).success, `${ref} positive`).toBe(true);
      expect(binding.schema.safeParse(adminV2ContractFixtures(ref).invalid).success, `${ref} negative`).toBe(false);
    }
    expect(executed.size).toBe(manifestBaseRefs().size);
  });

  it("rejects unknown refs without a pending escape hatch", () => {
    expect(resolveAdminV2Contract("missingContract")).toBeNull();
    expect(() => requireExecutableAdminV2Contract("missingContract")).toThrow();
    for (const ref of manifestRefs()) {
      expect(requireExecutableAdminV2Contract(ref).schema).toBeDefined();
    }
  });
});
