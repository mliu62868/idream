import { describe, expect, it } from "vitest";
import { ADMIN_V2_API_OPERATIONS } from "./api-manifest";
import {
  ADMIN_V2_PENDING_CONTRACTS,
  requireExecutableAdminV2Contract,
  resolveAdminV2Contract,
} from "./contract-registry";

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
  it("resolves every request and response ref in the 84-operation manifest", () => {
    for (const ref of manifestRefs()) {
      expect(resolveAdminV2Contract(ref), ref).not.toBeNull();
    }
  });

  it("automatically executes a positive and negative fixture for every bound contract", () => {
    const executed = new Set<string>();
    for (const ref of manifestRefs()) {
      const binding = resolveAdminV2Contract(ref);
      if (!binding || binding.kind === "pending" || executed.has(binding.fixtureKey)) continue;
      executed.add(binding.fixtureKey);

      expect(binding.schema.safeParse(binding.fixtures.valid).success, `${ref} positive`).toBe(true);
      expect(binding.schema.safeParse(binding.fixtures.invalid).success, `${ref} negative`).toBe(false);
    }
    expect(executed.size).toBe(89);
  });

  it("fails closed for every explicitly pending contract and reports an exact owner/reason", () => {
    const referenced = manifestBaseRefs();
    const pending = Object.entries(ADMIN_V2_PENDING_CONTRACTS);
    expect(pending).toHaveLength(28);

    for (const [ref, evidence] of pending) {
      expect(referenced.has(ref), `${ref} is stale`).toBe(true);
      expect(evidence.owner).toMatch(/^packages\//);
      expect(evidence.reason.length).toBeGreaterThanOrEqual(20);
      expect(() => requireExecutableAdminV2Contract(ref)).toThrow(/not executable/);
    }
    expect([...manifestBaseRefs()].filter((ref) => resolveAdminV2Contract(ref)?.kind === "pending").sort())
      .toEqual(Object.keys(ADMIN_V2_PENDING_CONTRACTS).sort());
  });
});
