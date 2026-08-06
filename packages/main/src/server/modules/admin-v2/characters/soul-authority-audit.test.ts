import { describe, expect, it } from "vitest";
import { compileCharacterSoul } from "@idream/shared";
import { auditSoulSnapshots } from "./soul-authority-audit";

describe("Character Soul authority audit", () => {
  it("reports exact owners of missing or invalid pinned snapshots", () => {
    const compiled = compileCharacterSoul({
      name: "June",
      age: 28,
      gender: "female",
      relationshipArchetype: "neighbor",
      characterPromise: "A candid neighbor.",
      personality: "Direct.",
    });
    if (!compiled.ok) throw new Error("fixture compilation failed");
    const result = auditSoulSnapshots([
      { ownerType: "serving_release", ownerId: "character-1", contentVersionId: "v1" },
      { ownerType: "pinned_session", ownerId: "session-1", contentVersionId: "missing" },
    ], [{ id: "v1", personaSnapshot: compiled.snapshot }]);
    expect(result).toMatchObject({ referenced: 2, valid: 1, v1: 1, legacy: 0 });
    expect(result.invalid).toEqual([
      expect.objectContaining({ ownerId: "session-1", contentVersionId: "missing" }),
    ]);
  });
});
