import { describe, expect, it } from "vitest";
import { requireAdminMutationOperation } from "./admin-mutation";

describe("Admin manifest-backed mutation execution", () => {
  it("resolves executable contracts and reliability metadata from one operation definition", () => {
    const definition = requireAdminMutationOperation(
      "PATCH /api/v2/admin/characters/:id/draft-image",
    );

    expect(definition.operation.mutation).toEqual({
      transport: "idempotency_key_and_if_match",
      commandType: "character.project.draft_image.select",
      executionMode: "atomic",
    });
    expect(definition.request.fixtureKey).toBe(
      "characterDraftImageSelectionRequestSchema",
    );
    expect(definition.request.requirements).toEqual([
      "idempotency-key",
      "if-match",
    ]);
    expect(definition.response.fixtureKey).toBe(
      "characterDraftImageSelectionResultSchema",
    );
  });

  it("fails closed for an unknown or read-only operation", () => {
    expect(() => requireAdminMutationOperation(
      "PATCH /api/v2/admin/characters/:id/unknown",
    )).toThrow("Unknown Admin mutation operation");
    expect(() => requireAdminMutationOperation(
      "GET /api/v2/admin/characters/:id",
    )).toThrow("not a mutation");
  });
});
