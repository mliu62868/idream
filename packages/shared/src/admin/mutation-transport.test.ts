import { describe, expect, it } from "vitest";

import { ADMIN_V2_API_OPERATIONS, type AdminV2OperationId } from "./api-manifest";
import {
  ADMIN_V2_MUTATION_TRANSPORT,
  ADMIN_V2_PENDING_MUTATION_TRANSPORT,
  type AdminV2MutationTransport,
} from "./mutation-transport";

const mutationOperations = ADMIN_V2_API_OPERATIONS.filter(
  (operation) => operation.method !== "GET",
);
const transportRegistry: Readonly<Partial<Record<AdminV2OperationId, AdminV2MutationTransport>>> =
  ADMIN_V2_MUTATION_TRANSPORT;

describe("Admin v2 mutation transport invariant", () => {
  it("classifies every mutation exactly once and no reads", () => {
    expect(Object.keys(ADMIN_V2_MUTATION_TRANSPORT).sort()).toEqual(
      mutationOperations.map((operation) => operation.id).sort(),
    );

    for (const operation of ADMIN_V2_API_OPERATIONS) {
      expect(operation.id in ADMIN_V2_MUTATION_TRANSPORT).toBe(
        operation.method !== "GET",
      );
    }
  });

  it("binds completed transports to the public request contract", () => {
    for (const operation of mutationOperations) {
      const transport = transportRegistry[operation.id];
      expect(transport).toBeDefined();
      if (!transport) continue;

      if (transport.status !== "implemented") continue;

      if (transport.kind === "idempotency_key") {
        expect(operation.contract.request).toMatch(/\+idempotency-key$/);
        expect(transport.replay).toBe("same_result");
        expect(transport.collision).toBe("reject_payload_mismatch");
        expect(transport.failure).toBe("retryable_without_double_apply");
      } else {
        expect(operation.contract.request).toMatch(/(?:\+if-match|^if-match$)/);
        expect(transport.staleWrite).toBe("reject");
      }
    }
  });

  it("fails closed with an exact actionable pending inventory", () => {
    const pending = Object.entries(ADMIN_V2_MUTATION_TRANSPORT)
      .filter(([, transport]) => transport.status === "pending")
      .map(([operationId]) => operationId)
      .sort();

    expect(Object.keys(ADMIN_V2_PENDING_MUTATION_TRANSPORT).sort()).toEqual(
      pending,
    );
    expect(pending).toHaveLength(9);

    for (const item of Object.values(ADMIN_V2_PENDING_MUTATION_TRANSPORT)) {
      expect(item.owner.length).toBeGreaterThan(2);
      expect(item.reason.length).toBeGreaterThan(12);
      expect(item.requiredTransport.length).toBeGreaterThan(5);
    }
  });
});
